<?php
/**
 * Uninstall handler for Live Sync Companion.
 * Removes the temp directory (exports, logs, step state) entirely.
 */

defined('WP_UNINSTALL_PLUGIN') || exit;

$wplsync_temp_dir = WP_CONTENT_DIR . '/wp-sync-temp';

if (is_dir($wplsync_temp_dir)) {
    $wplsync_iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($wplsync_temp_dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ($wplsync_iterator as $wplsync_item) {
        if ($wplsync_item->isDir()) {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- Removing the plugin's own temp directory; WP_Filesystem is not reliably available during uninstall.
            @rmdir($wplsync_item->getPathname());
        } else {
            wp_delete_file($wplsync_item->getPathname());
        }
    }

    // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_rmdir -- Removing the plugin's own temp directory.
    @rmdir($wplsync_temp_dir);
}
