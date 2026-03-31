#!/usr/bin/env bash
# build-macos.sh — Build, sign, and notarize the Edith macOS app
#
# Required environment variables (set in CI or locally):
#
#   APPLE_CERTIFICATE           Base64-encoded .p12 certificate file
#   APPLE_CERTIFICATE_PASSWORD  Password for the .p12 file
#   APPLE_SIGNING_IDENTITY      Certificate CN, e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID                    Your Apple ID email
#   APPLE_PASSWORD              App-specific password for notarization
#   APPLE_TEAM_ID               10-character Apple Team ID
#
# Usage:
#   ./desktop/scripts/build-macos.sh
#
# Output:
#   desktop/src-tauri/target/release/bundle/dmg/Edith_*.dmg  (signed + notarized)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Validate required env vars ────────────────────────────────────────────────
required_vars=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: required env var $var is not set" >&2
    exit 1
  fi
done

# ── Import signing certificate into a temporary keychain ─────────────────────
KEYCHAIN_PATH="$TMPDIR/edith-build.keychain"
KEYCHAIN_PASSWORD="$(openssl rand -hex 16)"
CERT_PATH="$TMPDIR/edith-cert.p12"

echo "==> Importing signing certificate..."
echo "$APPLE_CERTIFICATE" | base64 --decode > "$CERT_PATH"

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

security import "$CERT_PATH" \
  -k "$KEYCHAIN_PATH" \
  -P "$APPLE_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

security set-key-partition-list \
  -S apple-tool:,apple:,codesign: \
  -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

# Add temporary keychain to the search list
security list-keychains -d user -s "$KEYCHAIN_PATH" "$(security list-keychains -d user | tr -d '"' | xargs)"

cleanup() {
  echo "==> Cleaning up keychain..."
  security delete-keychain "$KEYCHAIN_PATH" || true
  rm -f "$CERT_PATH"
}
trap cleanup EXIT

# ── Store notarization credentials in the keychain ───────────────────────────
xcrun notarytool store-credentials "edith-notarization" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_PASSWORD" \
  --keychain "$KEYCHAIN_PATH"

# ── Build the app with Tauri ──────────────────────────────────────────────────
echo "==> Building Edith desktop app..."
cd "$DESKTOP_DIR"

APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  bunx tauri build --target universal-apple-darwin

# ── Locate the built DMG ─────────────────────────────────────────────────────
DMG_PATH="$(find "$DESKTOP_DIR/src-tauri/target/universal-apple-darwin/release/bundle/dmg" \
  -name "*.dmg" -maxdepth 1 | head -1)"

if [[ -z "$DMG_PATH" ]]; then
  echo "ERROR: No DMG found after build" >&2
  exit 1
fi

echo "==> Built DMG: $DMG_PATH"

# ── Notarize the DMG ─────────────────────────────────────────────────────────
echo "==> Submitting to Apple for notarization..."
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "edith-notarization" \
  --keychain "$KEYCHAIN_PATH" \
  --wait

echo "==> Stapling notarization ticket..."
xcrun stapler staple "$DMG_PATH"

echo ""
echo "✓ Build complete: $DMG_PATH"
echo "  Verify with: spctl -a -vvv -t install \"$DMG_PATH\""
