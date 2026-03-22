import * as React from 'react';

interface Props {
  onConnect: (connection: {
    siteUrl: string;
    username: string;
    applicationPassword: string;
    restPrefix?: string;
  }) => void;
}

export const ConnectionForm: React.FC<Props> = ({ onConnect }) => {
  const [siteUrl, setSiteUrl] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [applicationPassword, setApplicationPassword] = React.useState('');
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [restPrefix, setRestPrefix] = React.useState('/wp-json');
  const [connecting, setConnecting] = React.useState(false);

  const handleSubmit = async () => {
    if (!siteUrl || !username || !applicationPassword) return;

    setConnecting(true);
    try {
      await onConnect({
        siteUrl: siteUrl.replace(/\/+$/, ''),
        username,
        applicationPassword,
        restPrefix: restPrefix || '/wp-json',
      });
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="wps-connection-form">
      <div className="wps-info-banner">
        <p>
          <strong>Requirements:</strong> Install the{' '}
          <em>WP Sync Companion</em> plugin on your live WordPress site and
          create an <strong>Application Password</strong> under
          Users → Your Profile.
        </p>
      </div>

      <div className="wps-field">
        <label className="wps-label">Site URL</label>
        <input
          className="wps-input"
          type="url"
          placeholder="https://yoursite.com"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          disabled={connecting}
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
          disabled={connecting}
        />
      </div>

      <div className="wps-field">
        <label className="wps-label">Application Password</label>
        <input
          className="wps-input"
          type="password"
          placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
          value={applicationPassword}
          onChange={(e) => setApplicationPassword(e.target.value)}
          disabled={connecting}
        />
        <span className="wps-hint">
          Generate under Users → Profile → Application Passwords
        </span>
      </div>

      <button
        className="wps-link-btn"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? '▾ Hide advanced' : '▸ Advanced settings'}
      </button>

      {showAdvanced && (
        <div className="wps-field">
          <label className="wps-label">REST API Prefix</label>
          <input
            className="wps-input"
            type="text"
            placeholder="/wp-json"
            value={restPrefix}
            onChange={(e) => setRestPrefix(e.target.value)}
            disabled={connecting}
          />
          <span className="wps-hint">
            Change only if your site uses a custom REST API prefix
          </span>
        </div>
      )}

      <button
        className="wps-btn wps-btn-primary"
        onClick={handleSubmit}
        disabled={connecting || !siteUrl || !username || !applicationPassword}
      >
        {connecting ? (
          <span className="wps-spinner" />
        ) : null}
        {connecting ? 'Connecting...' : 'Connect to Live Site'}
      </button>
    </div>
  );
};
