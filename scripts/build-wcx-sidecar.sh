#!/usr/bin/env bash
set -euo pipefail

# Build wcx Python CLI as a frozen binary for Tauri sidecar.
# Usage: ./scripts/build-wcx-sidecar.sh [target-triple]
#
# If target-triple is omitted, auto-detects from the current platform.
# Output goes to src-tauri/binaries/wcx-<target-triple>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARIES_DIR="$PROJECT_ROOT/src-tauri/binaries"
WCX_DIR="${WCX_SOURCE_DIR:-$PROJECT_ROOT/vendor/wcx}"

if [ ! -d "$WCX_DIR/wcx" ]; then
  echo "ERROR: wcx source not found at $WCX_DIR" >&2
  echo "Set WCX_SOURCE_DIR to point to the wcx repo." >&2
  exit 1
fi

# Determine target triple
if [ -n "${1:-}" ]; then
  TARGET_TRIPLE="$1"
else
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)  TARGET_TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64) TARGET_TRIPLE="x86_64-apple-darwin" ;;
    Linux-x86_64)  TARGET_TRIPLE="x86_64-unknown-linux-gnu" ;;
    MINGW*|MSYS*|CYGWIN*) TARGET_TRIPLE="x86_64-pc-windows-msvc" ;;
    *) echo "ERROR: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
fi

echo "Building wcx sidecar for $TARGET_TRIPLE ..."

# Create a temporary venv, install wcx + pyinstaller, build
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

python3 -m venv "$WORK_DIR/venv"
if [ -f "$WORK_DIR/venv/Scripts/activate" ]; then
  source "$WORK_DIR/venv/Scripts/activate"
else
  source "$WORK_DIR/venv/bin/activate"
fi

pip install --quiet pyinstaller "$WCX_DIR"

# Build frozen binary
pyinstaller \
  --noconfirm \
  --onefile \
  --name wcx \
  --distpath "$WORK_DIR/dist" \
  --workpath "$WORK_DIR/build" \
  --specpath "$WORK_DIR" \
  --hidden-import wcx.article \
  --hidden-import wcx.cache \
  --hidden-import wcx.config \
  --hidden-import wcx.fetcher \
  --hidden-import wcx.exporters \
  --hidden-import wcx.cli \
  --collect-all curl_cffi \
  --console \
  "$WCX_DIR/wcx/cli.py"

# Copy to Tauri binaries dir with target triple suffix
mkdir -p "$BINARIES_DIR"
SUFFIX=""
if [[ "$TARGET_TRIPLE" == *windows* ]]; then
  SUFFIX=".exe"
fi

cp "$WORK_DIR/dist/wcx$SUFFIX" "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
echo "Built: $BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
ls -lh "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
