import * as React from 'react';

interface Props {
  onPull: () => void;
  onPush: () => void;
  onDisconnect: () => void;
  siteName: string;
  remoteUrl: string;
}

export const SyncControls: React.FC<Props> = ({
  onPull,
  onPush,
  onDisconnect,
  siteName,
  remoteUrl,
}) => {
  const [confirmAction, setConfirmAction] = React.useState<'pull' | 'push' | null>(null);

  const handleConfirm = () => {
    if (confirmAction === 'pull') onPull();
    if (confirmAction === 'push') onPush();
    setConfirmAction(null);
  };

  return (
    <div className="wps-sync-controls">
      {/* Pull Section */}
      <div className="wps-sync-card wps-sync-pull">
        <div className="wps-sync-card-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 19V5M12 19L5 12M12 19L19 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h3>Pull from Live</h3>
        </div>
        <p className="wps-sync-desc">
          Download the full site from <strong>{remoteUrl}</strong> and replace
          the local <strong>{siteName}</strong> site. This overwrites local files and database.
        </p>
        <button
          className="wps-btn wps-btn-pull"
          onClick={() => setConfirmAction('pull')}
        >
          ↓ Pull to Local
        </button>
      </div>

      {/* Push Section */}
      <div className="wps-sync-card wps-sync-push">
        <div className="wps-sync-card-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 5V19M12 5L5 12M12 5L19 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <h3>Push to Live</h3>
        </div>
        <p className="wps-sync-desc">
          Upload the local <strong>{siteName}</strong> site to <strong>{remoteUrl}</strong>.
          This overwrites the live site's files and database.
        </p>
        <button
          className="wps-btn wps-btn-push"
          onClick={() => setConfirmAction('push')}
        >
          ↑ Push to Live
        </button>
      </div>

      {/* Disconnect */}
      <button className="wps-link-btn wps-disconnect" onClick={onDisconnect}>
        Disconnect from live site
      </button>

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="wps-modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="wps-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="wps-modal-title">
              {confirmAction === 'pull' ? '⚠ Confirm Pull' : '⚠ Confirm Push'}
            </h3>
            <p className="wps-modal-body">
              {confirmAction === 'pull' ? (
                <>
                  This will <strong>overwrite all local files and the database</strong> for{' '}
                  <em>{siteName}</em> with the live site content from{' '}
                  <em>{remoteUrl}</em>.
                </>
              ) : (
                <>
                  This will <strong>overwrite the live site's files and database</strong> at{' '}
                  <em>{remoteUrl}</em> with the local site content. Make sure you
                  have a backup of your live site.
                </>
              )}
            </p>
            <div className="wps-modal-actions">
              <button
                className="wps-btn wps-btn-secondary"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
              <button
                className={`wps-btn ${
                  confirmAction === 'pull' ? 'wps-btn-pull' : 'wps-btn-push'
                }`}
                onClick={handleConfirm}
              >
                {confirmAction === 'pull'
                  ? 'Yes, Pull from Live'
                  : 'Yes, Push to Live'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
