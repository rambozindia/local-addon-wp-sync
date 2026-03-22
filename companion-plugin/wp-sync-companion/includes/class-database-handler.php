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
     *
     * @param string $sql_file Path to the uploaded SQL file.
     * @return array|WP_Error Import result.
     */
    public function import(string $sql_file) {
        global $wpdb;

        if (!file_exists($sql_file)) {
            return new WP_Error('import_failed', 'SQL file not found');
        }

        try {
            $sql = file_get_contents($sql_file);
            if ($sql === false) {
                return new WP_Error('import_failed', 'Cannot read SQL file');
            }

            // Split into individual statements
            $statements = $this->split_sql($sql);
            $executed   = 0;
            $errors     = [];

            foreach ($statements as $statement) {
                $statement = trim($statement);
                if (empty($statement) || strpos($statement, '--') === 0) continue;

                $result = $wpdb->query($statement);
                if ($result === false) {
                    $errors[] = $wpdb->last_error;
                } else {
                    $executed++;
                }
            }

            // Flush rewrite rules and caches
            flush_rewrite_rules();
            wp_cache_flush();

            return [
                'success'    => true,
                'statements' => $executed,
                'errors'     => count($errors),
                'tables'     => count($wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}%'")),
            ];

        } catch (Exception $e) {
            return new WP_Error('import_failed', $e->getMessage());
        }
    }

    /**
     * Split SQL dump into individual statements, respecting delimiters.
     */
    private function split_sql(string $sql): array {
        $statements = [];
        $current    = '';
        $lines      = explode("\n", $sql);

        foreach ($lines as $line) {
            $trimmed = trim($line);

            // Skip comments
            if (strpos($trimmed, '--') === 0 || strpos($trimmed, '#') === 0 || empty($trimmed)) {
                continue;
            }

            $current .= $line . "\n";

            // Statement ends with semicolon
            if (substr($trimmed, -1) === ';') {
                $statements[] = $current;
                $current = '';
            }
        }

        if (trim($current)) {
            $statements[] = $current;
        }

        return $statements;
    }
}
