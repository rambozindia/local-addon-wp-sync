/**
 * Connection configuration for a live WordPress site.
 * Uses WordPress Application Passwords for REST API auth.
 */
export interface SiteConnection {
  /** Live site URL (e.g., https://example.com) */
  siteUrl: string;
  /** WordPress username */
  username: string;
  /** WordPress Application Password (not the regular password) */
  applicationPassword: string;
  /** Optional: custom REST API prefix (default: /wp-json) */
  restPrefix?: string;
}

/**
 * Progress updates sent during sync operations.
 */
export interface SyncProgress {
  stage: SyncStage;
  percent: number;
  message: string;
}

export type SyncStage =
  | 'connecting'
  | 'exporting-db'
  | 'downloading-db'
  | 'exporting-files'
  | 'downloading-files'
  | 'importing-db'
  | 'extracting-files'
  | 'rewriting-urls'
  | 'uploading-files'
  | 'uploading-db'
  | 'importing-remote-db'
  | 'creating-site'
  | 'cleanup'
  | 'complete'
  | 'error';

/**
 * Information about the remote WordPress site.
 */
export interface RemoteSiteInfo {
  name: string;
  url: string;
  wpVersion: string;
  phpVersion: string;
  activeTheme: string;
  plugins: RemotePlugin[];
  dbPrefix: string;
  isMultisite: boolean;
  diskUsage?: {
    uploads: string;
    themes: string;
    plugins: string;
    total: string;
  };
}

export interface RemotePlugin {
  name: string;
  slug: string;
  version: string;
  active: boolean;
}

/**
 * Result of a pull/push operation.
 */
export interface SyncResult {
  success: boolean;
  filesTransferred: number;
  dbImported: boolean;
  duration: number;
  warnings: string[];
}
