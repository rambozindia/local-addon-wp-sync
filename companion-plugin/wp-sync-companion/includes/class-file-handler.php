<?php
/**
 * File export/import handler.
 *
 * Creates ZIP archives of WordPress files for download,
 * and extracts uploaded archives into the WordPress installation.
 */

defined('ABSPATH') || exit;

class WP_Sync_File_Handler {

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

    /**
     * Export WordPress files as a ZIP archive.
     *
     * @param string $scope One of: 'full', 'wp-content', 'themes', 'plugins', 'uploads'
     * @return array|WP_Error Token and file info on success.
     */
    public function export(string $scope = 'full') {
        if (!class_exists('ZipArchive')) {
            return new WP_Error('zip_missing', 'PHP ZipArchive extension is required but not installed.');
        }

        // Ensure temp dir exists
        if (!file_exists(WP_SYNC_TEMP_DIR)) {
            wp_mkdir_p(WP_SYNC_TEMP_DIR);
        }

        $token    = bin2hex(random_bytes(16));
        $filename = 'files-export-' . $scope . '-' . date('Y-m-d-His') . '.zip';
        $filepath = WP_SYNC_TEMP_DIR . '/' . $filename;

        // Determine source directory based on scope
        $source_dir = $this->get_source_directory($scope);
        if (is_wp_error($source_dir)) {
            return $source_dir;
        }

        try {
            $zip = new ZipArchive();
            $result = $zip->open($filepath, ZipArchive::CREATE | ZipArchive::OVERWRITE);

            if ($result !== true) {
                return new WP_Error('zip_failed', 'Failed to create ZIP archive. Error code: ' . $result);
            }

            // Add files recursively
            $files_added = $this->add_directory_to_zip($zip, $source_dir, '');

            // Add a manifest file with metadata
            $manifest = json_encode([
                'scope'      => $scope,
                'source'     => $source_dir,
                'site_url'   => home_url(),
                'wp_version' => get_bloginfo('version'),
                'created'    => date('Y-m-d H:i:s'),
                'files'      => $files_added,
            ], JSON_PRETTY_PRINT);
            $zip->addFromString('.wp-sync-manifest.json', $manifest);

            $zip->close();

            // Save download manifest
            $download_manifest = [
                'path'     => $filepath,
                'filename' => $filename,
                'created'  => time(),
                'type'     => 'files',
                'scope'    => $scope,
            ];
            file_put_contents(
                WP_SYNC_TEMP_DIR . '/' . $token . '.json',
                json_encode($download_manifest)
            );

            return [
                'token'    => $token,
                'size'     => filesize($filepath),
                'filename' => $filename,
                'files'    => $files_added,
            ];

        } catch (Exception $e) {
            if (file_exists($filepath)) {
                unlink($filepath);
            }
            return new WP_Error('export_failed', $e->getMessage());
        }
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
     * Recursively add a directory to a ZIP archive.
     *
     * @return int Number of files added.
     */
    private function add_directory_to_zip(ZipArchive $zip, string $dir, string $prefix): int {
        $count = 0;
        $dir   = rtrim($dir, '/\\');

        if (!is_dir($dir)) return 0;

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
            if ($full_path === WP_SYNC_TEMP_DIR) {
                continue;
            }

            // Skip wp-config.php in full exports (will be handled separately)
            if ($filename === 'wp-config.php' && empty($prefix)) {
                continue;
            }

            if ($item->isDir()) {
                $zip->addEmptyDir($zip_path);
                $count += $this->add_directory_to_zip($zip, $full_path, $zip_path);
            } elseif ($item->isFile() && $item->isReadable()) {
                // Skip very large files (> 256MB) to prevent memory issues
                if ($item->getSize() > 268435456) {
                    continue;
                }
                $zip->addFile($full_path, $zip_path);
                $count++;
            }
        }

        return $count;
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
        $backup = WP_SYNC_TEMP_DIR . '/wp-config-backup-' . time() . '.php';

        if (file_exists($config)) {
            copy($config, $backup);
        }
    }

    /**
     * Restore wp-config.php after a full import.
     */
    private function restore_wp_config(string $dir): void {
        // Find the most recent backup
        $backups = glob(WP_SYNC_TEMP_DIR . '/wp-config-backup-*.php');
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
