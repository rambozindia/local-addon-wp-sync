import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { SiteConnection, RemoteSiteInfo } from './types';

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
        'User-Agent': 'LocalWP-Sync-Addon/1.0',
      },
    });

    // Intercept errors to surface the server's own error message instead of generic Axios messages
    this.client.interceptors.response.use(
      (r) => r,
      (err) => {
        const serverMsg = err?.response?.data?.error || err?.response?.data?.message;
        if (serverMsg) err.message = serverMsg;
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
   * Trigger a database export on the remote server.
   * Returns a download token to fetch the SQL file.
   */
  async exportDatabase(): Promise<{ token: string; size: number; filename: string }> {
    const response = await this.client.post('/export/database');
    return response.data;
  }

  /**
   * Download the exported database SQL file as a stream.
   */
  async downloadDatabase(token: string): Promise<AxiosResponse> {
    return this.client.get(`/download/${token}`, {
      responseType: 'stream',
    });
  }

  /**
   * Trigger a file export (zip archive) on the remote server.
   * @param scope - 'full' | 'wp-content' | 'themes' | 'plugins' | 'uploads'
   */
  async exportFiles(scope: string = 'full'): Promise<{ token: string; size: number; filename: string }> {
    const response = await this.client.post('/export/files', { scope });
    return response.data;
  }

  /**
   * Download the exported files archive as a stream.
   */
  async downloadFiles(token: string): Promise<AxiosResponse> {
    return this.client.get(`/download/${token}`, {
      responseType: 'stream',
      timeout: 600000, // 10 min for large file archives
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
   * Clean up temporary export files on the remote server.
   */
  async cleanup(token: string): Promise<void> {
    await this.client.delete(`/cleanup/${token}`).catch(() => {
      // Non-critical, ignore cleanup failures
    });
  }
}
