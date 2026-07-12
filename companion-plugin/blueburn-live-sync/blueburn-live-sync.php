<?php
/**
 * Plugin Name: BlueBurn Live Sync for Local
 * Plugin URI:  https://github.com/rambozindia/blueburn-live-sync
 * Description: Companion plugin for the BlueBurn Live Sync add-on for Local. Exposes REST API endpoints for pulling/pushing your WordPress site.
 * Version:     1.3.0
 * Author:      BlueBurn Technologies
 * Author URI:  https://blueburn.in
 * License:     GPLv2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: blueburn-live-sync
 * Requires PHP: 7.4
 * Requires at least: 5.6
 *
 * SECURITY NOTE: This plugin exposes powerful endpoints (database export, file access).
 * Access is restricted to authenticated administrators via WordPress Application Passwords.
 */

defined('ABSPATH') || exit;

define('WPLSYNC_VERSION', '1.3.0');

/**
 * Temp directory for exports/imports, inside the uploads directory as
 * recommended by the plugin guidelines (multisite compatible).
 */
if (!function_exists('wplsync_temp_dir')) {
    function wplsync_temp_dir(): string {
        $upload = wp_upload_dir(null, false);
        return rtrim($upload['basedir'], '/\\') . '/blueburn-live-sync';
    }
}

/**
 * Create the temp directory (if needed) with access protections:
 * .htaccess deny rules for Apache and an index.php to prevent directory
 * listing. All export files inside use unguessable random-token names,
 * which is the effective protection on servers that ignore .htaccess (nginx).
 */
if (!function_exists('wplsync_ensure_temp_dir')) {
    function wplsync_ensure_temp_dir(): void {
        $dir = wplsync_temp_dir();
        if (!file_exists($dir)) {
            wp_mkdir_p($dir);
        }
        if (!file_exists($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess', "Deny from all\n");
        }
        if (!file_exists($dir . '/index.php')) {
            @file_put_contents($dir . '/index.php', "<?php // Silence is golden.\n");
        }
    }
}

/**
 * Raise PHP limits for the resource-intensive sync operations only.
 * Called at the start of the heavy REST handlers (export/import/download) —
 * never at bootstrap. ini_set is silently ignored where the host forbids it.
 */
if (!function_exists('wplsync_raise_limits')) {
    function wplsync_raise_limits(): void {
        // phpcs:disable Squiz.PHP.DiscouragedFunctions.Discouraged -- Full-site
        // exports/imports genuinely need higher limits; scoped to the specific
        // handlers that perform the heavy work.
        @ini_set('memory_limit', '512M');
        @ini_set('max_execution_time', '600');
        @ini_set('max_input_time', '600');
        // phpcs:enable Squiz.PHP.DiscouragedFunctions.Discouraged
    }
}

/**
 * Path of the plugin's log file. The name embeds a random key (stored as a
 * non-autoloaded option) so the log cannot be fetched directly on servers
 * that ignore .htaccess — it contains export tokens.
 */
if (!function_exists('wplsync_log_path')) {
    function wplsync_log_path(): string {
        $key = get_option('wplsync_log_key');
        if (!$key || !preg_match('/^[a-f0-9]{16}$/', $key)) {
            $key = bin2hex(random_bytes(8));
            update_option('wplsync_log_key', $key, false);
        }
        return wplsync_temp_dir() . '/log-' . $key . '.log';
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
    if (file_exists(wplsync_temp_dir())) {
        WPLSync_File_Handler::delete_directory(wplsync_temp_dir());
    }
});
