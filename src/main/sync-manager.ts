import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { WPSyncApiClient } from './api-client';
import { SiteConnection, SyncProgress, SyncResult, RemoteSiteInfo } from './types';

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

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      // ── Stage 1: Export database on remote ──
      onProgress({ stage: 'exporting-db', percent: 5, message: 'Requesting database export from live site...' });
      const dbExport = await client.exportDatabase();

      // ── Stage 2: Download database ──
      onProgress({ stage: 'downloading-db', percent: 15, message: `Downloading database (${formatBytes(dbExport.size)})...` });
      const dbPath = path.join(tempDir, 'database.sql');
      await this.downloadToFile(client, dbExport.token, dbPath);

      // ── Stage 3: Export files on remote ──
      onProgress({ stage: 'exporting-files', percent: 25, message: 'Requesting file archive from live site...' });
      const filesExport = await client.exportFiles('full');

      // ── Stage 4: Download files ──
      onProgress({ stage: 'downloading-files', percent: 40, message: `Downloading files (${formatBytes(filesExport.size)})...` });
      const filesPath = path.join(tempDir, 'files.zip');
      await this.downloadToFile(client, filesExport.token, filesPath);

      // ── Stage 5: Provision new Local site ──
      onProgress({ stage: 'creating-site', percent: 55, message: `Creating new Local site "${newSiteName}"...` });
      const newSite = await this.provisionNewSite(newSiteName);

      // ── Stage 6: Extract files into new site ──
      onProgress({ stage: 'extracting-files', percent: 65, message: 'Extracting files into new site...' });
      const sitePath = newSite.paths?.webRoot || newSite.path;
      if (fs.existsSync(sitePath)) {
        execSync(`chmod -R u+w "${sitePath}"`, { stdio: 'ignore' });
      }
      const filesCount = await this.extractFiles(filesPath, sitePath);

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

    try {
      // Ensure temp directory exists
      fs.mkdirSync(tempDir, { recursive: true });

      // ── Stage 1: Export database on remote ──
      onProgress({ stage: 'exporting-db', percent: 5, message: 'Requesting database export from live site...' });
      const dbExport = await client.exportDatabase();

      // ── Stage 2: Download database ──
      onProgress({ stage: 'downloading-db', percent: 15, message: `Downloading database (${formatBytes(dbExport.size)})...` });
      const dbPath = path.join(tempDir, 'database.sql');
      await this.downloadToFile(client, dbExport.token, dbPath);

      // ── Stage 3: Export files on remote ──
      onProgress({ stage: 'exporting-files', percent: 25, message: 'Requesting file archive from live site...' });
      const filesExport = await client.exportFiles('full');

      // ── Stage 4: Download files ──
      onProgress({ stage: 'downloading-files', percent: 35, message: `Downloading files (${formatBytes(filesExport.size)})...` });
      const filesPath = path.join(tempDir, 'files.zip');
      await this.downloadToFile(client, filesExport.token, filesPath);

      // ── Stage 5: Extract files into Local site ──
      onProgress({ stage: 'extracting-files', percent: 55, message: 'Extracting files into Local site...' });
      const sitePath = site.paths?.webRoot || site.path;
      const filesCount = await this.extractFiles(filesPath, sitePath);

      // ── Stage 6: Import database ──
      onProgress({ stage: 'importing-db', percent: 75, message: 'Importing database via WP-CLI...' });
      await this.importDatabase(site, dbPath);

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
      onProgress({ stage: 'error', percent: 0, message: error.message });
      this.cleanupTemp(tempDir);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════

  private getLocalSite(siteId: string): any {
    // Access Local's site data through the service container
    const siteData = this.serviceContainer?.siteData;
    if (siteData) {
      const site = siteData.getSite(siteId);
      if (site) return site;
    }
    throw new Error(`Local site with ID "${siteId}" not found.`);
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
   */
  private async downloadToFile(client: WPSyncApiClient, token: string, destPath: string): Promise<void> {
    const response = await client.downloadDatabase(token);
    const writer = fs.createWriteStream(destPath);

    return new Promise((resolve, reject) => {
      response.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
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
   * Import a SQL file directly via Local's MySQL binary (bypasses WP-CLI).
   * More reliable than `wp db import` for new sites without WordPress loaded.
   */
  private async importDatabase(site: any, sqlPath: string): Promise<void> {
    const { execFile } = require('child_process');
    const Local = require('@getflywheel/local');
    const lightningServices = this.serviceContainer?.lightningServices;
    const dbService = lightningServices?.getSiteServiceByRole(site, Local.SiteServiceRole.DATABASE);

    if (!dbService) {
      throw new Error('Could not get MySQL service for this site.');
    }

    // Resolve the mysql binary from the service's $PATH
    const mysqlBin = require('path').join(dbService.$PATH, 'mysql');
    const socket = path.join(
      require('electron').app.getPath('userData'),
      'run', site.id, 'mysql', 'mysqld.sock'
    );
    const dbName = site.mysql?.database || 'local';
    const dbUser = site.mysql?.user || 'root';
    const dbPass = site.mysql?.password || 'root';

    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        mysqlBin,
        [`-u${dbUser}`, `-p${dbPass}`, `--socket=${socket}`, dbName],
        (error: any, _stdout: string, stderr: string) => {
          if (error) reject(new Error(stderr || error.message));
          else resolve();
        }
      );
      fs.createReadStream(sqlPath).pipe(child.stdin);
    });
  }

  /**
   * Export the Local site's database to a SQL file using Local's WpCliService.
   */
  private async exportLocalDatabase(site: any, destPath: string): Promise<void> {
    await this.runWpCli(site, ['db', 'export', destPath]);
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
