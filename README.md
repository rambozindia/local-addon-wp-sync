# WP Live Sync — Local WP Add-on

Pull your self-hosted WordPress site into Local WP and push changes back to live — all via the WordPress REST API. No SSH or FTP needed.

## Features

- **Pull to Local** — download the live site's database + files into an existing Local site
- **Push to Live** — deploy your local database + files back to the live server
- **Create Site from Live** — one click in the Local sidebar provisions a brand-new Local site directly from a live WordPress install (no need to create an empty site first)
- **Chunked database upload** — large SQL files are uploaded in 8 MB chunks, so pushes work even on shared hosting with restrictive PHP upload limits
- **Stepped exports (proxy-safe)** — database and file exports on the live site run in short, resumable steps (~15s each), and file archives are split into ~100 MB parts, so pulls work behind Cloudflare and other proxies that time out long requests (HTTP 524)
- **Automatic URL rewriting** — live ↔ local URLs are search-replaced on every pull/push
- **Saved connections** — credentials are remembered per site, so reconnecting is instant

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
1. Add-on repeatedly calls the companion plugin's export endpoints; each call does a bounded slice of work (dumping tables / zipping files) and returns progress, until the export is complete
2. The database is exported as a single SQL file; files are archived into one or more ~100 MB ZIP parts
3. Add-on downloads the SQL file and each archive part, extracts the parts into the Local site, and imports the SQL directly through Local's bundled MySQL binary
4. WP-CLI rewrites URLs from `https://yoursite.com` → `http://yoursite.local` (including the `https` variant)

### Push Flow (Local → Live)
1. Add-on exports the local database via Local's bundled `mysqldump`
2. URLs in the SQL dump are rewritten from local → live
3. Add-on packages local files into a ZIP
4. Both are uploaded to the companion plugin's REST API — SQL files over 8 MB are sent in chunks and reassembled server-side
5. Companion plugin imports the database and extracts files
6. `wp-config.php` on live is preserved (backed up before import and restored after — never overwritten)

### Create Site from Live
1. Click **Pull from Live Site** above the sites list in Local's sidebar
2. Enter a new site name plus your live site credentials
3. The add-on downloads the live database + files, provisions a new Local site via Local's own AddSiteService, waits for MySQL to come up, generates a fresh `wp-config.php`, imports everything, and rewrites URLs
4. The connection is saved automatically, so the new site's **WP Live Sync** tab is pre-connected

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

Restart Local WP and enable the add-on. You'll see:

- A **WP Live Sync** tab on each site's info page
- A **Pull from Live Site** button above the sites list in the sidebar

## Usage

### Sync an existing Local site

1. Open a site in Local WP and switch to the **WP Live Sync** tab
2. Enter your live site URL, WordPress username, and Application Password
3. Click **Connect to Live Site**
4. Use **Pull to Local** to download the live site
5. Make your changes locally
6. Use **Push to Live** to deploy changes

### Create a new Local site from a live site

1. Click **Pull from Live Site** above the sites list
2. Enter a name for the new site plus your live site URL, username, and Application Password
3. Watch the progress — when it finishes, the new site appears in Local, already connected to the live site

## Security

- All communication uses WordPress's built-in Application Passwords (Basic Auth over HTTPS)
- Only administrator-level users (`manage_options`) can access sync endpoints
- Download tokens are validated (32–64 hex chars) before any file is served
- `wp-config.php` is never included in exports and is backed up/restored around full imports (preserves local/live database credentials)
- Temporary export files are stored in a protected directory (`wp-content/wp-sync-temp`) with `.htaccess` deny rules, cleaned up on plugin deactivation
- ZIP archives are validated against path traversal attacks before extraction
- Saved connections (including the Application Password) are stored as JSON in Local's user-data directory (`wp-sync-connections.json`) — treat that machine as trusted

**Important:** Always use HTTPS on your live site. Application Passwords over plain HTTP expose credentials.

## Project Structure

