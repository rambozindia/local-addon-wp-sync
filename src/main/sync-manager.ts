import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WPSyncApiClient, FilesExportResult } from './api-client';
import { SiteConnection, SyncProgress, SyncResult, RemoteSiteInfo } from './types';
import { wpSyncLog } from './logger';

type ProgressCallback = (progress: SyncProgress) => void;

/**
 * SyncManager orchestrates the full pull/push lifecycle:
 *
 * PULL (live → Local):
 *   1. Connect to live site via REST API (companion plugin)
 *   2. Trigger DB export on remote → download SQL
 *   3. Trigger files export on remote → download ZIP
 *   4. Extract files into Local site's directory
 *   5. Import DB using Local's bundled WP-CLI
 *   6. Search-replace URLs (live URL → local URL)
 *
 * PUSH (Local → live):
 *   1. Export local DB via WP-CLI
 *   2. Package local files into ZIP
 *   3. Upload DB to remote via REST API
 *   4. Upload files to remote via REST API
 *   5. Remote companion plugin handles extraction + URL rewrite
 */
export class SyncManager {
  private serviceContainer: any;

  constructor(serviceContainer: any) {
    this.serviceContainer = serviceContainer;
  }

  /**
   * Test connection to a live WordPress site.
   */
  async testConnection(connection: SiteConnection) {
    const client = new WPSyncApiClient(connection);
    return client.testConnection();
  }

  /**
   * Get remote site information.
   */
  async getRemoteSiteInfo(connection: SiteConnection): Promise<RemoteSiteInfo> {
    const client = new WPSyncApiClient(connection);
    return client.getSiteInfo();
  }

  /**
   * Create a brand-new Local WP site from a live site.
   * Downloads the live site's files and DB then provisions a new Local site.
   */
  async createSiteFromLive(
    connection: SiteConnection,
    newSiteName: string,
    onProgress: ProgressCallback
  ): Promise<SyncResult & { newSiteId?: string }> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const client = new WPSyncApiClient(connection);
    const tempSiteId = `new-${Date.now()}`;
    const tempDir = this.getTempDir(tempSiteId);
    onProgress = this.withLogging('create-from-live', onProgress);
    wpSyncLog('info', `Create-from-live started: "${newSiteName}" from ${connection.siteUrl}`);
    const exportTokens: string[] = [];

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      // The live site may use a custom table prefix (e.g. c_ instead of wp_);
      // the generated wp-config.php must match the imported tables.
      const dbPrefix = await this.getRemoteDbPrefix(client);

      // ── Stage 1: Export database on remote ──
      onProgress({ stage: 'exporting-db', percent: 5, message: 'Exporting database on live site...' });
      const dbExport = await client.exportDatabase((p) =>
        onProgress({ stage: 'exporting-db', percent: 8, message: `Exporting database on live site (${p})...` })
      );
      exportTokens.push(dbExport.token);

      // ── Stage 2: Download database ──
      onProgress({ stage: 'downloading-db', percent: 15, message: `Downloading database (${formatBytes(dbExport.size)})...` });
      const dbPath = path.join(tempDir, 'database.sql');
      await this.downloadToFile(client, dbExport.token, dbPath, undefined, dbExport.size);

      // ── Stage 3: Export files on remote ──
      onProgress({ stage: 'exporting-files', percent: 25, message: 'Archiving files on live site...' });
      const filesExport = await client.exportFiles('full', (p) =>
        onProgress({ stage: 'exporting-files', percent: 28, message: `Archiving files on live site (${p})...` })
      );
      exportTokens.push(filesExport.token);

      // ── Stage 4: Download files (possibly multiple archive parts) ──
      const partPaths = await this.downloadFileParts(client, filesExport, tempDir, onProgress, 40, 52);

      // ── Stage 5: Provision new Local site ──
      onProgress({ stage: 'creating-site', percent: 55, message: `Creating new Local site "${newSiteName}"...` });
      const newSite = await this.provisionNewSite(newSiteName);

