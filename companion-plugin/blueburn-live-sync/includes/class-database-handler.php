<?php
/**
 * Database export/import handler.
 *
 * Uses WordPress's $wpdb to export all tables matching the site prefix,
 * and plain SQL execution for imports.
 *
 * Exports run in bounded steps (export_step) so each HTTP request finishes
 * well under proxy timeouts — Cloudflare kills responses after ~100s (524).
 */

defined('ABSPATH') || exit;

// phpcs:disable WordPress.WP.AlternativeFunctions -- Database dumps are written line by
// line and can be hundreds of MB. WP_Filesystem cannot stream or append, so direct PHP
// file operations are required.
// phpcs:disable WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared, PluginCheck.Security.DirectDB -- Exporting
// and importing entire tables requires schema-level queries (SHOW TABLES, SHOW CREATE TABLE,
// full-table SELECTs). Table names come from SHOW TABLES on this site (not user input) and
// are backtick-sanitized before interpolation; row limits/offsets use $wpdb->prepare().

class WPLSync_Database_Handler {

    /** Max seconds of work per export step request. */
    const TIME_BUDGET = 15;

    /** Rows fetched per SELECT while dumping a table. */
    const ROW_CHUNK = 500;

    /**
     * Export the entire database in a single request (loops export_step).
     * Kept for clients that don't use stepped exports.
     *
     * @return array|WP_Error Token and file info on success.
     */
    public function export() {
        $result = $this->export_step(null);
        while (!is_wp_error($result) && empty($result['complete'])) {
            $result = $this->export_step($result['token']);
        }
        return $result;
    }

    /**
     * Run one bounded step of a database export.
     *
     * @param string|null $token Token from a previous step, or null to start a new export.
     * @return array|WP_Error {token, complete, progress?} — plus size/filename when complete.
     */
    public function export_step(?string $token) {
        global $wpdb;

        wplsync_ensure_temp_dir();

        if (empty($token)) {
            $token = bin2hex(random_bytes(16));
            // Filename contains the random token: on servers that don't honor
            // .htaccess (nginx), a date-based name would be guessable and the
            // whole database dump publicly downloadable.
            $filename = 'db-export-' . $token . '.sql';
            $filepath = wplsync_temp_dir() . '/' . $filename;

            $handle = fopen($filepath, 'w');
            if (!$handle) {
                return new WP_Error('export_failed', 'Cannot create export file');
            }

            fwrite($handle, "-- BlueBurn Live Sync Database Export\n");
            fwrite($handle, "-- Generated: " . gmdate('Y-m-d H:i:s') . "\n");
            fwrite($handle, "-- WordPress: " . get_bloginfo('version') . "\n");
            fwrite($handle, "-- Site URL: " . home_url() . "\n\n");
            fwrite($handle, "SET NAMES utf8mb4;\n");
            fwrite($handle, "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';\n");
            fwrite($handle, "SET FOREIGN_KEY_CHECKS = 0;\n\n");
            fclose($handle);

            $state = [
                'path'        => $filepath,
                'filename'    => $filename,
                'tables'      => $wpdb->get_col("SHOW TABLES LIKE '{$wpdb->prefix}%'"),
                'table_index' => 0,
                'offset'      => 0,
            ];
            wplsync_log('info', 'DB export started: ' . count($state['tables']) . ' tables, token ' . $token);
        } else {
            $state = $this->load_state($token);
            if ($state === null) {
                return new WP_Error('invalid_token', 'Unknown or expired export token');
            }
        }

        $handle = fopen($state['path'], 'a');
        if (!$handle) {
            return new WP_Error('export_failed', 'Cannot open export file for writing');
        }

        $start  = microtime(true);
        $tables = $state['tables'];
        $total  = count($tables);

        while ($state['table_index'] < $total) {
            // Out of budget for this request — persist position and hand back to the client.
            if ((microtime(true) - $start) > self::TIME_BUDGET) {
                fclose($handle);
                $this->save_state($token, $state);
                return [
                    'token'    => $token,
                    'complete' => false,
                    'progress' => [
                        'tables_done'  => $state['table_index'],
                        'tables_total' => $total,
                    ],
                ];
            }

            // Table names come from SHOW TABLES on this site (not user input);
            // strip backticks and escape defensively before interpolating
            // between backticks below.
            $table = esc_sql(str_replace('`', '', $tables[$state['table_index']]));

            if ($state['offset'] === 0) {
                fwrite($handle, "DROP TABLE IF EXISTS `{$table}`;\n");
                $create = $wpdb->get_row("SHOW CREATE TABLE `{$table}`", ARRAY_N);
                fwrite($handle, $create[1] . ";\n\n");
            }

            $rows = $wpdb->get_results(
                $wpdb->prepare("SELECT * FROM `{$table}` LIMIT %d OFFSET %d", self::ROW_CHUNK, $state['offset']),
                ARRAY_A
            );

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

            $state['offset'] += count($rows);

            if (count($rows) < self::ROW_CHUNK) {
                // Table finished — move to the next one
                fwrite($handle, "\n");
                $state['table_index']++;
                $state['offset'] = 0;
            }
        }

        fwrite($handle, "SET FOREIGN_KEY_CHECKS = 1;\n");
        fclose($handle);

        wp_delete_file($this->state_path($token));

        // Save download manifest
        $manifest = [
            'path'     => $state['path'],
            'filename' => $state['filename'],
            'created'  => time(),
            'type'     => 'database',
        ];
        file_put_contents(wplsync_temp_dir() . '/' . $token . '.json', json_encode($manifest));

        wplsync_log('info', 'DB export complete: ' . filesize($state['path']) . ' bytes, token ' . $token);

        return [
            'token'    => $token,
            'complete' => true,
            'size'     => filesize($state['path']),
            'filename' => $state['filename'],
        ];
    }

    // ─── Step state persistence ───

    private function state_path(string $token): string {
        return wplsync_temp_dir() . '/' . $token . '.state.json';
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
            // (strpos over str_starts_with: PHP 7.4 compatibility)
            if ($current === '' && (
                $trimmed === '' ||
                strpos($trimmed, '--') === 0 ||
                strpos($trimmed, '#') === 0 ||
                strpos($trimmed, '/*') === 0
            )) {
                continue;
            }

            $current .= $line;

            // Detect end of statement: semicolon at end of trimmed line,
            // and we are not inside a quoted string.
            if (!$in_string && substr($trimmed, -1) === ';') {
                $stmt = trim($current);
                if ($stmt !== '' && strpos($stmt, '--') !== 0) {
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
        if ($stmt !== '' && strpos($stmt, '--') !== 0) {
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
