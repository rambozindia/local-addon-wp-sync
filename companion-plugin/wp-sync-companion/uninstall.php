<?php
/**
 * Uninstall handler for WP Sync Companion.
 * Removes the temp directory (exports, logs, step state) entirely.
 */

defined('WP_UNINSTALL_PLUGIN') || exit;

$wplsync_temp_dir = WP_CONTENT_DIR . '/wp-sync-temp';

if (is_dir($wplsync_temp_dir)) {
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($wplsync_temp_dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($iterator as $item) {
        if ($item->isDir()) {
            @rmdir($item->getPathname());
        } else {
            @unlink($item->getPathname());
        }
    }

    @rmdir($wplsync_temp_dir);
}