      // ── Stage 6: Extract files into new site ──
      onProgress({ stage: 'extracting-files', percent: 65, message: 'Extracting files into new site...' });
      const sitePath = newSite.paths?.webRoot || newSite.path;
      if (fs.existsSync(sitePath)) {
        execSync(`chmod -R u+w "${sitePath}"`, { stdio: 'ignore' });
      }
      let filesCount = 0;
      for (const partPath of partPaths) {
        filesCount += await this.extractFiles(partPath, sitePath);
      }

      // ── Stage 7: Wait for MySQL and generate wp-config.php ──
      onProgress({ stage: 'importing-db', percent: 75, message: 'Waiting for MySQL to be ready...' });
      await this.waitForMySqlReady(newSite);

      onProgress({ stage: 'importing-db', percent: 78, message: 'Generating wp-config.php...' });
      const dbName = newSite.mysql?.database || 'local';
      const dbUser = newSite.mysql?.user || 'root';
      const dbPass = newSite.mysql?.password || 'root';
      await this.runWpCli(newSite, [
        'config', 'create',
        `--dbname=${dbName}`,
        `--dbuser=${dbUser}`,
        `--dbpass=${dbPass}`,
        '--dbhost=localhost',
        `--dbprefix=${dbPrefix}`,
        '--skip-check',
        '--force',
      ]);

      // ── Stage 8: Import database ──
      onProgress({ stage: 'importing-db', percent: 82, message: 'Importing database via WP-CLI...' });
      await this.importDatabase(newSite, dbPath);

      // ── Stage 8: Search-replace URLs ──
      onProgress({ stage: 'rewriting-urls', percent: 88, message: 'Rewriting URLs for local environment...' });
      const localUrl = this.getLocalSiteUrl(newSite);
      await this.searchReplaceUrls(newSite, connection.siteUrl, localUrl);

      // ── Stage 9: Cleanup ──
      onProgress({ stage: 'cleanup', percent: 95, message: 'Cleaning up temporary files...' });
      await client.cleanup(dbExport.token).catch(() => {});
      await client.cleanup(filesExport.token).catch(() => {});
      this.cleanupTemp(tempDir);

      onProgress({ stage: 'complete', percent: 100, message: `New site "${newSiteName}" created successfully!` });

