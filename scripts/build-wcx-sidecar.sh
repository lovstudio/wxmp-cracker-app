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

case "$TARGET_TRIPLE:$(uname -m)" in
  aarch64-apple-darwin:arm64|x86_64-apple-darwin:x86_64) ;;
  *-apple-darwin:*)
    echo "ERROR: PyInstaller cannot cross-build macOS binaries." >&2
    echo "Run this script on a host matching $TARGET_TRIPLE, or via Rosetta for x86_64." >&2
    exit 1
    ;;
esac

# Create a temporary venv, install wcx + pyinstaller, build
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PYTHON_CANDIDATES=()
if [ -n "${PYTHON_BIN:-}" ]; then
  PYTHON_CANDIDATES+=("$PYTHON_BIN")
fi
if [ -n "${PYTHON:-}" ]; then
  PYTHON_CANDIDATES+=("$PYTHON")
fi
PYTHON_CANDIDATES+=(python3.12 python3.11 python3.10 python3 python)

PYTHON_BIN_RESOLVED=""
for candidate in "${PYTHON_CANDIDATES[@]}"; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    PYTHON_BIN_RESOLVED="$(command -v "$candidate")"
    break
  fi
done

if [ -z "$PYTHON_BIN_RESOLVED" ]; then
  echo "ERROR: Python >= 3.10 is required to build wcx sidecar." >&2
  exit 1
fi

echo "Using Python: $PYTHON_BIN_RESOLVED"
"$PYTHON_BIN_RESOLVED" -m venv "$WORK_DIR/venv"
if [ -f "$WORK_DIR/venv/Scripts/activate" ]; then
  source "$WORK_DIR/venv/Scripts/activate"
else
  source "$WORK_DIR/venv/bin/activate"
fi

python -m pip install --quiet --upgrade pip
python -m pip install --quiet --retries 5 --timeout 120 pyinstaller "$WCX_DIR"

ENTRYPOINT="$WORK_DIR/wcx_entry.py"
cat > "$ENTRYPOINT" <<'PY'
from wcx.cli import app

app()
PY

PYINSTALLER_ARGS=(
  --noconfirm
  --onefile
  --name wcx
  --distpath "$WORK_DIR/dist"
  --workpath "$WORK_DIR/build"
  --specpath "$WORK_DIR"
  --hidden-import wcx.article
  --hidden-import wcx.cache
  --hidden-import wcx.config
  --hidden-import wcx.fetcher
  --hidden-import wcx.exporters
  --hidden-import wcx.cli
  --collect-all curl_cffi
  --console
)

if [[ "$TARGET_TRIPLE" == *apple-darwin ]]; then
  CODESIGN_IDENTITY="${PYINSTALLER_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
  ENTITLEMENTS_FILE="$PROJECT_ROOT/src-tauri/Entitlements.plist"
  if [ -n "$CODESIGN_IDENTITY" ]; then
    PYINSTALLER_ARGS+=(--codesign-identity "$CODESIGN_IDENTITY")
    if [ -f "$ENTITLEMENTS_FILE" ]; then
      PYINSTALLER_ARGS+=(--osx-entitlements-file "$ENTITLEMENTS_FILE")
    fi
  fi
fi

# Build frozen binary
pyinstaller "${PYINSTALLER_ARGS[@]}" "$ENTRYPOINT"

# Copy to Tauri binaries dir with target triple suffix
mkdir -p "$BINARIES_DIR"
SUFFIX=""
if [[ "$TARGET_TRIPLE" == *windows* ]]; then
  SUFFIX=".exe"
fi

cp "$WORK_DIR/dist/wcx$SUFFIX" "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
chmod +x "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
echo "Built: $BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
ls -lh "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}"
file "$BINARIES_DIR/wcx-${TARGET_TRIPLE}${SUFFIX}" || true
