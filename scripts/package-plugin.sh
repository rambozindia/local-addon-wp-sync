#!/usr/bin/env bash
# Package the Live Sync Companion plugin into a WordPress.org-ready ZIP.
# Usage: ./scripts/package-plugin.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(grep -m1 "Version:" companion-plugin/live-sync-companion/live-sync-companion.php | sed 's/[^0-9.]//g')
OUT="dist/live-sync-companion-${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"

# Zip from inside companion-plugin so the archive root is live-sync-companion/
(
  cd companion-plugin
  zip -r "../$OUT" live-sync-companion \
    -x "*.DS_Store" -x "*__MACOSX*" -x "*.git*"
)

echo "Built $OUT"
unzip -l "$OUT"