      return {
        success: true,
        filesTransferred: filesCount,
        dbImported: true,
        duration: Date.now() - startTime,
        warnings,
        newSiteId: newSite.id,
      };
    } catch (error: any) {
      wpSyncLog('error', `Create-from-live failed: ${error.message}\n${error.stack || ''}`);
      await this.captureRemoteLog(client);
      await this.cleanupRemoteExports(client, exportTokens);
      onProgress({ stage: 'error', percent: 0, message: error.message });
      this.cleanupTemp(tempDir);
      throw error;
    }
  }

  /**
   * Provision a new Local WP site using Local's service container.
   */
  private async provisionNewSite(siteName: string): Promise<any> {
    // Local registers AddSiteService as "addSite" in the service container
    const addSiteService = this.serviceContainer?.addSite;

    const slug = siteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const domain = `${slug}.local`;
    const sitesDir = path.join(require('os').homedir(), 'Local Sites');
    const sitePath = path.join(sitesDir, siteName);

    if (addSiteService?.addSite) {
      // Use Local's own AddSiteService — this creates a proper Site instance
      // with all methods (getSiteServiceByRole etc.) and provisions it correctly.
      // installWP: false because we overwrite with our own files right after.
      const site = await addSiteService.addSite({
        newSiteInfo: {
          siteName,
          sitePath,
          siteDomain: domain,
          environment: 'preferred',
          multiSite: 'no',
          xdebugEnabled: false,
        },
        wpCredentials: {
          adminUsername: 'admin',
          adminPassword: 'admin',
          adminEmail: 'admin@example.com',
        },
        goToSite: false,
        installWP: false,
      });
      return site;
    }

    throw new Error(
      'Could not create a new Local site: AddSiteService not found in service container.'
    );
  }

  /**
   * Pull a full site from live into a Local WP site.
   */
  async pullSite(
    siteId: string,
    connection: SiteConnection,
    onProgress: ProgressCallback
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const client = new WPSyncApiClient(connection);
    const site = this.getLocalSite(siteId);
    const tempDir = this.getTempDir(siteId);
    onProgress = this.withLogging(`pull ${siteId}`, onProgress);
    wpSyncLog('info', `Pull started: site ${siteId} from ${connection.siteUrl}`);
    const exportTokens: string[] = [];

    try {
      // Ensure temp directory exists
      fs.mkdirSync(tempDir, { recursive: true });

      // ── Stage 1: Export database on remote ──
      onProgress({ stage: 'exporting-db', percent: 5, message: 'Exporting database on live site...' });
      const dbExport = await client.exportDatabase((p) =>
        onProgress({ stage: 'exporting-db', percent: 8, message: `Exporting database on live site (${p})...` })
      );
      exportTokens.push(dbExport.token);

      // ── Stage 2: Download database ──
      onProgress({ stage: 'downloading-db', percent: 15, message: `Downloading database (${formatBytes(dbExport.size)})...` });
      const dbPath = path.join(tempDir, 'database.sql');
      await this.downloadToFile(client, dbExport.token, dbPath, undefined, dbExport.size);

      // ── Stage 3: Export files on remote ──
      onProgress({ stage: 'exporting-files', percent: 25, message: 'Archiving files on live site...' });
      const filesExport = await client.exportFiles('full', (p) =>
        onProgress({ stage: 'exporting-files', percent: 28, message: `Archiving files on live site (${p})...` })
      );
      exportTokens.push(filesExport.token);

      // ── Stage 4: Download files (possibly multiple archive parts) ──
      const partPaths = await this.downloadFileParts(client, filesExport, tempDir, onProgress, 35, 55);

      // ── Stage 5: Extract files into Local site ──
      onProgress({ stage: 'extracting-files', percent: 55, message: 'Extracting files into Local site...' });
      const sitePath = site.paths?.webRoot || site.path;
      let filesCount = 0;
      for (const partPath of partPaths) {
        filesCount += await this.extractFiles(partPath, sitePath);
      }

      // ── Stage 6: Import database ──
      onProgress({ stage: 'importing-db', percent: 75, message: 'Importing database...' });
      await this.importDatabase(site, dbPath);

      // Align the local wp-config.php table prefix with the imported tables
      // (the live site may use a custom prefix like c_ instead of wp_).
      const dbPrefix = await this.getRemoteDbPrefix(client);
      await this.runWpCli(site, ['config', 'set', 'table_prefix', dbPrefix]);

      // ── Stage 7: Search-replace URLs ──
      onProgress({ stage: 'rewriting-urls', percent: 85, message: 'Rewriting URLs for local environment...' });
      const localUrl = this.getLocalSiteUrl(site);
      await this.searchReplaceUrls(site, connection.siteUrl, localUrl);

      // ── Stage 8: Cleanup ──
      onProgress({ stage: 'cleanup', percent: 95, message: 'Cleaning up temporary files...' });
      await client.cleanup(dbExport.token).catch(() => {});
      await client.cleanup(filesExport.token).catch(() => {});
      this.cleanupTemp(tempDir);

      onProgress({ stage: 'complete', percent: 100, message: 'Pull complete!' });

      return {
        success: true,
        filesTransferred: filesCount,
        dbImported: true,
        duration: Date.now() - startTime,
        warnings,
      };
    } catch (error: any) {
      wpSyncLog('error', `Pull failed: ${error.message}\n${error.stack || ''}`);
      await this.captureRemoteLog(client);
      await this.cleanupRemoteExports(client, exportTokens);
      onProgress({ stage: 'error', percent: 0, message: error.message });
      this.cleanupTemp(tempDir);
      throw error;
    }
  }

  /**
   * Push a Local site to the live server.
   */
  async pushSite(
    siteId: string,
    connection: SiteConnection,
    onProgress: ProgressCallback
  ): Promise<SyncResult> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const client = new WPSyncApiClient(connection);
    const site = this.getLocalSite(siteId);
    const tempDir = this.getTempDir(siteId);
    onProgress = this.withLogging(`push ${siteId}`, onProgress);
    wpSyncLog('info', `Push started: site ${siteId} to ${connection.siteUrl}`);

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      // ── Stage 1: Export local database ──
      onProgress({ stage: 'exporting-db', percent: 10, message: 'Exporting local database...' });
      const dbPath = path.join(tempDir, 'database.sql');
      await this.exportLocalDatabase(site, dbPath);

      // ── Stage 2: Rewrite URLs in exported SQL ──
      onProgress({ stage: 'rewriting-urls', percent: 20, message: 'Rewriting URLs for live environment...' });
      const localUrl = this.getLocalSiteUrl(site);
      this.rewriteSqlUrls(dbPath, localUrl, connection.siteUrl);

      // ── Stage 3: Package files ──
      onProgress({ stage: 'exporting-files', percent: 30, message: 'Packaging site files...' });
      const filesPath = path.join(tempDir, 'files.zip');
      const sitePath = site.paths?.webRoot || site.path;
      const filesCount = await this.packageFiles(sitePath, filesPath);

      // ── Stage 4: Upload database ──
      onProgress({ stage: 'uploading-db', percent: 50, message: 'Uploading database to live server...' });
      await client.uploadDatabase(dbPath);

      // ── Stage 5: Upload files ──
      onProgress({ stage: 'uploading-files', percent: 70, message: 'Uploading files to live server...' });
      await client.uploadFiles(filesPath, 'full');

      // ── Stage 6: Cleanup ──
      onProgress({ stage: 'cleanup', percent: 95, message: 'Cleaning up...' });
      this.cleanupTemp(tempDir);

      onProgress({ stage: 'complete', percent: 100, message: 'Push complete!' });

      return {
        success: true,
        filesTransferred: filesCount,
        dbImported: true,
        duration: Date.now() - startTime,
        warnings,
      };
    } catch (error: any) {
      wpSyncLog('error', `Push failed: ${error.message}\n${error.stack || ''}`);
      await this.captureRemoteLog(client);
      onProgress({ stage: 'error', percent: 0, message: error.message });
      this.cleanupTemp(tempDir);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════

  /**
   * Wrap a progress callback so every stage update also lands in the log.
   */
  private withLogging(label: string, onProgress: ProgressCallback): ProgressCallback {
    return (progress) => {
      wpSyncLog('info', `[${label}] ${progress.stage} ${progress.percent}% — ${progress.message}`);
      onProgress(progress);
    };
  }

  /**
   * After a failure, fetch the companion plugin's log tail so remote errors
   * (including PHP fatals) are visible in the local wp-sync.log.
   */
  private async captureRemoteLog(client: WPSyncApiClient): Promise<void> {
    const log = await client.getRemoteLog();
    if (log) {
      wpSyncLog('info', `--- remote companion plugin log (tail) ---\n${log}--- end remote log ---`);
    }
  }

  /**
   * Fetch the live site's database table prefix (e.g. wp_ or c_) so the
   * local wp-config.php can be made to match the imported tables.
   * Falls back to wp_ if the prefix can't be determined or looks unsafe.
   */
  private async getRemoteDbPrefix(client: WPSyncApiClient): Promise<string> {
    try {
      const info = await client.getSiteInfo();
      const prefix = info?.dbPrefix || 'wp_';
      if (/^[A-Za-z0-9_]+$/.test(prefix)) {
        wpSyncLog('info', `Remote table prefix: ${prefix}`);
        return prefix;
      }
      wpSyncLog('error', `Remote table prefix looks unsafe (${prefix}), falling back to wp_`);
    } catch (err: any) {
      wpSyncLog('error', `Could not fetch remote site info for table prefix: ${err.message}`);
    }
    return 'wp_';
  }

  /**
   * Delete remote export files after a failed sync so aborted attempts don't
   * accumulate large SQL/ZIP files in wp-sync-temp on the live server.
   */
  private async cleanupRemoteExports(client: WPSyncApiClient, tokens: string[]): Promise<void> {
    for (const token of tokens) {
      await client.cleanup(token).catch(() => {});
    }
  }

  private getLocalSite(siteId: string): any {
    const siteData = this.serviceContainer?.siteData;
    if (!siteData) throw new Error(`Local site with ID "${siteId}" not found.`);

    const site = siteData.getSite(siteId);
    if (!site) throw new Error(`Local site with ID "${siteId}" not found.`);

    // siteData.getSite() may return a plain object. If getSiteServiceByRole is
    // missing, wrap it so Local's WpCliService can resolve PHP/DB services.
    if (typeof site.getSiteServiceByRole !== 'function') {
      site.getSiteServiceByRole = (role: string) => {
        const services: Record<string, any> = site.services || {};
        return Object.values(services).find((s: any) => s.role === role) || null;
      };
    }

    return site;
  }

  private getLocalSiteUrl(site: any): string {
    // Local sites typically use .local domain
    const domain = site.domain || site.name?.replace(/\s+/g, '-').toLowerCase() + '.local';
    return `http://${domain}`;
  }

  private getTempDir(siteId: string): string {
    const os = require('os');
    return path.join(os.tmpdir(), 'wp-sync', siteId);
  }

  /**
   * Download a file from the remote server using the export token.
   * When expectedSize is provided, the file on disk is verified against it —
   * a proxy or dying PHP worker can end the stream cleanly mid-transfer,
   * which otherwise looks like a successful download (truncated SQL imports
   * as an empty database). Retries up to 3 times on mismatch.
   */
  private async downloadToFile(
    client: WPSyncApiClient,
    token: string,
    destPath: string,
    part?: number,
    expectedSize?: number
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await client.download(token, part);
      const writer = fs.createWriteStream(destPath);

      await new Promise<void>((resolve, reject) => {
        response.data.on('error', reject);
        response.data.pipe(writer);
        writer.on('finish', () => resolve());
        writer.on('error', reject);
      });

      const actualSize = fs.statSync(destPath).size;
      if (expectedSize === undefined || actualSize === expectedSize) {
        wpSyncLog('info', `Downloaded ${destPath}: ${actualSize} bytes${part !== undefined ? ` (part ${part})` : ''}`);
        return;
      }

      wpSyncLog(
        'error',
        `Download truncated (attempt ${attempt}/${MAX_ATTEMPTS}): got ${actualSize} of ${expectedSize} bytes for token ${token}${part !== undefined ? ` part ${part}` : ''}`
      );
    }

    throw new Error(
      `Download kept arriving truncated after ${MAX_ATTEMPTS} attempts (expected ${expectedSize} bytes). ` +
      `The server is cutting large responses — make sure the wp-sync-companion plugin on the live site is v1.1.2+ ` +
      `(chunked streaming) and check the hosting/proxy response limits.`
    );
  }

  /**
   * Download all parts of a file export into tempDir and return their paths.
   * Companion plugin ≥1.1 splits file exports into ~100 MB ZIP parts; older
   * plugins return a single archive (no `parts` field).
   */
  private async downloadFileParts(
    client: WPSyncApiClient,
    filesExport: FilesExportResult,
    tempDir: string,
    onProgress: ProgressCallback,
    percentStart: number,
    percentEnd: number
  ): Promise<string[]> {
    const partCount = filesExport.parts?.length ?? 0;

    if (partCount === 0) {
      onProgress({
        stage: 'downloading-files',
        percent: percentStart,
        message: `Downloading files (${formatBytes(filesExport.size)})...`,
      });
      const singlePath = path.join(tempDir, 'files.zip');
      await this.downloadToFile(client, filesExport.token, singlePath, undefined, filesExport.size);
      return [singlePath];
    }

    const partPaths: string[] = [];
    for (let i = 0; i < partCount; i++) {
      const percent = Math.round(percentStart + ((percentEnd - percentStart) * i) / partCount);
      onProgress({
        stage: 'downloading-files',
        percent,
        message: `Downloading files (part ${i + 1}/${partCount}, ${formatBytes(filesExport.parts![i].size)})...`,
      });
      const partPath = path.join(tempDir, `files-part-${i}.zip`);
      await this.downloadToFile(client, filesExport.token, partPath, i, filesExport.parts![i].size);
      partPaths.push(partPath);
    }
    return partPaths;
  }

  /**
   * Extract a ZIP archive into the site directory.
   */
  private async extractFiles(zipPath: string, destPath: string): Promise<number> {
    const decompress = require('decompress');

    // Ensure existing files are writable so decompress can overwrite them
    if (fs.existsSync(destPath)) {
      execSync(`chmod -R u+w "${destPath}"`, { stdio: 'ignore' });
    }

    const files = await decompress(zipPath, destPath);
    return files.length;
  }

  /**
   * Resolve MySQL binary paths, socket, and credentials for a Local site.
   * Derives the mysqldump/mysql binary from the site's services config,
   * avoiding any dependency on WP-CLI or LightningServicesService.
   */
  private getMysqlConfig(site: any) {
    const userData = require('electron').app.getPath('userData');
    const os = require('os');
    const services: Record<string, any> = site.services || {};

    // Find the mysql or mariadb service entry
    const dbEntry = Object.values(services).find(
      (s: any) => s.name === 'mysql' || s.name === 'mariadb'
    ) as any;

    if (!dbEntry) throw new Error('No MySQL/MariaDB service found for this site.');

    // Map platform/arch to the directory name Local uses
    const platformMap: Record<string, string> = {
      darwin: os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin',
      linux:  'linux',
      win32:  'win32',
    };
    const platformDir = platformMap[process.platform] || process.platform;

    // The services version may omit the build suffix (e.g. "8.0.35" vs dir "mysql-8.0.35+4").
    // Glob for the actual installed directory that starts with name-version.
    const servicesBase = path.join(userData, 'lightning-services');
    const prefix = `${dbEntry.name}-${dbEntry.version}`;
    const entries = fs.readdirSync(servicesBase).filter((d: string) => d.startsWith(prefix));
    if (!entries.length) throw new Error(`MySQL lightning service not found: ${prefix}`);
    // Prefer the highest build number if multiple exist
    entries.sort();
    const serviceDir = entries[entries.length - 1];

    const binDir = path.join(servicesBase, serviceDir, 'bin', platformDir, 'bin');

    return {
      mysqlBin:     path.join(binDir, 'mysql'),
      mysqldumpBin: path.join(binDir, 'mysqldump'),
      socket: path.join(userData, 'run', site.id, 'mysql', 'mysqld.sock'),
      dbName: site.mysql?.database || 'local',
      dbUser: site.mysql?.user     || 'root',
      dbPass: site.mysql?.password || 'root',
    };
  }

  /** Filter mysqldump/mysql warnings that are safe to ignore. */
  private isMysqlWarning(line: string): boolean {
    return (
      line.includes('Using a password on the command line interface can be insecure') ||
      line.startsWith('mysqldump: [Warning]') ||
      line.startsWith('mysql: [Warning]') ||
      line.trim() === ''
    );
  }

  /**
   * Import a SQL file directly via Local's MySQL binary (bypasses WP-CLI).
   * Verifies afterwards that tables actually exist — a truncated or empty
   * SQL file otherwise imports "successfully" and only fails much later.
   */
  private async importDatabase(site: any, sqlPath: string): Promise<void> {
    const { spawn } = require('child_process');
    const { mysqlBin, socket, dbName, dbUser, dbPass } = this.getMysqlConfig(site);

    const sqlSize = fs.existsSync(sqlPath) ? fs.statSync(sqlPath).size : 0;
    wpSyncLog('info', `Importing database: ${sqlPath} (${sqlSize} bytes) into ${dbName}`);
    if (sqlSize < 1024) {
      throw new Error(`Database dump looks empty (${sqlSize} bytes) — aborting import.`);
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(mysqlBin, [`-u${dbUser}`, `-p${dbPass}`, `--socket=${socket}`, dbName]);

      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        const realErrors = stderr.split('\n').filter((l: string) => !this.isMysqlWarning(l));
        if (code !== 0 && realErrors.length > 0) {
          reject(new Error(realErrors.join('\n')));
        } else {
          resolve();
        }
      });
      child.on('error', (err: Error) => reject(err));

      fs.createReadStream(sqlPath).pipe(child.stdin);
    });

    // Verify the import actually created tables
    const tableCount = await this.countTables(site);
    wpSyncLog('info', `Database import finished: ${tableCount} tables present`);
    if (tableCount === 0) {
      throw new Error('Database import completed but no tables exist — the SQL dump was likely truncated.');
    }
  }

  /**
   * Count tables in the site's database via Local's MySQL binary.
   */
  private async countTables(site: any): Promise<number> {
    const { spawn } = require('child_process');
    const { mysqlBin, socket, dbName, dbUser, dbPass } = this.getMysqlConfig(site);

    return new Promise<number>((resolve, reject) => {
      const child = spawn(mysqlBin, [
        `-u${dbUser}`, `-p${dbPass}`, `--socket=${socket}`, '-N', '-e', 'SHOW TABLES', dbName,
      ]);

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        const realErrors = stderr.split('\n').filter((l: string) => !this.isMysqlWarning(l));
        if (code !== 0 && realErrors.length > 0) {
          reject(new Error(realErrors.join('\n')));
        } else {
          resolve(stdout.split('\n').filter((l) => l.trim() !== '').length);
        }
      });
      child.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Export the Local site's database directly via mysqldump (bypasses WP-CLI).
   */
  private async exportLocalDatabase(site: any, destPath: string): Promise<void> {
    const { spawn } = require('child_process');
    const { mysqldumpBin, socket, dbName, dbUser, dbPass } = this.getMysqlConfig(site);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(mysqldumpBin, [
        `-u${dbUser}`, `-p${dbPass}`, `--socket=${socket}`, '--single-transaction', dbName,
      ]);
      const out = fs.createWriteStream(destPath);
      child.stdout.pipe(out);

      let stderr = '';
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      child.on('close', (code: number) => {
        const realErrors = stderr.split('\n').filter((l: string) => !this.isMysqlWarning(l));
        if (code !== 0 && realErrors.length > 0) {
          reject(new Error(realErrors.join('\n')));
        } else {
          resolve();
        }
      });
      child.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Run WP-CLI search-replace to rewrite URLs using Local's WpCliService.
   */
  private async searchReplaceUrls(site: any, fromUrl: string, toUrl: string): Promise<void> {
    const from = fromUrl.replace(/\/+$/, '');
    const to = toUrl.replace(/\/+$/, '');

    await this.runWpCli(site, ['search-replace', from, to, '--all-tables']);

    // Also handle https↔http variants
    const fromHttps = from.replace('http://', 'https://');
    if (fromHttps !== from) {
      await this.runWpCli(site, ['search-replace', fromHttps, to, '--all-tables']);
    }
  }

  /**
   * Poll for the MySQL socket file so we don't attempt db import before MySQL is ready.
   * Local stores sockets at {userData}/run/{siteId}/mysql/mysqld.sock
   */
  private async waitForMySqlReady(site: any, timeoutMs = 60000): Promise<void> {
    const userData = require('electron').app.getPath('userData');
    const socketPath = path.join(userData, 'run', site.id, 'mysql', 'mysqld.sock');
    const interval = 1000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (fs.existsSync(socketPath)) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error(
      `MySQL did not become ready within ${timeoutMs / 1000}s. ` +
      `Socket not found at: ${socketPath}`
    );
  }

  /**
   * Run a WP-CLI command via Local's built-in WpCliService (serviceContainer.wpCli).
   * This handles PHP binary resolution, MySQL env vars, and port configs automatically.
   */
  private async runWpCli(site: any, args: string[]): Promise<void> {
    const wpCli = this.serviceContainer?.wpCli;
    if (!wpCli?.run) {
      throw new Error(
        `Could not resolve 'wpCli' from Local's service container. ` +
        `Make sure the site is running before importing the database.`
      );
    }
    await wpCli.run(site, args, { skipPlugins: false, skipThemes: false });
  }

  /**
   * Rewrite URLs directly in a SQL file (for push operations).
   */
  private rewriteSqlUrls(sqlPath: string, fromUrl: string, toUrl: string): void {
    let sql = fs.readFileSync(sqlPath, 'utf8');
    const from = fromUrl.replace(/\/+$/, '');
    const to = toUrl.replace(/\/+$/, '');

    // Simple string replacement for non-serialized data
    sql = sql.replace(new RegExp(escapeRegex(from), 'g'), to);
    fs.writeFileSync(sqlPath, sql, 'utf8');
  }

  /**
   * Package site files into a ZIP archive.
   */
  private async packageFiles(sitePath: string, zipPath: string): Promise<number> {
    const archiver = require('archiver');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    return new Promise((resolve, reject) => {
      let count = 0;
      archive.on('entry', () => count++);
      output.on('close', () => resolve(count));
      archive.on('error', reject);

      archive.pipe(output);
      archive.directory(sitePath, false);
      archive.finalize();
    });
  }

  private cleanupTemp(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Non-critical
    }
  }
}

// ─── Utility ───
function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
