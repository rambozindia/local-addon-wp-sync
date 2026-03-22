import * as React from 'react';

interface RemoteSiteInfo {
  name: string;
  url: string;
  wpVersion: string;
  phpVersion: string;
  activeTheme: string;
  plugins: { name: string; slug: string; version: string; active: boolean }[];
  dbPrefix: string;
  isMultisite: boolean;
  diskUsage?: {
    uploads: string;
    themes: string;
    plugins: string;
    total: string;
  };
}

interface Props {
  info: RemoteSiteInfo;
}

export const SiteInfoCard: React.FC<Props> = ({ info }) => {
  const [expanded, setExpanded] = React.useState(false);
  const activePlugins = info.plugins?.filter((p) => p.active) || [];

  return (
    <div className="wps-site-info">
      <div className="wps-site-info-header" onClick={() => setExpanded(!expanded)}>
        <div className="wps-site-info-title">
          <span className="wps-connected-dot" />
          <strong>{info.name}</strong>
        </div>
        <span className="wps-toggle">{expanded ? '▾' : '▸'}</span>
      </div>

      <div className="wps-site-info-summary">
        <span className="wps-tag">WP {info.wpVersion}</span>
        <span className="wps-tag">PHP {info.phpVersion}</span>
        <span className="wps-tag">{info.activeTheme}</span>
        <span className="wps-tag">{activePlugins.length} plugins</span>
      </div>

      {expanded && (
        <div className="wps-site-info-details">
          <div className="wps-detail-row">
            <span className="wps-detail-label">URL</span>
            <span className="wps-detail-value">{info.url}</span>
          </div>
          <div className="wps-detail-row">
            <span className="wps-detail-label">DB Prefix</span>
            <span className="wps-detail-value">{info.dbPrefix}</span>
          </div>
          <div className="wps-detail-row">
            <span className="wps-detail-label">Multisite</span>
            <span className="wps-detail-value">{info.isMultisite ? 'Yes' : 'No'}</span>
          </div>

          {info.diskUsage && (
            <>
              <h4 className="wps-detail-heading">Disk Usage</h4>
              <div className="wps-detail-row">
                <span className="wps-detail-label">Total</span>
                <span className="wps-detail-value">{info.diskUsage.total}</span>
              </div>
              <div className="wps-detail-row">
                <span className="wps-detail-label">Uploads</span>
                <span className="wps-detail-value">{info.diskUsage.uploads}</span>
              </div>
            </>
          )}

          <h4 className="wps-detail-heading">Active Plugins</h4>
          <ul className="wps-plugin-list">
            {activePlugins.map((p) => (
              <li key={p.slug} className="wps-plugin-item">
                <span>{p.name}</span>
                <span className="wps-plugin-version">v{p.version}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
