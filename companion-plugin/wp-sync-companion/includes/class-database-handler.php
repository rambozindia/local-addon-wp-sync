<?php
/**
 * Database export/import handler.
 *
 * Uses WordPress's $wpdb to export all tables matching the site prefix,
 * and plain SQL execution for imports.
 */

defined('ABSPATH') || exit;

class WP_Sync_Database_Handler {

    /**
     * Export the database to a SQL file.
     *
     * @return array|WP_Error Token and file info on success.
     */
    public function export() {
        global $wpdb;

        // Ensure temp dir exists
        if (!file_exists(WP_SYNC_TEMP_DIR)) {
            wp_mkdir_p(WP_SYNC_TEMP_DIR);
        }

        $token    = bin2hex(random_bytes(16));
        $filename = 'db-export-' . date('Y-m-d-His') . '.sql';
        $filepath = WP_SYNC_TEMP_DIR . '/' . $filename;

        try {
            $handle = fopen($filepath, 'w');
            if (!$handle) {
                return new WP_Error('export_failed', 'Cannot create export file');
            }

            // Header
            fwrite($handle, "-- WP Sync Companion Database Export\n");
            fwrite($handle, "-- Generated: " . date('Y-m-d H:i:s') . "\n");
            fwrite($handle, "-- WordPress: " . get_bloginfo('version') . "\n");
            fwrite($handle, "-- Site URL: " . home_url() . "\n\n");
            fwrite($handle, "SET NAMES utf8mb4;\n");
            fwrite($handle, "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n");
            fwrite($handle, "SET FOREIGN_KEY_CHECKS = 0;\n\n");

            // Get all tables with the WP prefix
            $tables = $wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}%'");

            foreach ($tables as $table) {
                // DROP + CREATE
                fwrite($handle, "DROP TABLE IF EXISTS `{$table}`;\n");
                $create = $wpdb->get_row("SHOW CREATE TABLE `{$table}`", ARRAY_N);
                fwrite($handle, $create[1] . ";\n\n");

                // Export data in chunks
                $offset = 0;
                $chunk  = 500;

                while (true) {
                    $rows = $wpdb->get_results(
                        $wpdb->prepare("SELECT * FROM `{$table}` LIMIT %d OFFSET %d", $chunk, $offset),
                        ARRAY_A
                    );

                    if (empty($rows)) break;

                    foreach ($rows as $row) {
                        $values = array_map(function ($v) use ($wpdb) {
                            if ($v === null) return 'NULL';
                            return "'" . $wpdb->_real_escape($v) . "'";
                        }, array_values($row));

                        $columns = array_map(function ($c) {
                            return '`' . $c . '`';
                        }, array_keys($row));

                        fwrite($handle, "INSERT INTO `{$table}` (" . implode(', ', $columns) . ") VALUES (" . implode(', ', $values) . ");\n");
                    }

                    $offset += $chunk;

                    if (count($rows) < $chunk) break;
                }

                fwrite($handle, "\n");
            }

            fwrite($handle, "SET FOREIGN_KEY_CHECKS = 1;\n");
            fclose($handle);

            // Save manifest
            $manifest = [
                'path'     => $filepath,
                'filename' => $filename,
                'created'  => time(),
                'type'     => 'database',
            ];
            file_put_contents(WP_SYNC_TEMP_DIR . '/' . $token . '.json', json_encode($manifest));

            return [
                'token'    => $token,
                'size'     => filesize($filepath),
                'filename' => $filename,
            ];

        } catch (Exception $e) {
            if (isset($handle) && is_resource($handle)) fclose($handle);
            return new WP_Error('export_failed', $e->getMessage());
        }
    }

    /**
     * Import a SQL file into the database.
     * Streams the file line-by-line to avoid loading the whole file into memory.
     *
     * @param string $sql_file Path to the uploaded SQL file.
     * @return array|WP_Error Import result.
     */
    public function import(string $sql_file) {
        global $wpdb;

        if (!file_exists($sql_file)) {
            return new WP_Error('import_failed', 'SQL file not found');
        }

        $handle = fopen($sql_file, 'r');
        if (!$handle) {
            return new WP_Error('import_failed', 'Cannot open SQL file for reading');
        }

        // Use mysqli directly so we can run multi-statement imports reliably
        $mysqli = $wpdb->dbh;
        if (!($mysqli instanceof mysqli)) {
            fclose($handle);
            return new WP_Error('import_failed', 'Could not access mysqli connection');
        }

        $executed  = 0;
        $errors    = [];
        $current   = '';
        $in_string = false;
        $string_char = '';

        while (($line = fgets($handle)) !== false) {
            $trimmed = rtrim($line);

            // Skip comment-only lines when buffer is empty
            if ($current === '' && (
                $trimmed === '' ||
                str_starts_with($trimmed, '--') ||
                str_starts_with($trimmed, '#') ||
                str_starts_with($trimmed, '/*')
            )) {
                continue;
            }

            $current .= $line;

            // Detect end of statement: semicolon at end of trimmed line,
            // and we are not inside a quoted string.
            if (!$in_string && substr($trimmed, -1) === ';') {
                $stmt = trim($current);
                if ($stmt !== '' && !str_starts_with($stmt, '--')) {
                    if ($mysqli->query($stmt) === false) {
                        $errors[] = $mysqli->error;
                    } else {
                        $executed++;
                    }
                }
                $current = '';
            }
        }

        fclose($handle);

        // Run any trailing statement without a final semicolon
        $stmt = trim($current);
        if ($stmt !== '' && !str_starts_with($stmt, '--')) {
            if ($mysqli->query($stmt) !== false) {
                $executed++;
            }
        }

        wp_cache_flush();

        return [
            'success'    => true,
            'statements' => $executed,
            'errors'     => count($errors),
            'error_list' => array_slice($errors, 0, 10), // first 10 for debugging
            'tables'     => count($wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}%'")),
        ];
    }
}
