#!/usr/bin/env bash
# Package the BlueBurn Live Sync plugin into a WordPress.org-ready ZIP.
# Usage: ./scripts/package-plugin.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(grep -m1 "Version:" companion-plugin/blueburn-live-sync/blueburn-live-sync.php | sed 's/[^0-9.]//g')
OUT="dist/blueburn-live-sync-${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"

# Zip from inside companion-plugin so the archive root is blueburn-live-sync/
(
  cd companion-plugin
  zip -r "../$OUT" blueburn-live-sync \
    -x "*.DS_Store" -x "*__MACOSX*" -x "*.git*"
)

echo "Built $OUT"
unzip -l "$OUT"
