=== Live Sync Companion ===
Contributors: rambozindia
Tags: sync, migration, localwp, staging, deployment
Requires at least: 5.6
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 1.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Sync your live site with Local — pull it into Local for development and push changes back over the REST API. No SSH or FTP needed.

== Description ==

Live Sync Companion is the server-side half of **WP Live Sync**, a free add-on for [Local](https://localwp.com). Install this plugin on your live site, connect from the Local add-on with an Application Password, and you can:

* **Pull** your entire live site (database + files) into a Local site
* **Create a brand-new Local site** directly from your live site in one click
* **Push** your local changes (database + files) back to the live server

= How it works =

The plugin exposes REST API endpoints (under `wp-sync/v1`) for exporting and importing the database and files. Everything is engineered for real-world hosting:

* **Stepped exports** — the database dump and file archiving run in short resumable steps (~15 s each), so exports never trip proxy timeouts (e.g. Cloudflare's 100-second limit)
* **Multi-part archives** — files are zipped into ~100 MB parts instead of one giant archive
* **Chunked uploads** — large database imports are uploaded in 8 MB chunks, fitting even restrictive `upload_max_filesize` limits
* **Memory-safe streaming downloads** — exports stream in 1 MB chunks, never buffering whole files in memory

= Security =

* Every endpoint requires an **administrator** authenticated via WordPress Application Passwords (built into WordPress 5.6+)
* Export files use unguessable random-token filenames inside a protected directory (`.htaccess` deny + `index.php` guard)
* `wp-config.php` is never included in exports and never overwritten by imports
* Uploaded archives are validated against path traversal before extraction
* Always use HTTPS — Application Passwords over plain HTTP expose credentials

= Requirements =

* The [WP Live Sync add-on](https://github.com/rambozindia/local-addon-wp-sync) installed in Local on your computer
* PHP ZipArchive extension on the server

== Installation ==

1. Upload the `live-sync-companion` folder to `/wp-content/plugins/`, or install via Plugins → Add New
2. Activate the plugin
3. In WP Admin, go to **Users → Profile → Application Passwords**, create a password named e.g. "Local WP Sync" and copy it
4. In Local, open the **WP Live Sync** panel, enter your site URL, username, and the Application Password, then connect

== Frequently Asked Questions ==

= Does this work behind Cloudflare? =

Yes. Exports run in short resumable steps and downloads stream continuously, so nothing hits Cloudflare's 100-second response limit.

= Does it work on shared hosting with small upload limits? =

Yes. Database uploads are chunked into 8 MB pieces. The plugin also tries to raise PHP limits for its own requests where the host allows it.

= Is my database dump publicly accessible? =

No. Export files live in a protected directory and use cryptographically random filenames. They are deleted after each sync (and on plugin deactivation).

= Does it support WordPress Multisite? =

Multisite is detected and reported but not fully tested. Use with caution.

= What happens to wp-config.php? =

It is excluded from exports and preserved during imports — your live database credentials are never touched.

== Changelog ==

= 1.2.0 =
* Security: export files now use random-token filenames (protection on nginx hosts)
* Security: log file name derived from auth salt; index.php guard in temp directory
* Fixed: PHP 7.4 compatibility (removed PHP 8-only functions)
* Changed: PHP limit overrides now apply only to this plugin's own REST requests
* Changed: license to GPLv2 or later for WordPress.org distribution
* Changed: plugin renamed from "WP Sync Companion" to "Live Sync Companion" (WordPress.org restricts "wp" in plugin names)

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

= 1.2.0 =
Security hardening and PHP 7.4 compatibility fixes. Recommended for all users.
