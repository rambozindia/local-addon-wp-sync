#!/usr/bin/env bash
# Package the Local add-on into a .tgz for GitHub releases / install-from-disk.
# Includes compiled lib/ and production node_modules so the add-on runs
# out of the box when dropped into Local's addons directory.
# Usage: ./scripts/package-addon.sh
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME="local-addon-wp-sync"
STAGE="dist/${NAME}"
OUT="dist/${NAME}-${VERSION}.tgz"

yarn build

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"

cp -R lib icon.svg README.md LICENSE "$STAGE/"
# package.json without postinstall (the package ships prebuilt)
node -e "
  const pkg = require('./package.json');
  delete pkg.scripts.postinstall;
  delete pkg.devDependencies;
  require('fs').writeFileSync('$STAGE/package.json', JSON.stringify(pkg, null, 2));
"

# Production dependencies only
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --silent)

tar -czf "$OUT" -C dist "$NAME"
rm -rf "$STAGE"

echo "Built $OUT"
