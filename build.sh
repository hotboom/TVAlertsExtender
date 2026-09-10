#!/usr/bin/env bash
# Собирает .zip для загрузки на addons.mozilla.org.
# manifest.json должен лежать в КОРНЕ архива (без вложенной папки).
set -e
cd "$(dirname "$0")"

VERSION=$(python -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="tv-alert-extender-${VERSION}.zip"

FILES=(
  manifest.json
  background.js
  config.js
  popup.html
  popup.js
  options.html
  options.js
  icon.png
  icon.svg
)

rm -f "$OUT"
python -c "
import zipfile,sys
with zipfile.ZipFile('$OUT','w',zipfile.ZIP_DEFLATED) as z:
    for f in sys.argv[1:]: z.write(f)
" "${FILES[@]}"

echo "→ $OUT"
