import * as path from 'path';
import * as fs from 'fs';
import { execSync, exec } from 'child_process';
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
    const files = await decompress(zipPath, destPath, { strip: 1 });
    return files.length;
  }

  /**
   * Import a SQL file into the Local site's database using WP-CLI.
   */
  private async importDatabase(site: any, sqlPath: string): Promise<void> {
    const wpCliPath = this.getWpCliPath();
    const sitePath = site.paths?.webRoot || site.path;

    execSync(`"${wpCliPath}" db import "${sqlPath}" --path="${sitePath}"`, {
      timeout: 120000,
      env: { ...process.env, ...this.getWpCliEnv(site) },
    });
  }

  /**
   * Export the Local site's database to a SQL file.
   */
  private async exportLocalDatabase(site: any, destPath: string): Promise<void> {
    const wpCliPath = this.getWpCliPath();
    const sitePath = site.paths?.webRoot || site.path;

    execSync(`"${wpCliPath}" db export "${destPath}" --path="${sitePath}"`, {
      timeout: 120000,
      env: { ...process.env, ...this.getWpCliEnv(site) },
    });
  }

  /**
   * Run WP-CLI search-replace to rewrite URLs.
   */
  private async searchReplaceUrls(site: any, fromUrl: string, toUrl: string): Promise<void> {
    const wpCliPath = this.getWpCliPath();
    const sitePath = site.paths?.webRoot || site.path;

    // Strip trailing slashes for consistent replacement
    const from = fromUrl.replace(/\/+$/, '');
    const to = toUrl.replace(/\/+$/, '');

    execSync(
      `"${wpCliPath}" search-replace "${from}" "${to}" --all-tables --path="${sitePath}"`,
      {
        timeout: 120000,
        env: { ...process.env, ...this.getWpCliEnv(site) },
      }
    );

    // Also handle https↔http variants
    const fromHttps = from.replace('http://', 'https://');
    const fromHttp = from.replace('https://', 'http://');
    if (fromHttps !== from) {
      execSync(
        `"${wpCliPath}" search-replace "${fromHttps}" "${to}" --all-tables --path="${sitePath}"`,
        { timeout: 120000, env: { ...process.env, ...this.getWpCliEnv(site) } }
      );
    }
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

  /**
   * Get the path to Local's bundled WP-CLI binary.
   */
  private getWpCliPath(): string {
    const wpCli = this.serviceContainer?.localWpCli;
    if (wpCli?.getPath) {
      return wpCli.getPath();
    }
    // Fallback paths
    const platform = process.platform;
    if (platform === 'darwin') {
      return '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp';
    } else if (platform === 'win32') {
      return 'C:\\Program Files (x86)\\Local\\resources\\extraResources\\bin\\wp-cli\\wp.exe';
    }
    return '/opt/Local/resources/extraResources/bin/wp-cli/wp';
  }

  /**
   * Get environment variables needed for WP-CLI to connect to Local's MySQL.
   */
  private getWpCliEnv(site: any): Record<string, string> {
    // Local manages MySQL per-site; WP-CLI reads wp-config.php
    return {
      WP_CLI_PHP: site.phpVersion
        ? this.getPhpBinaryPath(site.phpVersion)
        : '',
    };
  }

  private getPhpBinaryPath(version: string): string {
    // Local bundles PHP versions
    const platform = process.platform;
    if (platform === 'darwin') {
      return `/Applications/Local.app/Contents/Resources/extraResources/lightning-services/php-${version}+*/bin/php`;
    }
    return '';
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
