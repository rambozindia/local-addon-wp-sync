import * as LocalMain from '@getflywheel/local/main';
import { IPC_EVENTS } from './ipc-events';
import { SyncManager } from './sync-manager';
import { SiteConnection } from './types';

const serviceContainer = LocalMain.getServiceContainer().cradle;

/**
 * WP Live Sync - Main Process
 * 
 * Handles all Node.js-side operations:
 * - REST API communication with live WordPress sites
 * - File download/upload via companion plugin endpoints
 * - Database export/import via WP-CLI
 * - Local site creation and management
 */
export default function (context: any): void {
  const { electron } = context;
  const { ipcMain } = electron;

  // Store connections per site (persisted in Local's userData)
  const connectionsFile = require('path').join(
    require('electron').app.getPath('userData'),
    'wp-sync-connections.json'
  );

  const syncManager = new SyncManager(serviceContainer);

  // ─────────────────────────────────────────────
  // IPC: Test connection to a live WordPress site
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.TEST_CONNECTION,
    async (_event: any, connection: SiteConnection) => {
      try {
        const result = await syncManager.testConnection(connection);
        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Save connection config for a Local site
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.SAVE_CONNECTION,
    async (_event: any, { siteId, connection }: { siteId: string; connection: SiteConnection }) => {
      try {
        const connections = loadConnections(connectionsFile);
        connections[siteId] = connection;
        saveConnections(connectionsFile, connections);
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Load saved connection for a Local site
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.LOAD_CONNECTION,
    async (_event: any, siteId: string) => {
      try {
        const connections = loadConnections(connectionsFile);
        return { success: true, data: connections[siteId] || null };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Pull full site from live → Local
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.PULL_SITE,
    async (_event: any, { siteId, connection }: { siteId: string; connection: SiteConnection }) => {
      try {
        const result = await syncManager.pullSite(siteId, connection, (progress) => {
          _event.sender.send(IPC_EVENTS.SYNC_PROGRESS, { siteId, ...progress });
        });
        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Push Local site → live
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.PUSH_SITE,
    async (_event: any, { siteId, connection }: { siteId: string; connection: SiteConnection }) => {
      try {
        const result = await syncManager.pushSite(siteId, connection, (progress) => {
          _event.sender.send(IPC_EVENTS.SYNC_PROGRESS, { siteId, ...progress });
        });
        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Create a new Local site from live
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.CREATE_SITE_FROM_LIVE,
    async (_event: any, { connection, newSiteName }: { connection: SiteConnection; newSiteName: string }) => {
      try {
        const tempSiteId = `new-${Date.now()}`;
        const result = await syncManager.createSiteFromLive(connection, newSiteName, (progress) => {
          _event.sender.send(IPC_EVENTS.SYNC_PROGRESS, { siteId: tempSiteId, ...progress });
        });

        // Save the connection for the new site so WP Live Sync tab is pre-connected
        if (result.newSiteId) {
          const connections = loadConnections(connectionsFile);
          connections[result.newSiteId] = connection;
          saveConnections(connectionsFile, connections);
        }

        return { success: true, data: result };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );

  // ─────────────────────────────────────────────
  // IPC: Get remote site info (theme, plugins, etc.)
  // ─────────────────────────────────────────────
  ipcMain.handle(
    IPC_EVENTS.GET_REMOTE_INFO,
    async (_event: any, connection: SiteConnection) => {
      try {
        const info = await syncManager.getRemoteSiteInfo(connection);
        return { success: true, data: info };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
  );
}

// ─────────────────────────────────────────────
// Helpers: Connection persistence
// ─────────────────────────────────────────────
function loadConnections(filePath: string): Record<string, SiteConnection> {
  const fs = require('fs');
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    // Corrupted file, start fresh
  }
  return {};
}

function saveConnections(filePath: string, connections: Record<string, SiteConnection>): void {
  const fs = require('fs');
  fs.writeFileSync(filePath, JSON.stringify(connections, null, 2), 'utf8');
}
