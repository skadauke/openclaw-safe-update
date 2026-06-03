#!/bin/bash
# install.sh — wire openclaw-update tooling into the managed install.
#
# Idempotent. Run after migrate-to-versioned.sh (or any time the symlinks go
# stale). Creates ~/.openclaw/bin/{openclaw-update,openclaw-rollback,openclaw-smoketest}
# pointing at the live source in this clawd-resilience checkout.
#
# Source of truth lives in git (~/clawd/clawd-resilience/openclaw-update/bin/).
# Symlinks let PATH find them without leaking clawd's layout into the shell.

set -uo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_SRC="$SCRIPT_DIR/bin"
BIN_DST="$OPENCLAW_DIR/bin"

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[install] $*"; }
ok()  { echo "  ✓ $*"; }
skip(){ echo "  · [skip] $*"; }

[[ -d "$BIN_SRC" ]] || die "$BIN_SRC not found. Are you running from clawd-resilience?"
[[ -d "$OPENCLAW_DIR" ]] || die "$OPENCLAW_DIR not found. Has openclaw been installed?"

mkdir -p "$BIN_DST"

for tool in openclaw-update openclaw-rollback openclaw-smoketest; do
  src="$BIN_SRC/$tool"
  dst="$BIN_DST/$tool"
  [[ -f "$src" ]] || { echo "  ✗ source missing: $src"; continue; }
  [[ -x "$src" ]] || chmod +x "$src"

  if [[ -L "$dst" ]] && [[ "$(readlink "$dst")" == "$src" ]]; then
    skip "$tool — already symlinked"
    continue
  fi
  if [[ -e "$dst" ]] && [[ ! -L "$dst" ]]; then
    backup="${dst}.pre-install-$(date +%Y%m%dT%H%M%S)"
    mv "$dst" "$backup"
    log "  moved existing $tool aside → $(basename "$backup")"
  fi
  ln -sfn "$src" "$dst"
  ok "$tool → $src"
done

echo
echo "Verifying PATH..."
if [[ ":$PATH:" == *":$BIN_DST:"* ]]; then
  ok "$BIN_DST is on PATH"
else
  echo "  ✗ $BIN_DST is NOT on PATH for this shell."
  echo "    Add to ~/.zshrc (or equivalent):"
  echo "      export PATH=\"\$HOME/.openclaw/bin:\$PATH\""
  echo "    Then start a new shell."
fi

echo
echo "Done. Verify with:"
echo "  which openclaw-update     # expected: $BIN_DST/openclaw-update"
echo "  openclaw-update status"
