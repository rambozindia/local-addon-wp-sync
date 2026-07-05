<?php
/**
 * File export/import handler.
 *
 * Creates ZIP archives of WordPress files for download,
 * and extracts uploaded archives into the WordPress installation.
 */

defined('ABSPATH') || exit;

class WPLSync_File_Handler {

    /**
     * Directories to always exclude from exports.
     */
    const EXCLUDED_DIRS = [
        '.git',
        '.svn',
        'node_modules',
        '.DS_Store',
        'wp-sync-temp',
    ];

    /** Max seconds of add-work per export step request (zip compression on close adds more). */
    const TIME_BUDGET = 12;

    /** Max uncompressed source bytes per archive part. */
    const PART_MAX_BYTES = 104857600; // 100 MB

    /** Max number of files per archive part. */
    const PART_MAX_FILES = 4000;

    /**
     * Export WordPress files in a single request (loops export_step).
     * Kept for clients that don't use stepped exports.
     *
     * @param string $scope One of: 'full', 'wp-content', 'themes', 'plugins', 'uploads'
     * @return array|WP_Error Token and parts info on success.
     */
    public function export(string $scope = 'full') {
        $result = $this->export_step($scope, null);
        while (!is_wp_error($result) && empty($result['complete'])) {
            $result = $this->export_step($scope, $result['token']);
        }
        return $result;
    }

