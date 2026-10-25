#!/bin/sh
# Copy GloryCast Switch's page (its app folder) into the Android app before a build:
#   switch-android/sync-web.sh /path/to/GloryCast-Switch/app
# The page lives with GloryCast Switch itself; this copy is what the Android app carries.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
src=${1:?give the GloryCast-Switch/app folder}
[ -f "$src/index.html" ] && [ -f "$src/js/switch.js" ] || { echo "$src is not GloryCast Switch's app folder" >&2; exit 1; }
dst="$here/app/src/main/assets/web"
rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/
echo "copied $(find "$dst" -type f | wc -l) files to $dst"
