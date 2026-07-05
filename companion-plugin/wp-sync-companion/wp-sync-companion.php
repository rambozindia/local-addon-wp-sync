<?php
/**
 * Plugin Name: WP Sync Companion
 * Plugin URI:  https://github.com/24gb-uk/wp-sync-companion
 * Description: Companion plugin for the Local WP "WP Live Sync" add-on. Exposes REST API endpoints for pulling/pushing your WordPress site.
 * Version:     1.2.0
 * Author:      Ramkumar R / 24GB
 * Author URI:  https://24gb.uk
 * License:     GPLv2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: wp-sync-companion
 * Requires PHP: 7.4
 * Requires at least: 5.6
 *
 * SECURITY NOTE: This plugin exposes powerful endpoints (database export, file access).
 * Access is restricted to authenticated administrators via WordPress Application Passwords.
 */

defined('ABSPATH') || exit;

define('WPLSYNC_VERSION', '1.2.0');
define('WPLSYNC_TEMP_DIR', WP_CONTENT_DIR . '/wp-sync-temp');

/**
 * Raise PHP limits — but only for this plugin's own REST requests.
 * Many shared hosts default to 8M-64M which is too small for database
 * exports. ini_set only works when the host allows it.
 */
if (isset($_SERVER['REQUEST_URI']) && strpos($_SERVER['REQUEST_URI'], 'wp-sync/v1') !== false) {
    @ini_set('upload_max_filesize', '512M');
    @ini_set('post_max_size',       '512M');
    @ini_set('memory_limit',        '512M');
    @ini_set('max_execution_time',  '600');
    @ini_set('max_input_time',      '600');
}

/**
 * Create the temp directory (if needed) with access protections:
 * .htaccess deny rules for Apache and an index.php to prevent directory
 * listing. All export files inside use unguessable random-token names,
 * which is the effective protection on servers that ignore .htaccess (nginx).
 */
if (!function_exists('wplsync_ensure_temp_dir')) {
    function wplsync_ensure_temp_dir(): void {
        if (!file_exists(WPLSYNC_TEMP_DIR)) {
            wp_mkdir_p(WPLSYNC_TEMP_DIR);
        }
        if (!file_exists(WPLSYNC_TEMP_DIR . '/.htaccess')) {
            @file_put_contents(WPLSYNC_TEMP_DIR . '/.htaccess', "Deny from all\n");
        }
        if (!file_exists(WPLSYNC_TEMP_DIR . '/index.php')) {
            @file_put_contents(WPLSYNC_TEMP_DIR . '/index.php', "<?php // Silence is golden.\n");
        }
    }
}

/**
 * Path of the plugin's log file. The name is derived from the site's auth
 * salt so it cannot be guessed and fetched directly on servers that ignore
 * .htaccess — the log contains export tokens.
 */
if (!function_exists('wplsync_log_path')) {
    function wplsync_log_path(): string {
        return WPLSYNC_TEMP_DIR . '/wp-sync-' . substr(md5(wp_salt('auth')), 0, 16) . '.log';
    }
}

/**
 * Append a line to the plugin's own log file.
 * Retrievable remotely via GET /wp-json/wp-sync/v1/log (admin auth required).
 */
if (!function_exists('wplsync_log')) {
    function wplsync_log(string $level, string $message): void {
        wplsync_ensure_temp_dir();
        $line = sprintf('[%s] %s: %s', gmdate('Y-m-d H:i:s'), strtoupper($level), $message) . "\n";
        @file_put_contents(wplsync_log_path(), $line, FILE_APPEND | LOCK_EX);
    }
}

// Load includes
require_once __DIR__ . '/includes/class-rest-controller.php';
require_once __DIR__ . '/includes/class-database-handler.php';
require_once __DIR__ . '/includes/class-file-handler.php';

/**
 * Initialize the plugin.
 */
add_action('rest_api_init', function () {
    $controller = new WPLSync_REST_Controller();
    $controller->register_routes();
});

/**
 * Create the protected temp directory on activation.
 */
register_activation_hook(__FILE__, function () {
    wplsync_ensure_temp_dir();
});

/**
 * Cleanup temp directory on deactivation.
 */
register_deactivation_hook(__FILE__, function () {
    if (file_exists(WPLSYNC_TEMP_DIR)) {
        WPLSync_File_Handler::delete_directory(WPLSYNC_TEMP_DIR);
    }
});
