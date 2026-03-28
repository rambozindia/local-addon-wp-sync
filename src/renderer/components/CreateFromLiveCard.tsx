import * as React from 'react';
import { IPC_EVENTS } from '../../main/ipc-events';
import '../styles.css';

const { ipcRenderer } = require('electron');

/**
 * Renders a "Pull from Live" button in the sites sidebar
 * (hooked via SitesSidebar_SitesSidebarSites).
 * Clicking it opens a modal that collects credentials + site name
 * and drives the CREATE_SITE_FROM_LIVE flow.
 */
export const CreateFromLiveCard: React.FC = () => {
  const [open, setOpen] = React.useState(false);

  // Form fields
  const [siteName, setSiteName] = React.useState('');
  const [siteUrl, setSiteUrl] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [appPassword, setAppPassword] = React.useState('');

  // Flow state
  const [step, setStep] = React.useState<'form' | 'progress' | 'done' | 'error'>('form');
  const [progress, setProgress] = React.useState({ percent: 0, message: '' });
  const [errorMsg, setErrorMsg] = React.useState('');

  const canSubmit = siteName.trim() && siteUrl.trim() && username.trim() && appPassword.trim();

  const handleOpen = () => {
    setStep('form');
    setSiteName('');
    setSiteUrl('');
    setUsername('');
    setAppPassword('');
    setErrorMsg('');
    setOpen(true);
  };

  const handleClose = () => {
    if (step === 'progress') return;
    setOpen(false);
  };

  React.useEffect(() => {
    const handler = (_event: any, data: any) => {
      if (step !== 'progress') return;
      setProgress({ percent: data.percent, message: data.message });
      if (data.stage === 'complete') setStep('done');
      if (data.stage === 'error') {
        setErrorMsg(data.message);
        setStep('error');
      }
    };
    ipcRenderer.on(IPC_EVENTS.SYNC_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_EVENTS.SYNC_PROGRESS, handler);
  }, [step]);

  const handleCreate = async () => {
    if (!canSubmit) return;
    setStep('progress');
    setProgress({ percent: 0, message: 'Starting…' });

    try {
      const result = await ipcRenderer.invoke(IPC_EVENTS.CREATE_SITE_FROM_LIVE, {
        connection: {
          siteUrl: siteUrl.replace(/\/+$/, ''),
          username,
          applicationPassword: appPassword,
        },
        newSiteName: siteName.trim(),
      });

      if (!result.success) {
        setErrorMsg(result.error || 'Site creation failed.');
        setStep('error');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Unexpected error.');
      setStep('error');
    }
  };

  return (
    <>
      {/* ── Sidebar button ── */}
      <div
        className="wps-sidebar-btn"
        onClick={handleOpen}
        title="Pull from Live Site"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '8px 12px',
          background: 'rgba(124, 92, 191, 0.15)',
          border: '1px solid rgba(124, 92, 191, 0.4)',
          borderRadius: '6px',
          color: '#b39ddb',
          fontSize: '12px',
          fontWeight: 500,
          cursor: 'pointer',
          boxSizing: 'border-box',
          marginTop: '8px',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 16V8M12 16L9 13M12 16L15 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>Pull from Live</span>
      </div>

      {/* ── Modal overlay ── */}
      {open && (
        <div
          className="wps-cfl-overlay"
          onClick={handleClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
          }}
        >
          <div
            className="wps-cfl-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1e1e2e',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: '14px',
              padding: '32px',
              width: '480px',
              maxWidth: '95vw',
              maxHeight: '90vh',
              overflowY: 'auto',
              color: '#c2c2c2',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            }}
          >

            <div className="wps-cfl-header">
              <h2 className="wps-cfl-title">Pull from Live Site</h2>
              {step !== 'progress' && (
                <button className="wps-cfl-close" onClick={handleClose}>×</button>
              )}
            </div>

            {step === 'form' && (
              <>
                <p className="wps-cfl-subtitle">
                  Creates a brand-new Local site by downloading a live WordPress
                  site's files and database. Requires the{' '}
                  <em>WP Sync Companion</em> plugin on your live site.
                </p>

                <div className="wps-field">
                  <label className="wps-label">New Site Name</label>
                  <input
                    className="wps-input"
                    type="text"
                    placeholder="e.g. My Project Local"
                    value={siteName}
                    onChange={(e) => setSiteName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div className="wps-field">
                  <label className="wps-label">Live Site URL</label>
                  <input
                    className="wps-input"
                    type="url"
                    placeholder="https://yoursite.com"
                    value={siteUrl}
                    onChange={(e) => setSiteUrl(e.target.value)}
                  />
                </div>

                <div className="wps-field">
                  <label className="wps-label">WordPress Username</label>
                  <input
                    className="wps-input"
                    type="text"
                    placeholder="admin"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>

                <div className="wps-field">
                  <label className="wps-label">Application Password</label>
                  <input
                    className="wps-input"
                    type="password"
                    placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                    value={appPassword}
                    onChange={(e) => setAppPassword(e.target.value)}
                  />
                  <span className="wps-hint">
                    Generate under Users → Profile → Application Passwords
                  </span>
                </div>

                <div className="wps-cfl-actions">
                  <button className="wps-btn wps-btn-secondary" onClick={handleClose}>
                    Cancel
                  </button>
                  <button
                    className="wps-btn wps-btn-create"
                    onClick={handleCreate}
                    disabled={!canSubmit}
                  >
                    Create Site from Live
                  </button>
                </div>
              </>
            )}

            {step === 'progress' && (
              <div className="wps-cfl-progress">
                <div className="wps-progress-bar-container">
                  <div className="wps-progress-bar" style={{ width: `${progress.percent}%` }} />
                </div>
                <p className="wps-progress-message">{progress.message}</p>
                <p className="wps-cfl-hint">Do not close this window.</p>
              </div>
            )}

            {step === 'done' && (
              <div className="wps-cfl-result">
                <div className="wps-cfl-success-icon">✓</div>
                <h3>Site Created!</h3>
                <p>
                  <strong>{siteName}</strong> is ready in your Local sites list.
                </p>
                <button className="wps-btn wps-btn-primary" onClick={handleClose}>
                  Done
                </button>
              </div>
            )}

            {step === 'error' && (
              <div className="wps-cfl-result">
                <div className="wps-error wps-cfl-error-box">
                  <span className="wps-error-icon">⚠</span>
                  <span>{errorMsg}</span>
                </div>
                <div className="wps-cfl-actions">
                  <button className="wps-btn wps-btn-secondary" onClick={() => setStep('form')}>
                    Try Again
                  </button>
                  <button className="wps-btn wps-btn-secondary" onClick={handleClose}>
                    Close
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}
    </>
  );
};
