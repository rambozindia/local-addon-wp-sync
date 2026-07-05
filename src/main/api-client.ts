import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { SiteConnection, RemoteSiteInfo } from './types';
import { wpSyncLog } from './logger';

export interface DatabaseExportResult {
  token: string;
  size: number;
  filename: string;
}

export interface FilesExportResult {
  token: string;
  size: number;
  filename: string;
  files?: number;
  /** Present when the companion plugin (≥1.1) produced a multi-part export. */
  parts?: { filename: string; size: number }[];
}

/**
 * REST API client for the WP Sync Companion plugin.
 * Communicates with the live WordPress site's custom REST endpoints.
 */
export class WPSyncApiClient {
  private client: AxiosInstance;
  private connection: SiteConnection;

  constructor(connection: SiteConnection) {
    this.connection = connection;
    const restPrefix = connection.restPrefix || '/wp-json';
    const baseURL = `${connection.siteUrl.replace(/\/+$/, '')}${restPrefix}/wp-sync/v1`;

    this.client = axios.create({
      baseURL,
      timeout: 300000, // 5 min timeout for large exports
      auth: {
        username: connection.username,
        password: connection.applicationPassword,
      },
      headers: {
        'User-Agent': 'LocalWP-Sync-Addon/1.2',
      },
    });

    // Trace every request so failures can be pinpointed in the log
    this.client.interceptors.request.use((config) => {
      wpSyncLog('debug', `API → ${(config.method || 'get').toUpperCase()} ${config.url}`);
      return config;
    });

    // Intercept errors to surface the server's own error message instead of generic Axios messages
    this.client.interceptors.response.use(
      (r) => r,
      (err) => {
        const res = err?.response;
        const serverMsg = res?.data?.error || res?.data?.message;

        if (serverMsg) {
          err.message = serverMsg;
        } else if (res) {
          // No structured error (e.g. a PHP fatal returned as HTML) — include
          // the endpoint and a readable snippet of the body in the message.
          let body = '';
          if (typeof res.data === 'string') {
            body = res.data;
          } else if (res.data && typeof res.data === 'object' && typeof res.data.pipe !== 'function') {
            try { body = JSON.stringify(res.data); } catch { /* ignore */ }
          }
          body = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          const endpoint = `${(err.config?.method || 'get').toUpperCase()} ${err.config?.url}`;
          err.message = `HTTP ${res.status} from ${endpoint}${body ? ` — ${body}` : ''}`;
        }

        wpSyncLog('error', `API ✗ ${(err.config?.method || 'get').toUpperCase()} ${err.config?.url}: ${err.message}`);
        return Promise.reject(err);
      }
    );
  }

  /**
   * Test connectivity and verify the companion plugin is installed.
   */
  async testConnection(): Promise<{ connected: boolean; pluginVersion: string; wpVersion: string }> {
    const response = await this.client.get('/status');
    return response.data;
  }

  /**
   * Get detailed info about the remote WordPress installation.
   */
  async getSiteInfo(): Promise<RemoteSiteInfo> {
    const response = await this.client.get('/site-info');
    return response.data;
  }

  /**
   * Export the remote database using stepped requests: each request does a
   * bounded slice of work on the server (~15s) so responses never trip proxy
   * timeouts (Cloudflare returns 524 after ~100s). Loops until complete.
   * Returns a download token to fetch the SQL file.
   */
  async exportDatabase(onStep?: (progress: string) => void): Promise<DatabaseExportResult> {
    let token: string | undefined;

    while (true) {
      const body: Record<string, any> = { stepped: 1 };
      if (token) body.token = token;

      const response = await this.client.post('/export/database', body, { timeout: 120000 });
      const data = response.data;

      // Old companion plugin (<1.1) ignores `stepped` and exports in one shot
      if (data.complete === undefined || data.complete) {
        return data;
      }

      token = data.token;
      if (onStep && data.progress) {
        onStep(`${data.progress.tables_done}/${data.progress.tables_total} tables`);
      }
    }
  }

