# Releasing WP Live Sync

This project ships as two artifacts released to two communities:

| Artifact | Audience | Channel |
|----------|----------|---------|
| `wp-sync-companion` (WordPress plugin) | Live WordPress sites | [WordPress.org Plugin Directory](https://wordpress.org/plugins/) |
| `local-addon-wp-sync` (Local add-on) | Local WP users | GitHub Releases + [Local Add-ons Library](https://localwp.com/add-ons/) |

Keep the two version numbers in sync (`package.json` version ↔ plugin `Version:` header) — the plugin's stepped/chunked protocol is what the add-on speaks.

---

## 1. Companion plugin → WordPress.org

### One-time setup

1. Create a WordPress.org account (the `Contributors:` name in `readme.txt` must match your wordpress.org username — currently set to `ramkumarr`, adjust if different).
2. Read the [Plugin Guidelines](https://make.wordpress.org/plugins/handbook/plugin-directory-guidelines/).

### Pre-submission checklist

- [ ] Run the official [Plugin Check (PCP)](https://wordpress.org/plugins/plugin-check/) plugin against `wp-sync-companion` on a test site and fix anything it flags.
- [ ] Verify on PHP 7.4 **and** 8.3 (the plugin declares `Requires PHP: 7.4`).
- [ ] `Tested up to:` in `readme.txt` matches the current WordPress release.
- [ ] `Stable tag:` matches the `Version:` header.
- [ ] License is GPLv2-or-later (already set — WordPress.org requires GPL compatibility).

### Submit

1. Build the ZIP:
   ```bash
   ./scripts/package-plugin.sh   # → dist/wp-sync-companion-<version>.zip
   ```
2. Upload it at <https://wordpress.org/plugins/developers/add/>.
3. Wait for the review team (typically days to a few weeks). Because this plugin exposes database-export and file-import endpoints, expect security questions — the answers are in the readme: admin-only Application Password auth, token-validated downloads, path-traversal checks, protected temp dir, random filenames.
4. The slug `wp-sync-companion` must be unique on WordPress.org; the review team may ask you to rename if it's taken (search the directory first).

### After approval — SVN

WordPress.org gives you an SVN repository:

```bash
svn co https://plugins.svn.wordpress.org/wp-sync-companion
cd wp-sync-companion
# Copy plugin files into trunk/
cp -R /path/to/companion-plugin/wp-sync-companion/* trunk/
svn add --force trunk
svn ci -m "Release 1.2.0"
# Tag the release (stable tag in readme.txt points here)
svn cp trunk tags/1.2.0
svn ci -m "Tag 1.2.0"
```

Directory listing assets (icon, banner, screenshots) go in the SVN `assets/` folder:
- `icon-256x256.png`, `icon-128x128.png`
- `banner-1544x500.png`, `banner-772x250.png`
- `screenshot-1.png`, … (referenced from readme.txt `== Screenshots ==`)

### Updating

Bump `Version:` + `Stable tag:` + changelog, copy to `trunk/`, create the new tag, commit. Users get the update in wp-admin automatically.

---

## 2. Local add-on → GitHub + Local Add-ons Library

### Publish on GitHub

1. Push this repository to GitHub (public).
2. Build the release artifact:
   ```bash
   ./scripts/package-addon.sh    # → dist/local-addon-wp-sync-<version>.tgz
   ```
   The tarball ships compiled `lib/` plus production `node_modules`, so users don't need yarn.
3. Create a GitHub release (`git tag v1.2.0 && git push --tags`), attach the `.tgz`, and paste the changelog.

Users install either by:
- **From disk**: Local → Add-ons → Installed → "Install from disk" → select the `.tgz`, or
- **From source**: clone into Local's addons directory and `yarn install && yarn build` (documented in README).

### Get listed in the Local Add-ons Library

1. Make sure the repo has: README with install instructions, LICENSE, icon.svg, and a tagged release.
2. Submit the add-on at <https://localwp.com/submit-addon/> — the Local team reviews community add-ons before listing them in the in-app Add-ons library.
3. Reference docs while you wait: [Building your Add-on](https://localwp.com/help-docs/building-your-add-on/) and [Build an add-on for Local](https://localwp.com/get-involved/build/). Questions go to the [Local Add-ons community forum](https://community.localwp.com/c/local-add-ons/13).

---

## 3. Release checklist (every release)

1. [ ] Bump version in `package.json` **and** `wp-sync-companion.php` (header + `WP_SYNC_VERSION`) **and** `readme.txt` (`Stable tag:` + changelog).
2. [ ] `yarn build` and `php -l` all plugin files.
3. [ ] Smoke test: pull a real site end-to-end (create-from-live), push a change back.
4. [ ] Protocol compatibility: if REST endpoints changed, confirm the add-on still handles the previous plugin version gracefully (it detects old plugins by response shape).
5. [ ] `./scripts/package-plugin.sh` and `./scripts/package-addon.sh`.
6. [ ] SVN tag (plugin) + GitHub release with `.tgz` (add-on).

## Known review-sensitive points (already addressed)

- Admin-only (`manage_options`) permission callback on every REST route.
- Export/log files use unguessable names; temp dir has `.htaccess` + `index.php` guards; everything is deleted on deactivation and uninstall (`uninstall.php`).
- `ini_set` overrides scoped to the plugin's own REST requests only.
- No PHP 8-only functions (7.4 compatible).
- `wp-config.php` never exported, never overwritten.
- ZIP uploads validated against path traversal before extraction.
