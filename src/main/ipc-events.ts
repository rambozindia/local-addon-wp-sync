/**
 * IPC event names for communication between main ↔ renderer processes.
 */
export const IPC_EVENTS = {
  // Connection management
  TEST_CONNECTION: 'wp-sync:test-connection',
  SAVE_CONNECTION: 'wp-sync:save-connection',
  LOAD_CONNECTION: 'wp-sync:load-connection',

  // Sync operations
  PULL_SITE: 'wp-sync:pull-site',
  PUSH_SITE: 'wp-sync:push-site',
  SYNC_PROGRESS: 'wp-sync:sync-progress',

  // Remote site info
  GET_REMOTE_INFO: 'wp-sync:get-remote-info',
} as const;