    /**
     * Run one bounded step of a file export. Each step produces one ZIP part
     * (≤ PART_MAX_BYTES of source data), so a single request never runs long
     * enough to trip proxy timeouts like Cloudflare's 100s limit.
     *
     * @param string      $scope Export scope (only used when starting a new export).
     * @param string|null $token Token from a previous step, or null to start.
     * @return array|WP_Error {token, complete, progress?} — plus parts/size/files when complete.
     */
    public function export_step(string $scope, ?string $token) {
        if (!class_exists('ZipArchive')) {
            return new WP_Error('zip_missing', 'PHP ZipArchive extension is required but not installed.');
        }

        wplsync_ensure_temp_dir();

        if (empty($token)) {
            $source_dir = $this->get_source_directory($scope);
            if (is_wp_error($source_dir)) {
                return $source_dir;
            }

            $token   = bin2hex(random_bytes(16));
            $entries = [];
            $this->collect_entries($source_dir, '', $entries);
            file_put_contents($this->entries_path($token), json_encode($entries));

            $state = [
                'scope'       => $scope,
                'source'      => $source_dir,
                'position'    => 0,
                'files_added' => 0,
                'parts'       => [],
            ];
            wplsync_log('info', 'File export started: scope ' . $scope . ', ' . count($entries) . ' entries, token ' . $token);
        } else {
            $state = $this->load_state($token);
            if ($state === null) {
                return new WP_Error('invalid_token', 'Unknown or expired export token');
            }
        }

        $entries = json_decode((string) file_get_contents($this->entries_path($token)), true);
        if (!is_array($entries)) {
            return new WP_Error('export_failed', 'Export file list is missing or corrupted.');
        }
        $total = count($entries);

        $part_index    = count($state['parts']);
        $part_filename = sprintf('files-export-%s-%s-part%03d.zip', $state['scope'], $token, $part_index);
        $part_path     = WPLSYNC_TEMP_DIR . '/' . $part_filename;

        $zip    = new ZipArchive();
        $result = $zip->open($part_path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
        if ($result !== true) {
            return new WP_Error('zip_failed', 'Failed to create ZIP archive part. Error code: ' . $result);
        }

        $start      = microtime(true);
        $part_bytes = 0;
        $part_files = 0;

        while ($state['position'] < $total) {
            $entry = $entries[$state['position']];

            if ($entry[0] === 'd') {
                $zip->addEmptyDir($entry[1]);
            } elseif (is_readable($entry[1])) {
                $zip->addFile($entry[1], $entry[2]);
                $part_bytes += $entry[3];
                $part_files++;
            }

            $state['position']++;

            if ($part_bytes >= self::PART_MAX_BYTES ||
                $part_files >= self::PART_MAX_FILES ||
                (microtime(true) - $start) > self::TIME_BUDGET) {
                break;
            }
        }

        $complete = $state['position'] >= $total;

        if ($complete) {
            // Add metadata manifest to the final part
            $manifest = json_encode([
                'scope'      => $state['scope'],
                'source'     => $state['source'],
                'site_url'   => home_url(),
                'wp_version' => get_bloginfo('version'),
                'created'    => gmdate('Y-m-d H:i:s'),
                'files'      => $state['files_added'] + $part_files,
                'parts'      => $part_index + 1,
            ], JSON_PRETTY_PRINT);
            $zip->addFromString('.wp-sync-manifest.json', $manifest);
        }

        // close() performs the actual reads + compression for this part
        $zip->close();

        $state['parts'][] = [
            'filename' => $part_filename,
            'path'     => $part_path,
            'size'     => filesize($part_path),
        ];
        $state['files_added'] += $part_files;
        wplsync_log('info', sprintf(
            'File export part %d written: %s files, %s bytes (position %d/%d)',
            $part_index, $part_files, filesize($part_path), $state['position'], $total
        ));

        if (!$complete) {
            $this->save_state($token, $state);
            return [
                'token'    => $token,
                'complete' => false,
                'progress' => [
                    'files_done'  => $state['files_added'],
                    'entries_done'  => $state['position'],
                    'entries_total' => $total,
                ],
            ];
        }

        @unlink($this->entries_path($token));
        @unlink($this->state_path($token));

        // Save download manifest covering all parts
        $download_manifest = [
            'type'    => 'files',
            'scope'   => $state['scope'],
            'created' => time(),
            'parts'   => $state['parts'],
        ];
        file_put_contents(WPLSYNC_TEMP_DIR . '/' . $token . '.json', json_encode($download_manifest));

        $public_parts = array_map(function ($p) {
            return ['filename' => $p['filename'], 'size' => $p['size']];
        }, $state['parts']);

        return [
            'token'    => $token,
            'complete' => true,
            'size'     => array_sum(array_column($state['parts'], 'size')),
            'filename' => $state['parts'][0]['filename'],
            'files'    => $state['files_added'],
            'parts'    => $public_parts,
        ];
    }

    // ─── Step state persistence ───

    private function state_path(string $token): string {
        return WPLSYNC_TEMP_DIR . '/' . $token . '.state.json';
    }

    private function entries_path(string $token): string {
        return WPLSYNC_TEMP_DIR . '/' . $token . '.entries.json';
    }

    private function load_state(string $token): ?array {
        $file = $this->state_path($token);
        if (!file_exists($file)) return null;
        $state = json_decode(file_get_contents($file), true);
        return is_array($state) ? $state : null;
    }

    private function save_state(string $token, array $state): void {
        file_put_contents($this->state_path($token), json_encode($state));
    }

    /**
     * Import a ZIP archive into the WordPress installation.
     *
     * @param string $zip_file  Path to the uploaded ZIP file.
     * @param string $scope     Target scope.
     * @return array|WP_Error   Import result.
     */
    public function import(string $zip_file, string $scope = 'full') {
        if (!class_exists('ZipArchive')) {
            return new WP_Error('zip_missing', 'PHP ZipArchive extension is required.');
        }

        if (!file_exists($zip_file)) {
            return new WP_Error('import_failed', 'ZIP file not found.');
        }

        $target_dir = $this->get_source_directory($scope);
        if (is_wp_error($target_dir)) {
            return $target_dir;
        }

        try {
            $zip = new ZipArchive();
            $result = $zip->open($zip_file);

            if ($result !== true) {
                return new WP_Error('zip_failed', 'Failed to open ZIP archive.');
            }

            $files_count = $zip->numFiles;

            // Validate archive before extracting
            $validation = $this->validate_archive($zip, $scope);
            if (is_wp_error($validation)) {
                $zip->close();
                return $validation;
            }

            // Create backup of critical files before overwriting
            $this->backup_wp_config($target_dir);

            // Extract files
            $zip->extractTo($target_dir);
            $zip->close();

            // Restore wp-config.php if this is a full import
            // (we never want to overwrite the local wp-config.php)
            $this->restore_wp_config($target_dir);

            // Remove the sync manifest from the extracted files
            $manifest_path = $target_dir . '/.wp-sync-manifest.json';
            if (file_exists($manifest_path)) {
                unlink($manifest_path);
            }

            // Fix file permissions
            $this->fix_permissions($target_dir);

            return [
                'success'    => true,
                'filesCount' => $files_count,
                'target'     => $target_dir,
            ];

        } catch (Exception $e) {
            return new WP_Error('import_failed', $e->getMessage());
        }
    }

    /**
     * Determine the source/target directory based on scope.
     */
    private function get_source_directory(string $scope): string {
        switch ($scope) {
            case 'full':
                return ABSPATH;

            case 'wp-content':
                return WP_CONTENT_DIR;

            case 'themes':
                return get_theme_root();

            case 'plugins':
                return WP_PLUGIN_DIR;

            case 'uploads':
                $upload_dir = wp_upload_dir();
                return $upload_dir['basedir'];

            default:
                return new WP_Error('invalid_scope', 'Invalid export scope: ' . $scope);
        }
    }

    /**
     * Recursively collect export entries for a directory.
     * Each entry is ['d', zip_path] for directories or
     * ['f', full_path, zip_path, size] for files.
     */
    private function collect_entries(string $dir, string $prefix, array &$entries): void {
        $dir = rtrim($dir, '/\\');

        if (!is_dir($dir)) return;

        $iterator = new DirectoryIterator($dir);

        foreach ($iterator as $item) {
            if ($item->isDot()) continue;

            $filename  = $item->getFilename();
            $full_path = $item->getPathname();
            $zip_path  = $prefix ? $prefix . '/' . $filename : $filename;

            // Skip excluded directories
            if ($item->isDir() && in_array($filename, self::EXCLUDED_DIRS, true)) {
                continue;
            }

            // Skip our own temp directory
            if ($full_path === WPLSYNC_TEMP_DIR) {
                continue;
            }

            // Skip wp-config.php in full exports (will be handled separately)
            if ($filename === 'wp-config.php' && empty($prefix)) {
                continue;
            }

            if ($item->isDir()) {
                $entries[] = ['d', $zip_path];
                $this->collect_entries($full_path, $zip_path, $entries);
            } elseif ($item->isFile() && $item->isReadable()) {
                // Skip very large files (> 256MB) to prevent memory issues
                if ($item->getSize() > 268435456) {
                    continue;
                }
                $entries[] = ['f', $full_path, $zip_path, $item->getSize()];
            }
        }
    }

    /**
     * Validate the ZIP archive before extraction.
     */
    private function validate_archive(ZipArchive $zip, string $scope): bool {
        // Check for path traversal attempts
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $name = $zip->getNameIndex($i);
            if (strpos($name, '..') !== false || strpos($name, '~') === 0) {
                return new WP_Error(
                    'security_error',
                    'Archive contains potentially dangerous file paths: ' . $name
                );
            }
        }

        return true;
    }

