import * as React from 'react';
import { ConnectionForm } from './ConnectionForm';
import { SyncControls } from './SyncControls';
import { SiteInfoCard } from './SiteInfoCard';
import { IPC_EVENTS } from '../../main/ipc-events';
import '../styles.css';

const { ipcRenderer } = require('electron');

interface SiteConnection {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  restPrefix?: string;
}

interface Props {
  site: any;
}

type ViewState = 'connect' | 'connected' | 'syncing';

export const WPSyncPanel: React.FC<Props> = ({ site }) => {
  const [view, setView] = React.useState<ViewState>('connect');
  const [connection, setConnection] = React.useState<SiteConnection | null>(null);
  const [remoteInfo, setRemoteInfo] = React.useState<any>(null);
  const [syncProgress, setSyncProgress] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Load saved connection on mount
  React.useEffect(() => {
    loadSavedConnection();

    // Listen for sync progress events
    const handler = (_event: any, data: any) => {
      if (data.siteId === site.id) {
        setSyncProgress(data);
        if (data.stage === 'complete') {
          setTimeout(() => {
            setSyncProgress(null);
            setView('connected');
          }, 2000);
        }
        if (data.stage === 'error') {
          setError(data.message);
          setTimeout(() => setSyncProgress(null), 3000);
        }
      }
    };

    ipcRenderer.on(IPC_EVENTS.SYNC_PROGRESS, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.SYNC_PROGRESS, handler);
    };
  }, [site.id]);

  const loadSavedConnection = async () => {
    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.LOAD_CONNECTION, site.id);
      if (result.success && result.data) {
        setConnection(result.data);
        setView('connected');
        // Fetch remote info in background
        fetchRemoteInfo(result.data);
      }
    } catch (err) {
      // No saved connection, show form
    }
    setLoading(false);
  };

  const fetchRemoteInfo = async (conn: SiteConnection) => {
    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.GET_REMOTE_INFO, conn);
      if (result.success) {
        setRemoteInfo(result.data);
      }
    } catch {
      // Non-critical, ignore
    }
  };

  const handleConnect = async (conn: SiteConnection) => {
    setError(null);
    try {
      // Test connection first
      const testResult = await ipcRenderer.invoke(IPC_EVENTS.TEST_CONNECTION, conn);
      if (!testResult.success) {
        setError(testResult.error || 'Connection failed. Verify the companion plugin is active.');
        return;
      }

      // Save connection
      await ipcRenderer.invoke(IPC_EVENTS.SAVE_CONNECTION, {
        siteId: site.id,
        connection: conn,
      });

      setConnection(conn);
      setView('connected');
      fetchRemoteInfo(conn);
    } catch (err: any) {
      setError(err.message || 'Connection failed');
    }
  };

  const handleDisconnect = async () => {
    setConnection(null);
    setRemoteInfo(null);
    setView('connect');
    setError(null);
  };

  const handlePull = async () => {
    if (!connection) return;
    setError(null);
    setView('syncing');
    setSyncProgress({ stage: 'connecting', percent: 0, message: 'Starting pull...' });

    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.PULL_SITE, {
        siteId: site.id,
        connection,
      });

      if (!result.success) {
        setError(result.error);
        setView('connected');
      }
    } catch (err: any) {
      setError(err.message);
      setView('connected');
    }
  };

  const handleCreateSite = async (newSiteName: string) => {
    if (!connection) return;
    setError(null);
    setView('syncing');
    setSyncProgress({ stage: 'connecting', percent: 0, message: 'Starting site creation...' });

    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.CREATE_SITE_FROM_LIVE, {
        connection,
        newSiteName,
      });

      if (!result.success) {
        setError(result.error);
        setView('connected');
      }
    } catch (err: any) {
      setError(err.message);
      setView('connected');
    }
  };

  const handlePush = async () => {
    if (!connection) return;
    setError(null);
    setView('syncing');
    setSyncProgress({ stage: 'connecting', percent: 0, message: 'Starting push...' });

    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.PUSH_SITE, {
        siteId: site.id,
        connection,
      });

      if (!result.success) {
        setError(result.error);
        setView('connected');
      }
    } catch (err: any) {
      setError(err.message);
      setView('connected');
    }
  };

  if (loading) {
    return (
      <div className="wps-panel">
        <div className="wps-loading">Loading...</div>
      </div>
    );
  }

  return (
    <div className="wps-panel">
      <div className="wps-header">
        <div className="wps-header-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div>
          <h2 className="wps-title">WP Live Sync</h2>
          <p className="wps-subtitle">
            {view === 'connect'
              ? 'Connect to your live WordPress site'
              : connection?.siteUrl}
          </p>
        </div>
      </div>

      {error && (
        <div className="wps-error">
          <span className="wps-error-icon">⚠</span>
          <span>{error}</span>
          <button className="wps-error-dismiss" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {view === 'connect' && (
        <ConnectionForm onConnect={handleConnect} />
      )}

      {view === 'connected' && connection && (
        <>
          {remoteInfo && <SiteInfoCard info={remoteInfo} />}
          <SyncControls
            onPull={handlePull}
            onPush={handlePush}
            onCreateSite={handleCreateSite}
            onDisconnect={handleDisconnect}
            siteName={site.name}
            remoteUrl={connection.siteUrl}
          />
        </>
      )}

      {view === 'syncing' && syncProgress && (
        <div className="wps-sync-progress">
          <div className="wps-progress-bar-container">
            <div
              className="wps-progress-bar"
              style={{ width: `${syncProgress.percent}%` }}
            />
          </div>
          <p className="wps-progress-message">{syncProgress.message}</p>
          <p className="wps-progress-stage">{syncProgress.stage}</p>
        </div>
      )}
    </div>
  );
};
