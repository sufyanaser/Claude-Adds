#!/bin/bash
# Installs the latest Claude Adds release into /Applications on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/sufyanaser/Claude-Adds/main/scripts/install-mac.sh | bash
#
# The app is ad-hoc signed, not notarized by Apple. This script clears the
# download quarantine flag so it opens without the Gatekeeper prompt.
set -euo pipefail

REPO="sufyanaser/Claude-Adds"
APP="Claude Adds.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unsupported processor: $(uname -m)" >&2; exit 1 ;;
esac

echo "Looking up the latest release for mac-$ARCH..."
URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o "\"browser_download_url\": *\"[^\"]*mac-$ARCH\.dmg\"" \
  | sed 's/.*"\(https[^"]*\)"/\1/' \
  | head -n 1)"

if [ -z "$URL" ]; then
  echo "No macOS package for $ARCH was found in the latest release." >&2
  echo "See https://github.com/$REPO/releases" >&2
  exit 1
fi

WORK="$(mktemp -d)"
MOUNT="$WORK/mount"
cleanup() {
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Downloading $URL"
curl -fL --progress-bar -o "$WORK/claude-adds.dmg" "$URL"

mkdir -p "$MOUNT"
hdiutil attach "$WORK/claude-adds.dmg" -mountpoint "$MOUNT" -nobrowse -quiet

if [ ! -d "$MOUNT/$APP" ]; then
  echo "The disk image does not contain $APP." >&2
  exit 1
fi

DEST="/Applications"
if [ ! -w "$DEST" ]; then
  DEST="$HOME/Applications"
  mkdir -p "$DEST"
fi

# Replace an earlier copy of this app only.
rm -rf "$DEST/$APP"
cp -R "$MOUNT/$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

echo "Installed: $DEST/$APP"
echo "Start it with: open \"$DEST/$APP\""
