import * as React from 'react';

const { clipboard } = require('electron');

interface ErrorBoxProps {
  message: string;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Error banner with a copy-to-clipboard button. Long messages (WP-CLI output,
 * stack traces) are selectable and scroll instead of overflowing the modal.
 */
export const ErrorBox: React.FC<ErrorBoxProps> = ({ message, onDismiss, className }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`wps-error ${className || ''}`} style={{ alignItems: 'flex-start' }}>
      <span className="wps-error-icon">⚠</span>
      <span
        style={{
          flex: 1,
          userSelect: 'text',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          maxHeight: '180px',
          overflowY: 'auto',
        }}
      >
        {message}
      </span>
      <button
        onClick={handleCopy}
        title="Copy error to clipboard"
        style={{
          flexShrink: 0,
          background: 'rgba(220, 60, 60, 0.15)',
          border: '1px solid rgba(220, 60, 60, 0.35)',
          borderRadius: '5px',
          color: '#e88',
          fontSize: '11px',
          fontWeight: 600,
          padding: '3px 10px',
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
      {onDismiss && (
        <button className="wps-error-dismiss" onClick={onDismiss}>×</button>
      )}
    </div>
  );
};
