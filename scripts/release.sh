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
    echo "Building macOS universal installer..."
    rustup target add x86_64-apple-darwin
    rustup target add aarch64-apple-darwin
    npm run release:mac
    ;;
  mac-arm)
    echo "Building macOS Apple Silicon (ARM) installer..."
    rustup target add aarch64-apple-darwin
    npm run release:mac:arm
    ;;
  mac-intel)
    echo "Building macOS Intel installer..."
    rustup target add x86_64-apple-darwin
    npm run release:mac:intel
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
