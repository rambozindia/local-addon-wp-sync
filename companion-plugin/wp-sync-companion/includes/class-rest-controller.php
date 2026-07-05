<?php
/**
 * REST API Controller for WP Sync Companion.
 *
 * Namespace: wp-sync/v1
 * All endpoints require administrator authentication (Application Passwords).
 */

defined('ABSPATH') || exit;

class WPLSync_REST_Controller {

    const NAMESPACE = 'wp-sync/v1';

    /**
     * Register all REST API routes.
     */
    public function register_routes() {
        // GET /status - Health check & plugin version
        register_rest_route(self::NAMESPACE, '/status', [
            'methods'             => 'GET',
            'callback'            => $this->wrap([$this, 'get_status']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // GET /site-info - Detailed WordPress site information
        register_rest_route(self::NAMESPACE, '/site-info', [
            'methods'             => 'GET',
            'callback'            => $this->wrap([$this, 'get_site_info']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /export/database - Trigger database export
        register_rest_route(self::NAMESPACE, '/export/database', [
            'methods'             => 'POST',
            'callback'            => $this->wrap([$this, 'export_database']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /export/files - Trigger file archive export
        register_rest_route(self::NAMESPACE, '/export/files', [
            'methods'             => 'POST',
            'callback'            => $this->wrap([$this, 'export_files']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // GET /download/{token} - Download exported file
        register_rest_route(self::NAMESPACE, '/download/(?P<token>[a-f0-9]+)', [
            'methods'             => 'GET',
            'callback'            => $this->wrap([$this, 'download_file']),
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
            'callback'            => $this->wrap([$this, 'import_database']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /import/database/chunk - Upload a database chunk (for large files)
        register_rest_route(self::NAMESPACE, '/import/database/chunk', [
            'methods'             => 'POST',
            'callback'            => $this->wrap([$this, 'import_database_chunk']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // POST /import/files - Upload & extract file archive
        register_rest_route(self::NAMESPACE, '/import/files', [
            'methods'             => 'POST',
            'callback'            => $this->wrap([$this, 'import_files']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // DELETE /cleanup/{token} - Remove temporary export files
        register_rest_route(self::NAMESPACE, '/cleanup/(?P<token>[a-f0-9]+)', [
            'methods'             => 'DELETE',
            'callback'            => $this->wrap([$this, 'cleanup']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);

        // GET /log - Tail of the plugin's own log file (for remote debugging)
        register_rest_route(self::NAMESPACE, '/log', [
            'methods'             => 'GET',
            'callback'            => $this->wrap([$this, 'get_log']),
            'permission_callback' => [$this, 'check_admin_permission'],
        ]);
    }

    /**
     * Wrap an endpoint callback with logging and error trapping.
     *
     * Uncaught Throwables (including most PHP fatals) become structured JSON
     * 500 responses — so the add-on can show the real error instead of a
     * generic "Request failed with status code 500". Fatals that can't be
     * caught (OOM, max_execution_time) are captured by a shutdown handler
     * and end up in the log file.
     */
    private function wrap(callable $callback): callable {
        return function (WP_REST_Request $request) use ($callback) {
            $route = $request->get_method() . ' ' . $request->get_route();

            register_shutdown_function(function () use ($route) {
                $err = error_get_last();
                if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
                    wplsync_log('fatal', $route . ' — ' . $err['message'] . ' in ' . $err['file'] . ':' . $err['line']);
                }
            });

            wplsync_log('info', $route);

            try {
                $response = call_user_func($callback, $request);
                if ($response instanceof WP_REST_Response && $response->get_status() >= 400) {
                    wplsync_log('error', $route . ' -> HTTP ' . $response->get_status() . ' ' . wp_json_encode($response->get_data()));
                }
                return $response;
            } catch (Throwable $e) {
                $detail = get_class($e) . ': ' . $e->getMessage() . ' in ' . basename($e->getFile()) . ':' . $e->getLine();
                wplsync_log('error', $route . ' threw ' . $detail);
                return new WP_REST_Response(['error' => $detail], 500);
            }
        };
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
            'pluginVersion'  => WPLSYNC_VERSION,
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
     *
     * With `stepped=1`, runs one bounded slice of work per request (pass back
     * the returned token until `complete` is true) so responses stay under
     * proxy timeouts such as Cloudflare's ~100s limit. Without it, the export
     * runs to completion in a single request (legacy behavior).
     */
    public function export_database(WP_REST_Request $request): WP_REST_Response {
        $handler = new WPLSync_Database_Handler();

        if ($request->get_param('stepped')) {
            $token = $this->sanitize_token($request->get_param('token'));
            if (is_wp_error($token)) {
                return new WP_REST_Response(['error' => $token->get_error_message()], 400);
            }
            $result = $handler->export_step($token);
        } else {
            $result = $handler->export();
        }

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * POST /export/files
     *
     * Supports the same `stepped` / `token` protocol as /export/database.
     * Stepped exports produce multiple ZIP parts, downloadable via
     * GET /download/{token}?part=N.
     */
    public function export_files(WP_REST_Request $request): WP_REST_Response {
        $scope   = $request->get_param('scope') ?: 'full';
        $handler = new WPLSync_File_Handler();

        if ($request->get_param('stepped')) {
            $token = $this->sanitize_token($request->get_param('token'));
            if (is_wp_error($token)) {
                return new WP_REST_Response(['error' => $token->get_error_message()], 400);
            }
            $result = $handler->export_step($scope, $token);
        } else {
            $result = $handler->export($scope);
        }

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
        $manifest_file = WPLSYNC_TEMP_DIR . '/' . $token . '.json';

        if (!file_exists($manifest_file)) {
            return new WP_REST_Response(['error' => 'Invalid or expired token'], 404);
        }

        $manifest = json_decode(file_get_contents($manifest_file), true);

        if (!empty($manifest['parts'])) {
            // Multi-part file export: ?part=N selects the archive part (default 0)
            $part_index = (int) ($request->get_param('part') ?? 0);
            $part = $manifest['parts'][$part_index] ?? null;
            if (!$part) {
                return new WP_REST_Response(['error' => 'Invalid part index: ' . $part_index], 404);
            }
            $file_path = $part['path'];
        } else {
            $file_path = $manifest['path'] ?? '';
        }

        if (!file_exists($file_path)) {
            return new WP_REST_Response(['error' => 'Export file not found'], 404);
        }

        // Stream the file in chunks. readfile() exhausts memory when output
        // buffering is active: the whole file accumulates in the buffer
        // instead of being flushed to the client.
        @set_time_limit(0);
        @ini_set('zlib.output_compression', 'Off');
        while (ob_get_level() > 0) {
            ob_end_clean();
        }

        wplsync_log('info', 'Streaming ' . filesize($file_path) . ' bytes: ' . basename($file_path));

        header('Content-Type: application/octet-stream');
        header('Content-Disposition: attachment; filename="' . basename($file_path) . '"');
        header('Content-Length: ' . filesize($file_path));
        header('Cache-Control: no-cache');

        $handle = fopen($file_path, 'rb');
        if ($handle) {
            while (!feof($handle)) {
                echo fread($handle, 1048576); // 1 MB per chunk
                flush();
            }
            fclose($handle);
        }
        exit;
    }

    /**
     * POST /import/database
     */
    public function import_database(WP_REST_Request $request): WP_REST_Response {
        $files = $request->get_file_params();

        if (empty($files['database']) || !isset($files['database']['tmp_name'])) {
            // Diagnose the PHP upload error
            $err_code = $files['database']['error'] ?? UPLOAD_ERR_NO_FILE;
            $err_map  = [
                UPLOAD_ERR_INI_SIZE   => 'File exceeds upload_max_filesize (' . ini_get('upload_max_filesize') . '). Increase it in php.ini.',
                UPLOAD_ERR_FORM_SIZE  => 'File exceeds post_max_size (' . ini_get('post_max_size') . '). Increase it in php.ini.',
                UPLOAD_ERR_PARTIAL    => 'File was only partially uploaded.',
                UPLOAD_ERR_NO_FILE    => 'No database file received. Check post_max_size (' . ini_get('post_max_size') . ') and upload_max_filesize (' . ini_get('upload_max_filesize') . ').',
                UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary upload folder on server.',
                UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk on server.',
            ];
            $msg = $err_map[$err_code] ?? 'Upload error code: ' . $err_code;
            return new WP_REST_Response(['error' => $msg], 400);
        }

        $handler = new WPLSync_Database_Handler();
        $result  = $handler->import($files['database']['tmp_name']);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * POST /import/database/chunk
     *
     * Receives one chunk of a database SQL file. Chunks are identified by an
     * upload_id and written sequentially. When the final chunk arrives
     * (chunk_index + 1 === total_chunks), the assembled file is imported.
     *
     * Body params (multipart):
     *   upload_id    - string, unique identifier for this upload session
     *   chunk_index  - int, 0-based index of this chunk
     *   total_chunks - int, total number of chunks
     *   chunk        - file, the raw chunk data
     */
    public function import_database_chunk(WP_REST_Request $request): WP_REST_Response {
        $upload_id    = sanitize_key($request->get_param('upload_id'));
        $chunk_index  = (int) $request->get_param('chunk_index');
        $total_chunks = (int) $request->get_param('total_chunks');
        $files        = $request->get_file_params();

        if (empty($upload_id) || $total_chunks < 1) {
            return new WP_REST_Response(['error' => 'Missing upload_id or total_chunks'], 400);
        }

        if (!isset($files['chunk']) || empty($files['chunk']['tmp_name'])) {
            $err_code = $files['chunk']['error'] ?? UPLOAD_ERR_NO_FILE;
            $err_map  = [
                UPLOAD_ERR_INI_SIZE   => 'Chunk exceeds upload_max_filesize (' . ini_get('upload_max_filesize') . ').',
                UPLOAD_ERR_FORM_SIZE  => 'Chunk exceeds post_max_size (' . ini_get('post_max_size') . ').',
                UPLOAD_ERR_PARTIAL    => 'Chunk was only partially uploaded.',
                UPLOAD_ERR_NO_FILE    => 'No chunk data received.',
                UPLOAD_ERR_NO_TMP_DIR => 'Missing temporary upload folder.',
                UPLOAD_ERR_CANT_WRITE => 'Failed to write chunk to disk.',
            ];
            return new WP_REST_Response(['error' => $err_map[$err_code] ?? 'Upload error: ' . $err_code], 400);
        }

        wplsync_ensure_temp_dir();

        $assembled_path = WPLSYNC_TEMP_DIR . '/chunk-' . $upload_id . '.sql';

        // Append this chunk to the assembled file
        $chunk_data = file_get_contents($files['chunk']['tmp_name']);
        if ($chunk_data === false) {
            return new WP_REST_Response(['error' => 'Failed to read chunk data'], 500);
        }

        $mode = ($chunk_index === 0) ? 'w' : 'a';
        $handle = fopen($assembled_path, $mode);
        if (!$handle) {
            return new WP_REST_Response(['error' => 'Cannot write assembled SQL file'], 500);
        }
        fwrite($handle, $chunk_data);
        fclose($handle);

        // If this is the last chunk, import the assembled file
        if ($chunk_index + 1 >= $total_chunks) {
            $handler = new WPLSync_Database_Handler();
            $result  = $handler->import($assembled_path);
            @unlink($assembled_path);

            if (is_wp_error($result)) {
                return new WP_REST_Response(['error' => $result->get_error_message()], 500);
            }

            return new WP_REST_Response(array_merge($result, ['assembled' => true]));
        }

        return new WP_REST_Response([
            'received'     => $chunk_index + 1,
            'total_chunks' => $total_chunks,
            'assembled'    => false,
        ]);
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

        $handler = new WPLSync_File_Handler();
        $result  = $handler->import($files['files']['tmp_name'], $scope);

        if (is_wp_error($result)) {
            return new WP_REST_Response([
                'error' => $result->get_error_message(),
            ], 500);
        }

        return new WP_REST_Response($result);
    }

    /**
     * GET /log — last 200 lines of the plugin log for remote debugging.
     */
    public function get_log(WP_REST_Request $request): WP_REST_Response {
        $file = wplsync_log_path();
        if (!file_exists($file)) {
            return new WP_REST_Response(['log' => '']);
        }
        $lines = file($file);
        $tail  = is_array($lines) ? array_slice($lines, -200) : [];
        return new WP_REST_Response(['log' => implode('', $tail)]);
    }

    /**
     * DELETE /cleanup/{token}
     */
    public function cleanup(WP_REST_Request $request): WP_REST_Response {
        $token = $request->get_param('token');
        $manifest_file = WPLSYNC_TEMP_DIR . '/' . $token . '.json';

        if (file_exists($manifest_file)) {
            $manifest = json_decode(file_get_contents($manifest_file), true);
            if (!empty($manifest['parts'])) {
                foreach ($manifest['parts'] as $part) {
                    if (!empty($part['path']) && file_exists($part['path'])) {
                        unlink($part['path']);
                    }
                }
            }
            if (!empty($manifest['path']) && file_exists($manifest['path'])) {
                unlink($manifest['path']);
            }
            unlink($manifest_file);
        }

        // Remove any leftover stepped-export state (aborted exports)
        foreach (['.state.json', '.entries.json'] as $suffix) {
            $stray = WPLSYNC_TEMP_DIR . '/' . $token . $suffix;
            if (file_exists($stray)) {
                unlink($stray);
            }
        }

        return new WP_REST_Response(['cleaned' => true]);
    }

    // ═══════════════════════════════════════════
    // Helpers
    // ═══════════════════════════════════════════

    /**
     * Validate an export token from a request body.
     * Tokens are embedded in temp-dir file paths, so reject anything
     * that isn't plain hex.
     *
     * @return string|null|WP_Error Null when no token was provided.
     */
    private function sanitize_token($token) {
        if (empty($token)) {
            return null;
        }
        if (!is_string($token) || !preg_match('/^[a-f0-9]{32,64}$/', $token)) {
            return new WP_Error('invalid_token', 'Malformed export token');
        }
        return $token;
    }

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
