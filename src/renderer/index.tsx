import * as LocalRenderer from '@getflywheel/local/renderer';
import { WPSyncPanel } from './components/WPSyncPanel';
import { CreateFromLiveCard } from './components/CreateFromLiveCard';

export default function (context: any): void {
  const { React, hooks } = context;
  const { Route, NavLink } = context.ReactRouter;

  // Add "WP Live Sync" tab in site info navigation
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return React.createElement(
      NavLink,
      {
        key: 'wp-sync-tab',
        to: `/main/site-info/${site.id}/wp-sync`,
        activeClassName: 'active',
      },
      'WP Live Sync'
    );
  });

  // Add "Pull from Live Site" button above the sites list
  hooks.addContent('SitesSidebar_SiteList:Before', () => {
    return React.createElement(CreateFromLiveCard, { key: 'wp-sync-create-from-live' });
  });

  // Register the route for our tab content
  hooks.addContent('routes[site-info]', ({ routeChildrenProps }: any) => {
    return React.createElement(Route, {
      key: 'wp-sync-route',
      path: '/main/site-info/:siteId/wp-sync',
      render: (props: any) =>
        React.createElement(WPSyncPanel, {
          ...props,
          ...routeChildrenProps,
          site: routeChildrenProps.site,
        }),
    });
  });
}
