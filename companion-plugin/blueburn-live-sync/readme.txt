=== BlueBurn Live Sync for Local ===
Contributors: rambozindia
Tags: sync, migration, localwp, staging, deployment
Requires at least: 5.6
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 1.3.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Sync your live site with Local — pull it into Local for development and push changes back over the REST API. No SSH or FTP needed.

== Description ==

BlueBurn Live Sync for Local is the server-side half of the **BlueBurn Live Sync** add-on for [Local](https://localwp.com) (LocalWP). Install this plugin on your live site, connect from the Local add-on with an Application Password, and you can:

* **Pull** your entire live site (database + files) into a Local site
* **Create a brand-new Local site** directly from your live site in one click
* **Push** your local changes (database + files) back to the live server

*BlueBurn Live Sync is an independent product by BlueBurn Technologies and is not affiliated with or endorsed by WP Engine or the Local (LocalWP) project.*

= How it works =

The plugin exposes REST API endpoints (under `wp-sync/v1`) for exporting and importing the database and files. Everything is engineered for real-world hosting:

* **Stepped exports** — the database dump and file archiving run in short resumable steps (~15 s each), so exports never trip proxy timeouts (e.g. Cloudflare's 100-second limit)
* **Multi-part archives** — files are zipped into ~100 MB parts instead of one giant archive
* **Chunked uploads** — large database imports are uploaded in 8 MB chunks, fitting even restrictive `upload_max_filesize` limits
* **Memory-safe streaming downloads** — exports stream in 1 MB chunks, never buffering whole files in memory

= Security =

* Every endpoint requires an **administrator** authenticated via WordPress Application Passwords (built into WordPress 5.6+)
* Export files use unguessable random-token filenames inside a protected directory in uploads (`.htaccess` deny + `index.php` guard)
* `wp-config.php` is never included in exports and is never extracted from imports — database credentials and auth keys/salts are never read, copied, or transmitted
* Uploaded archives are validated against path traversal before extraction
* PHP limits are raised only inside the specific export/import handlers that need them
* Always use HTTPS — Application Passwords over plain HTTP expose credentials

= Requirements =

* The [BlueBurn Live Sync add-on](https://github.com/rambozindia/blueburn-live-sync) installed in Local on your computer
* PHP ZipArchive extension on the server

== Installation ==

1. Upload the `blueburn-live-sync` folder to `/wp-content/plugins/`, or install via Plugins → Add New
2. Activate the plugin
3. In WP Admin, go to **Users → Profile → Application Passwords**, create a password named e.g. "Local Sync" and copy it
4. In Local, open the **BlueBurn Live Sync** panel, enter your site URL, username, and the Application Password, then connect

== Frequently Asked Questions ==

= Does this work behind Cloudflare? =

Yes. Exports run in short resumable steps and downloads stream continuously, so nothing hits Cloudflare's 100-second response limit.

= Does it work on shared hosting with small upload limits? =

Yes. Database uploads are chunked into 8 MB pieces. The plugin also tries to raise PHP limits inside its heavy export/import handlers where the host allows it.

= Is my database dump publicly accessible? =

No. Export files live in a protected directory inside uploads and use cryptographically random filenames. They are deleted after each sync (and on plugin deactivation/uninstall).

= Does it support WordPress Multisite? =

Multisite is detected and reported but not fully tested. Use with caution.

= What happens to wp-config.php? =

Nothing — ever. It is excluded from exports, and imports never extract it, so your database credentials and authentication keys/salts are never read, copied, or transmitted.

== Changelog ==

= 1.3.0 =
* Changed: renamed to "BlueBurn Live Sync for Local" (slug `blueburn-live-sync`)
* Security: imports never extract wp-config.php and no backup copy of it is ever written to disk — auth keys/salts stay untouched
* Security: log filename now uses a stored random key instead of a salt-derived hash
* Changed: temp directory moved to `uploads/blueburn-live-sync/` (plugin-guidelines recommended location, multisite compatible)
* Changed: PHP limit raises moved from plugin bootstrap into the specific heavy export/import handlers

= 1.2.1 =
* Fixed: host-specific `.user.ini` files (open_basedir etc.) are now excluded from exports — they broke PHP on the destination environment ("No input file specified")

= 1.2.0 =
* Security: export files now use random-token filenames (protection on nginx hosts)
* Security: index.php guard in temp directory
* Fixed: PHP 7.4 compatibility (removed PHP 8-only functions)
* Changed: license to GPLv2 or later for WordPress.org distribution

= 1.1.2 =
* Fixed: downloads stream in 1 MB chunks — no more memory exhaustion on large exports when output buffering is active

= 1.1.1 =
* Added: request/error logging with remote log endpoint (`GET /log`)
* Added: PHP fatals returned as structured JSON errors instead of bare 500s

= 1.1.0 =
* Added: stepped resumable exports (proxy/Cloudflare safe)
* Added: multi-part ZIP file exports (~100 MB per part)
* Added: chunked database upload endpoint

= 1.0.0 =
* Initial release

== Upgrade Notice ==

= 1.3.0 =
Renamed to BlueBurn Live Sync for Local, with security hardening around wp-config.php handling. Recommended for all users.
