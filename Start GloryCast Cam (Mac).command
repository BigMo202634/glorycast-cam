#!/bin/bash
# GloryCast Cam on a Mac needs Node.js (free, nodejs.org, the LTS version).
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then
  node server/server.js --open
else
  echo "Please install Node.js from https://nodejs.org (the LTS version), then open this again."
  read -n 1 -s -r -p "Press any key to close."
fi
