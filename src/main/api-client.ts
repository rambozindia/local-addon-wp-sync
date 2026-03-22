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
   */
  async uploadDatabase(sqlFilePath: string): Promise<{ success: boolean; tables: number }> {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('database', fs.createReadStream(sqlFilePath));

    const response = await this.client.post('/import/database', form, {
      headers: form.getHeaders(),
      timeout: 600000,
    });
    return response.data;
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