    /**
     * Backup wp-config.php before a full import.
     */
    private function backup_wp_config(string $dir): void {
        $config = $dir . '/wp-config.php';
        $backup = WPLSYNC_TEMP_DIR . '/wp-config-backup-' . time() . '.php';

        if (file_exists($config)) {
            copy($config, $backup);
        }
    }

    /**
     * Restore wp-config.php after a full import.
     */
    private function restore_wp_config(string $dir): void {
        // Find the most recent backup
        $backups = glob(WPLSYNC_TEMP_DIR . '/wp-config-backup-*.php');
        if (empty($backups)) return;

        // Sort by modification time (newest first)
        usort($backups, function ($a, $b) {
            return filemtime($b) - filemtime($a);
        });

        $latest_backup = $backups[0];
        $config = $dir . '/wp-config.php';

        if (file_exists($latest_backup)) {
            copy($latest_backup, $config);
            // Clean up old backups
            foreach ($backups as $backup) {
                unlink($backup);
            }
        }
    }

    /**
     * Fix file permissions after extraction.
     */
    private function fix_permissions(string $dir): void {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::SELF_FIRST
        );

        foreach ($iterator as $item) {
            if ($item->isDir()) {
                @chmod($item->getPathname(), 0755);
            } elseif ($item->isFile()) {
                @chmod($item->getPathname(), 0644);
            }
        }
    }

    /**
     * Recursively delete a directory.
     */
    public static function delete_directory(string $dir): bool {
        if (!is_dir($dir)) return false;

        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($iterator as $item) {
            if ($item->isDir()) {
                rmdir($item->getPathname());
            } else {
                unlink($item->getPathname());
            }
        }

        return rmdir($dir);
    }
}
