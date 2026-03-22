import * as LocalRenderer from '@getflywheel/local/renderer';
import { WPSyncPanel } from './components/WPSyncPanel';

/**
 * WP Live Sync - Renderer Process
 *
 * Registers a new sidebar panel on each Local site
 * that provides pull/push controls for the live site.
 */
export default function (context: any): void {
  const { React, hooks } = context;
  const { Route } = context.ReactRouter || {};

  // Register our panel in the site's sidebar menu
  hooks.addContent('siteInfoToolsSection', (site: any) => {
    return React.createElement(WPSyncPanel, { site, key: 'wp-sync-panel' });
  });

  // Also add a menu item in the sidebar
  hooks.addFilter('siteInfoMoreMenu', (menu: any[], site: any) => {
    return [
      ...menu,
      {
        label: 'WP Live Sync',
        enabled: true,
        click: () => {
          // Navigate to our panel
          context.events.send('goToRoute', `/site-info/${site.id}/wp-sync`);
        },
      },
    ];
  });
}
