#!/bin/bash
# Builds "GloryCast Cam.app" (the Mac app, no Terminal window) into the folder given:
# mac/ (Info.plist, launcher, icon) plus its own copy of app/ and server/, so the app works
# on its own after it is dragged into Applications. Zip it with tools/mkzip.py (keeps the launcher executable).
# Run: tools/mac-app.sh <folder>
set -e
[ -d "$1" ] || { echo "usage: tools/mac-app.sh <existing folder>"; exit 1; }
src="$(cd "$(dirname "$0")/.." && pwd)"
out="$(cd "$1" && pwd)/GloryCast Cam.app"
ver="$(sed -n 's/^const VERSION = "\(.*\)";$/\1/p' "$src/server/server.js")"
rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
sed "s/@VERSION@/$ver/g" "$src/mac/Info.plist" > "$out/Contents/Info.plist"
cp "$src/mac/PkgInfo" "$out/Contents/PkgInfo"
cp "$src/mac/launch" "$out/Contents/MacOS/GloryCast Cam"
chmod 755 "$out/Contents/MacOS/GloryCast Cam"
cp "$src/mac/AppIcon.icns" "$out/Contents/Resources/AppIcon.icns"
cp -R "$src/app" "$src/server" "$out/Contents/Resources/"
echo "Built $out ($ver)"