  /**
   * Export remote files using the same stepped protocol as exportDatabase.
   * The companion plugin (≥1.1) produces one ZIP part per step (~100 MB each);
   * the result's `parts` array lists them for download via `download(token, part)`.
   * @param scope - 'full' | 'wp-content' | 'themes' | 'plugins' | 'uploads'
   */
  async exportFiles(scope: string = 'full', onStep?: (progress: string) => void): Promise<FilesExportResult> {
    let token: string | undefined;

    while (true) {
      const body: Record<string, any> = { scope, stepped: 1 };
      if (token) body.token = token;

      const response = await this.client.post('/export/files', body, { timeout: 120000 });
      const data = response.data;

      if (data.complete === undefined || data.complete) {
        return data;
      }

      token = data.token;
      if (onStep && data.progress) {
        onStep(`${data.progress.files_done} files archived`);
      }
    }
  }

  /**
   * Download an exported file as a stream.
   * @param part - part index for multi-part file exports (plugin ≥1.1)
   */
  async download(token: string, part?: number): Promise<AxiosResponse> {
    return this.client.get(`/download/${token}`, {
      responseType: 'stream',
      timeout: 1800000, // 30 min — exports can be hundreds of MB on slow links
      params: part !== undefined ? { part } : undefined,
      // Disable compression so proxies keep Content-Length and truncated
      // transfers are detectable by size comparison.
      headers: { 'Accept-Encoding': 'identity' },
    });
  }

  /**
   * Upload a database SQL file to the remote server for import.
   * Automatically uses chunked upload for files > CHUNK_THRESHOLD to work
   * around PHP upload_max_filesize limits on shared hosting.
   */
  async uploadDatabase(sqlFilePath: string): Promise<{ success: boolean; tables: number }> {
    const fs = require('fs');
    const CHUNK_THRESHOLD = 8 * 1024 * 1024; // 8 MB — safe for most default PHP configs
    const fileSize = fs.statSync(sqlFilePath).size;

    if (fileSize > CHUNK_THRESHOLD) {
      return this.uploadDatabaseChunked(sqlFilePath);
    }

    const FormData = require('form-data');
    const form = new FormData();
    form.append('database', fs.createReadStream(sqlFilePath), {
      filename: 'database.sql',
      contentType: 'application/sql',
      knownLength: fileSize,
    });

    const response = await this.client.post('/import/database', form, {
      headers: form.getHeaders(),
      timeout: 600000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return response.data;
  }

  /**
   * Upload a database SQL file in chunks to work around PHP upload size limits.
   * Each chunk is ≤ 8 MB so it fits within even the most restrictive shared hosting.
   */
  private async uploadDatabaseChunked(sqlFilePath: string): Promise<{ success: boolean; tables: number }> {
    const fs = require('fs');
    const FormData = require('form-data');
    const crypto = require('crypto');

    const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB per chunk
    const fileSize = fs.statSync(sqlFilePath).size;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const uploadId = crypto.randomBytes(8).toString('hex');

    let lastResponse: any = null;
    const fd = fs.openSync(sqlFilePath, 'r');

    try {
      for (let i = 0; i < totalChunks; i++) {
        const offset = i * CHUNK_SIZE;
        const length = Math.min(CHUNK_SIZE, fileSize - offset);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, offset);

        const form = new FormData();
        form.append('upload_id', uploadId);
        form.append('chunk_index', String(i));
        form.append('total_chunks', String(totalChunks));
        form.append('chunk', buffer, {
          filename: `chunk-${i}.sql`,
          contentType: 'application/octet-stream',
          knownLength: length,
        });

        const response = await this.client.post('/import/database/chunk', form, {
          headers: form.getHeaders(),
          timeout: 120000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        lastResponse = response.data;
      }
    } finally {
      fs.closeSync(fd);
    }

    return lastResponse;
  }

  /**
   * Upload a files archive to the remote server for extraction.
   */
  async uploadFiles(zipFilePath: string, scope: string = 'full'): Promise<{ success: boolean; filesCount: number }> {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('files', fs.createReadStream(zipFilePath));
    form.append('scope', scope);

    const response = await this.client.post('/import/files', form, {
      headers: form.getHeaders(),
      timeout: 900000, // 15 min for large uploads
    });
    return response.data;
  }

  /**
   * Fetch the tail of the companion plugin's log file (plugin ≥1.1.1).
   * Returns an empty string on older plugins or if the request fails.
   */
  async getRemoteLog(): Promise<string> {
    try {
      const response = await this.client.get('/log', { timeout: 30000 });
      return response.data?.log || '';
    } catch {
      return '';
    }
  }

  /**
   * Clean up temporary export files on the remote server.
   */
  async cleanup(token: string): Promise<void> {
    await this.client.delete(`/cleanup/${token}`).catch(() => {
      // Non-critical, ignore cleanup failures
    });
  }
}
