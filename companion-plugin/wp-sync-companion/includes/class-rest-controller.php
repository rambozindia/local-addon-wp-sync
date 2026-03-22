<?php
/**
 * REST API Controller for WP Sync Companion.
 *
 * Namespace: wp-sync/v1
 * All endpoints require administrator authentication (Application Passwords).
 */

defined('ABSPATH') || exit;

class WP_Sync_REST_Controller {

    const NAMESPACE = 'wp-sync/v1';

    /**
     * Register all REST API routes.
     */
    public function register_routes() {
        // GET /status - Health check & plugin version
        register_rest_route(self::NAMESPACE, '/status', [
            'methods'             => 'GET',
            'callback'            => [$this, 'get_status'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // GET /site-info - Detailed WordPress site information
        register_rest_route(self::NAMESPACE, '/site-info', [
            'methods'             => 'GET',
            'callback'            => [$this, 'get_site_info'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /export/database - Trigger database export
        register_rest_route(self::NAMESPACE, '/export/database', [
            'methods'             => 'POST',
            'callback'            => [$this, 'export_database'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /export/files - Trigger file archive export
        register_rest_route(self::NAMESPACE, '/export/files', [
            'methods'             => 'POST',
            'callback'            => [$this, 'export_files'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // GET /download/{token} - Download exported file
        register_rest_route(self::NAMESPACE, '/download/(?P<token>[a-f0-9]+)', [
            'methods'             => 'GET',
            'callback'            => [$this, 'download_file'],
            'permission_callback' => [$this, 'check_admin_permission'],
            'args'                => [
                'token' => [
                    'required'          => true,
                    'validate_callback' => function ($param) {
                        return preg_match('/^[a-f0-9]{32,64}$/', $param);
                    },
                ],
            ],
        ]);

        // POST /import/database - Upload & import database
        register_rest_route(self::NAMESPACE, '/import/database', [
            'methods'             => 'POST',
            'callback'            => [$this, 'import_database'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /import/files - Upload & extract file archive
        register_rest_route(self::NAMESPACE, '/import/files', [
            'methods'             => 'POST',
            'callback'            => [$this, 'import_files'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // DELETE /cleanup/{token} - Remove temporary export files
        register_rest_route(self::NAMESPACE, '/cleanup/(?P<token>[a-f0-9]+)', [
            'methods'             => 'DELETE',
            'callback'            => [$this, 'cleanup'],
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);
    }

    /**
     * Permission check: require authenticated administrator.
     */
    public function check_admin_permission(WP_REST_Request $request): bool {
        return current_user_can('manage_options');
    }

    // ═══════════════════════════════════════════
    // Endpoint Callbacks
    // ═══════════════════════════════════════════

    /**
     * GET /status
     */
    public function get_status(): WP_REST_Response {
        return new WP_REST_Response([
            'connected'      => true,
            'pluginVersion'  => WP_SYNC_VERSION,
            'wpVersion'      => get_bloginfo('version'),
            'phpVersion'     => phpversion(),
        ]);
    }

    /**
     * GET /site-info
     */
    public function get_site_info(): WP_REST_Response {
        global $wpdb;

        $theme   = wp_get_theme();
        $plugins = get_plugins();
        $active  = get_option('active_plugins', []);

        $plugin_list = [];
        foreach ($plugins as $file => $data) {
            $plugin_list[] = [
                'name'    => $data['Name'],
                'slug'    => dirname($file) ?: basename($file, '.php'),
                'version' => $data['Version'],
                'active'  => in_array($file, $active, true),
            ];
        }

        // Disk usage (approximate)
        $disk_usage = $this->calculate_disk_usage();

        return new WP_REST_Response([
            'name'        => get_bloginfo('name'),
            'url'         => home_url(),
            'wpVersion'   => get_bloginfo('version'),
            'phpVersion'  => phpversion(),
            'activeTheme' => $theme->get('Name'),
            'plugins'     => $plugin_list,
            'dbPrefix'    => $wpdb->prefix,
            'isMultisite' => is_multisite(),
            'diskUsage'   => $disk_usage,
        ]);
    }

    /**
     * POST /export/database
     */
    public function export_database(WP_REST_Request $request): WP_REST_Response {
        $handler  = new WP_Sync_Database_Handler();
        $result   = $handler->export();

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * POST /export/files
     */
    public function export_files(WP_REST_Request $request): WP_REST_Response {
        $scope   = $request->get_param('scope') ?: 'full';
        $handler = new WP_Sync_File_Handler();
        $result  = $handler->export($scope);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * GET /download/{token}
     */
    public function download_file(WP_REST_Request $request) {
        $token = $request->get_param('token');
        $manifest_file = WP_SYNC_TEMP_DIR . '/' . $token . '.json';

        if (!file_exists($manifest_file)) {
            return new WP_REST_Response(['error' => 'Invalid or expired token'], 404);
        }

        $manifest = json_decode(file_get_contents($manifest_file), true);
        $file_path = $manifest['path'] ?? '';

        if (!file_exists($file_path)) {
            return new WP_REST_Response(['error' => 'Export file not found'], 404);
        }

        // Stream the file
        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($file_path) . '"');
        header('Content-Length: ' . filesize($file_path));
        header('Cache-Control: no-cache');

        readfile($file_path);
        exit;
    }

    /**
     * POST /import/database
     */
    public function import_database(WP_REST_Request $request): WP_REST_Response {
        $files = $request->get_file_params();

        if (empty($files['database'])) {
            return new WP_REST_Response(['error' => 'No database file uploaded'], 400);
        }

        $handler = new WP_Sync_Database_Handler();
        $result  = $handler->import($files['database']['tmp_name']);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * POST /import/files
     */
    public function import_files(WP_REST_Request $request): WP_REST_Response {
        $files = $request->get_file_params();
        $scope = $request->get_param('scope') ?: 'full';

        if (empty($files['files'])) {
            return new WP_REST_Response(['error' => 'No file archive uploaded'], 400);
        }

        $handler = new WP_Sync_File_Handler();
        $result  = $handler->import($files['files']['tmp_name'], $scope);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * DELETE /cleanup/{token}
     */
    public function cleanup(WP_REST_Request $request): WP_REST_Response {
        $token = $request->get_param('token');
        $manifest_file = WP_SYNC_TEMP_DIR . '/' . $token . '.json';

        if (file_exists($manifest_file)) {
            $manifest = json_decode(file_get_contents($manifest_file), true);
            if (!empty($manifest['path']) && file_exists($manifest['path'])) {
                unlink($manifest['path']);
            }
            unlink($manifest_file);
        }

        return new WP_REST_Response(['cleaned' => true]);
    }

    // ═══════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════

    private function calculate_disk_usage(): array {
        $uploads_dir = wp_upload_dir()['basedir'];
        $themes_dir  = get_theme_root();
        $plugins_dir = WP_PLUGIN_DIR;

        return [
            'uploads' => $this->format_size($this->dir_size($uploads_dir)),
            'themes'  => $this->format_size($this->dir_size($themes_dir)),
            'plugins' => $this->format_size($this->dir_size($plugins_dir)),
            'total'   => $this->format_size(
                $this->dir_size($uploads_dir) +
                $this->dir_size($themes_dir) +
                $this->dir_size($plugins_dir)
            ),
        ];
    }

    private function dir_size(string $dir): int {
        $size = 0;
        if (!is_dir($dir)) return 0;

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );

        foreach ($iterator as $file) {
            if ($file->isFile()) {
                $size += $file->getSize();
            }
        }

        return $size;
    }

    private function format_size(int $bytes): string {
        $units = ['B', 'KB', 'MB', 'GB'];
        $i = 0;
        while ($bytes >= 1024 && $i < count($units) - 1) {
            $bytes /= 1024;
            $i++;
        }
        return round($bytes, 1) . ' ' . $units[$i];
    }
}
