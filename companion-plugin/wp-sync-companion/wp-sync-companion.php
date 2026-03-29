<?php
/**
 * Plugin Name: WP Sync Companion
 * Plugin URI:  https://github.com/24gb-uk/wp-sync-companion
 * Description: Companion plugin for the Local WP "WP Live Sync" add-on. Exposes REST API endpoints for pulling/pushing your WordPress site.
 * Version:     1.0.0
 * Author:      Ramkumar R / 24GB
 * Author URI:  https://24gb.uk
 * License:     MIT
 * Requires PHP: 7.4
 * Requires at least: 5.6
 *
 * SECURITY NOTE: This plugin exposes powerful endpoints (database export, file access).
 * Access is restricted to authenticated administrators via WordPress Application Passwords.
 */

defined('ABSPATH') || exit;

define('WP_SYNC_VERSION', '1.0.0');
define('WP_SYNC_TEMP_DIR', WP_CONTENT_DIR . '/wp-sync-temp');

// Raise PHP upload limits for our REST endpoints.
// Many shared hosts default to 8M-64M which is too small for database exports.
// ini_set only works when PHP is not running in safe mode and the host allows it.
@ini_set('upload_max_filesize', '512M');
@ini_set('post_max_size',       '512M');
@ini_set('memory_limit',        '512M');
@ini_set('max_execution_time',  '600');
@ini_set('max_input_time',      '600');

// Load includes
require_once __DIR__ . '/includes/class-rest-controller.php';
require_once __DIR__ . '/includes/class-database-handler.php';
require_once __DIR__ . '/includes/class-file-handler.php';

/**
 * Initialize the plugin.
 */
add_action('rest_api_init', function () {
    $controller = new WP_Sync_REST_Controller();
    $controller->register_routes();
});

/**
 * Create temp directory on activation.
 */
register_activation_hook(__FILE__, function () {
    if (!file_exists(WP_SYNC_TEMP_DIR)) {
        wp_mkdir_p(WP_SYNC_TEMP_DIR);
    }
    // Protect temp dir with .htaccess
    file_put_contents(WP_SYNC_TEMP_DIR . '/.htaccess', 'Deny from all');
});

/**
 * Cleanup temp directory on deactivation.
 */
register_deactivation_hook(__FILE__, function () {
    if (file_exists(WP_SYNC_TEMP_DIR)) {
        WP_Sync_File_Handler::delete_directory(WP_SYNC_TEMP_DIR);
    }
});