```
local-addon-wp-sync/
├── src/
│   ├── main/                    # Node.js (Electron main process)
│   │   ├── index.ts             # Add-on entry, IPC handlers, connection persistence
│   │   ├── sync-manager.ts      # Orchestrates pull/push/create-from-live operations
│   │   ├── api-client.ts        # REST API client (incl. chunked DB upload)
│   │   ├── ipc-events.ts        # IPC event constants
│   │   └── types.ts             # TypeScript interfaces
│   └── renderer/                # React (Electron renderer process)
│       ├── index.tsx             # Renderer entry, hook registration
│       ├── styles.css            # Add-on UI styles
│       └── components/
│           ├── WPSyncPanel.tsx        # Main "WP Live Sync" tab
│           ├── ConnectionForm.tsx     # Connection setup form
│           ├── SyncControls.tsx       # Pull/Push buttons + confirmation
│           ├── SiteInfoCard.tsx       # Remote site info display
│           └── CreateFromLiveCard.tsx # Sidebar "Pull from Live Site" button + modal
├── lib/                         # Compiled output (tsc + webpack), loaded by Local
├── companion-plugin/
│   └── wp-sync-companion/       # WordPress plugin for live site
│       ├── wp-sync-companion.php # Plugin entry, temp-dir setup, PHP limit overrides
│       └── includes/
│           ├── class-rest-controller.php  # REST API endpoints
│           ├── class-database-handler.php # DB export/import
│           └── class-file-handler.php     # File ZIP/extract, wp-config backup
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

`yarn build` runs `tsc` (main process → `lib/main`) and webpack (renderer → `lib/renderer`). It also runs automatically on `yarn install` (postinstall). After building, restart Local WP to load changes (or use Local's add-on reload if available).

### Releasing

```bash
./scripts/package-plugin.sh   # WordPress.org-ready ZIP → dist/
./scripts/package-addon.sh    # Local add-on .tgz (prebuilt) → dist/
```

See [RELEASING.md](RELEASING.md) for the full WordPress.org submission and Local Add-ons Library listing process.

## REST API Endpoints (Companion Plugin)

All endpoints live under the `wp-sync/v1` namespace and require administrator authentication via Application Passwords.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/wp-json/wp-sync/v1/status` | Health check, plugin/WP/PHP versions |
| GET | `/wp-json/wp-sync/v1/site-info` | WP version, theme, plugins, disk usage |
| POST | `/wp-json/wp-sync/v1/export/database` | DB export. With `stepped=1`, runs one ~15s slice per request — pass back `token` until `complete: true` |
| POST | `/wp-json/wp-sync/v1/export/files` | File archive export. Same `stepped`/`token` protocol; produces ~100 MB ZIP parts |
| GET | `/wp-json/wp-sync/v1/download/{token}` | Download exported file (`?part=N` for multi-part file exports) |
| POST | `/wp-json/wp-sync/v1/import/database` | Upload & import SQL file (small files) |
| POST | `/wp-json/wp-sync/v1/import/database/chunk` | Upload one 8 MB chunk of a large SQL file; imports once the last chunk arrives |
| POST | `/wp-json/wp-sync/v1/import/files` | Upload & extract ZIP archive |
| DELETE | `/wp-json/wp-sync/v1/cleanup/{token}` | Remove temporary files |

The plugin also attempts to raise PHP limits (`upload_max_filesize`, `post_max_size`, `memory_limit`, `max_execution_time`) to 512M/600s via `ini_set` — hosts that disallow this fall back to the chunked upload path for databases.

## Limitations

- Individual files larger than 256MB are skipped during export to prevent memory issues
- File archives are uploaded as a single request (15-minute timeout) — only database uploads are chunked, so **pushing** a very large site through Cloudflare may still hit its ~100s timeout (pulling is proxy-safe via stepped exports)
- WordPress Multisite is detected but not fully tested
- Serialized data URL rewriting on push relies on simple string replacement (works for most cases but may miss complex serialized structures)
- Site creation from live currently provisions with Local's "preferred" environment defaults

## License

MIT

## Author

Ramkumar R — [BlueBurn Technologies](https://blueburn.in) / [24GB](https://24gb.uk)
