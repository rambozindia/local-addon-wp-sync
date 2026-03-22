# WP Live Sync — Local WP Add-on

Pull your self-hosted WordPress site into Local WP and push changes back to live — all via the WordPress REST API. No SSH or FTP needed.

## How It Works

```
┌──────────────┐    REST API    ┌──────────────────────┐
│   Local WP   │ ◄────────────► │  Live WordPress Site │
│  (Add-on)    │   Pull / Push  │  (Companion Plugin)  │
└──────────────┘                └──────────────────────┘
```

**Two components work together:**

1. **Local WP Add-on** (`local-addon-wp-sync`) — Runs inside Local WP, provides the UI and orchestrates sync
2. **Companion Plugin** (`wp-sync-companion`) — Installed on your live WordPress site, exposes REST API endpoints for export/import

### Pull Flow (Live → Local)
1. Add-on sends a request to the companion plugin's REST API
2. Companion plugin exports the database as SQL
3. Companion plugin zips the WordPress files
4. Add-on downloads both and imports into the Local site
5. WP-CLI rewrites URLs from `https://yoursite.com` → `http://yoursite.local`

### Push Flow (Local → Live)
1. Add-on exports the local database via WP-CLI
2. Add-on packages local files into a ZIP
3. Both are uploaded to the companion plugin's REST API
4. Companion plugin imports the database and extracts files
5. `wp-config.php` on live is preserved (never overwritten)

## Prerequisites

- **Local WP** (latest version) — [Download](https://localwp.com)
- **Self-hosted WordPress 5.6+** with:
  - PHP 7.4+
  - ZipArchive PHP extension
  - Application Passwords enabled (built-in since WP 5.6)

## Installation

### 1. Install the Companion Plugin (Live Site)

Upload the `companion-plugin/wp-sync-companion` folder to your live site:

```bash
# Via WP-CLI
wp plugin install /path/to/wp-sync-companion --activate

# Or manually
# Copy wp-sync-companion/ to wp-content/plugins/ and activate in WP Admin
```

### 2. Create an Application Password (Live Site)

1. Go to **Users → Your Profile** in WP Admin
2. Scroll to **Application Passwords**
3. Enter a name (e.g., "Local WP Sync") and click **Add New**
4. Copy the generated password — you'll need it in the add-on

### 3. Install the Local WP Add-on

Clone or copy this add-on into Local's add-ons directory:

```bash
# macOS
cd ~/Library/Application\ Support/Local/addons
git clone <this-repo> local-addon-wp-sync

# Windows
cd %APPDATA%\Local\addons
git clone <this-repo> local-addon-wp-sync

# Linux
cd ~/.config/Local/addons
git clone <this-repo> local-addon-wp-sync
```

Then install and build:

```bash
cd local-addon-wp-sync
yarn install
yarn build
```

Restart Local WP. The "WP Live Sync" panel will appear in each site's tools section.

## Usage

1. Open a site in Local WP
2. Find the **WP Live Sync** panel in the site tools
3. Enter your live site URL, WordPress username, and Application Password
4. Click **Connect to Live Site**
5. Use **Pull to Local** to download the live site
6. Make your changes locally
7. Use **Push to Live** to deploy changes

## Security

- All communication uses WordPress's built-in Application Passwords (Basic Auth over HTTPS)
- Only administrator-level users can access sync endpoints
- `wp-config.php` is never included in exports (preserves local/live database credentials)
- Temporary export files are stored in a protected directory with `.htaccess` deny rules
- ZIP archives are validated against path traversal attacks before extraction

**Important:** Always use HTTPS on your live site. Application Passwords over plain HTTP expose credentials.

## Project Structure

```
local-addon-wp-sync/
├── src/
│   ├── main/                    # Node.js (Electron main process)
│   │   ├── index.ts             # Add-on entry, IPC handlers
│   │   ├── sync-manager.ts      # Orchestrates pull/push operations
│   │   ├── api-client.ts        # REST API client for companion plugin
│   │   ├── ipc-events.ts        # IPC event constants
│   │   └── types.ts             # TypeScript interfaces
│   └── renderer/                # React (Electron renderer process)
│       ├── index.tsx             # Renderer entry, hook registration
│       ├── styles.css            # Add-on UI styles
│       └── components/
│           ├── WPSyncPanel.tsx   # Main panel component
│           ├── ConnectionForm.tsx # Connection setup form
│           ├── SyncControls.tsx  # Pull/Push buttons + confirmation
│           └── SiteInfoCard.tsx  # Remote site info display
├── companion-plugin/
│   └── wp-sync-companion/       # WordPress plugin for live site
│       ├── wp-sync-companion.php # Plugin entry
│       └── includes/
│           ├── class-rest-controller.php  # REST API endpoints
│           ├── class-database-handler.php # DB export/import
│           └── class-file-handler.php     # File ZIP/extract
├── package.json
├── tsconfig.json
├── webpack.config.js
└── icon.svg
```

## Development

```bash
# Watch mode (auto-rebuild on changes)
yarn watch

# Production build
yarn build
```

After building, restart Local WP to load changes (or use Local's add-on reload if available).

## REST API Endpoints (Companion Plugin)

All endpoints require administrator authentication via Application Passwords.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/wp-json/wp-sync/v1/status` | Health check, plugin version |
| GET | `/wp-json/wp-sync/v1/site-info` | WP version, theme, plugins, disk usage |
| POST | `/wp-json/wp-sync/v1/export/database` | Trigger DB export, returns download token |
| POST | `/wp-json/wp-sync/v1/export/files` | Trigger file archive, returns download token |
| GET | `/wp-json/wp-sync/v1/download/{token}` | Download exported file |
| POST | `/wp-json/wp-sync/v1/import/database` | Upload & import SQL file |
| POST | `/wp-json/wp-sync/v1/import/files` | Upload & extract ZIP archive |
| DELETE | `/wp-json/wp-sync/v1/cleanup/{token}` | Remove temporary files |

## Limitations

- Large sites (>1GB) may time out during export — consider increasing PHP `max_execution_time`
- Files larger than 256MB are skipped during export
- WordPress Multisite is detected but not fully tested
- Serialized data URL rewriting on push relies on simple string replacement (works for most cases but may miss complex serialized structures)

## License

MIT

## Author

Ramkumar R — [BlueBurn Technologies](https://blueburn.in) / [24GB](https://24gb.uk)
