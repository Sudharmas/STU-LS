#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-linux}"

cd "$(dirname "$0")/.."

echo "Running checks and tests..."
npm run check:desktop
npm run test:desktop

case "$TARGET" in
  windows)
    echo "Building Windows installer..."
    npm run release:windows
    ;;
  mac)
    echo "Building macOS installer..."
    npm run release:mac
    ;;
  linux)
    echo "Building Linux packages..."
    npm run release:linux
    ;;
  *)
    echo "Invalid target: $TARGET"
    exit 1
    ;;
esac

echo "Release packaging completed for target: $TARGET"
