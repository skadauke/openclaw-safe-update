#!/bin/bash
# install.sh — standalone bootstrapper for openclaw-update tooling.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/skadauke/openclaw-safe-update/main/install.sh | bash
#
# Usage (from a local checkout):
#   ./install.sh
#
# Idempotent — safe to re-run at any time.
#
# Environment variable overrides:
#   OPENCLAW_DIR             override ~/.openclaw
#   OPENCLAW_BIN_DIR         override ~/.openclaw/bin
#   OPENCLAW_UPDATE_DATA_DIR override data dir (clone target)
#   NODE                     override node binary path
#   NPM                      override npm binary path

set -uo pipefail

REPO_URL="https://github.com/skadauke/openclaw-safe-update"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
ALL_TOOLS=(openclaw-update openclaw-rollback openclaw-smoketest safe-config-edit safe-doctor-fix safe-state)

die()  { echo ""; echo "ERROR: $*" >&2; echo ""; exit 1; }
log()  { echo "[install] $*"; }
ok()   { echo "  ✓ $*"; }
skip() { echo "  · [skip] $*"; }
warn() { echo "  ! $*"; }

echo ""
echo "openclaw-update bootstrapper"
echo "============================"
echo ""

# ── Step 1: Detect openclaw ─────────────────────────────────────────────────
log "Step 1 — Checking for openclaw..."

command -v openclaw &>/dev/null \
  || die "openclaw not found on PATH. Install openclaw first, then re-run this script."

OPENCLAW_VERSION=$(openclaw --version 2>/dev/null \
  | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1 || true)
if [[ -z "$OPENCLAW_VERSION" ]]; then
  OPENCLAW_VERSION=$(openclaw --version 2>/dev/null | head -1 | tr -d '\n' || echo "unknown")
fi
ok "openclaw $OPENCLAW_VERSION is installed."

[[ -d "$OPENCLAW_DIR" ]] \
  || die "$OPENCLAW_DIR not found. Has openclaw been initialized?"

BIN_DST="${OPENCLAW_BIN_DIR:-$OPENCLAW_DIR/bin}"

# ── Step 2: Detect install method ──────────────────────────────────────────
log "Step 2 — Detecting openclaw install method..."

INSTALL_METHOD="unknown"
OPENCLAW_INSTALL_DIR=""
NODE="${NODE:-$(command -v node 2>/dev/null || echo "")}"
NPM="${NPM:-$(command -v npm 2>/dev/null || echo "")}"

if [[ -n "$NPM" ]]; then
  _npm_root=$("$NPM" root -g 2>/dev/null || echo "")
  if [[ -n "$_npm_root" && -d "$_npm_root/openclaw" ]]; then
    INSTALL_METHOD="npm"
    OPENCLAW_INSTALL_DIR="$_npm_root/openclaw"
    ok "npm global install: $OPENCLAW_INSTALL_DIR"
  fi
fi

if [[ "$INSTALL_METHOD" == "unknown" ]]; then
  _openclaw_bin=$(command -v openclaw 2>/dev/null || echo "")
  if [[ -n "$_openclaw_bin" ]]; then
    _resolved="$_openclaw_bin"
    if [[ -L "$_openclaw_bin" ]]; then
      _link=$(readlink "$_openclaw_bin")
      [[ "$_link" != /* ]] && _link="$(dirname "$_openclaw_bin")/$_link"
      _resolved="$_link"
    fi
    if echo "$_resolved" | grep -q "\.openclaw"; then
      INSTALL_METHOD="managed"
      ok "Managed versioned install detected."
    elif [[ -d "$(dirname "$_resolved")/../.git" ]]; then
      INSTALL_METHOD="git"
      OPENCLAW_INSTALL_DIR="$(cd "$(dirname "$_resolved")/.." && pwd)"
      ok "Git checkout install: $OPENCLAW_INSTALL_DIR"
    fi
  fi
fi

[[ "$INSTALL_METHOD" == "unknown" ]] && warn "Install method not detected — continuing anyway."
[[ -z "$NODE" ]] && warn "node not found on PATH."
[[ -z "$NPM"  ]] && warn "npm not found on PATH."

# ── Step 3: Clone or update openclaw-update tooling ────────────────────────
log "Step 3 — Setting up openclaw-update repo..."

case "$(uname -s)" in
  Darwin) _default_data="$HOME/Library/Application Support/openclaw-update" ;;
  *)      _default_data="$HOME/.local/share/openclaw-update" ;;
esac
DATA_DIR="${OPENCLAW_UPDATE_DATA_DIR:-$_default_data}"

# If BASH_SOURCE[0] resolves to a directory that looks like our repo,
# use it directly (local dev / running ./install.sh from a checkout).
_LOCAL_CHECKOUT=""
_script="${BASH_SOURCE[0]:-}"
if [[ -n "$_script" && "$_script" != "-" ]]; then
  _dir="$(cd "$(dirname "$_script")" 2>/dev/null && pwd)" || true
  if [[ -n "$_dir" && -d "$_dir/.git" && -d "$_dir/bin" ]]; then
    _LOCAL_CHECKOUT="$_dir"
  fi
fi

if [[ -n "$_LOCAL_CHECKOUT" ]]; then
  DATA_DIR="$_LOCAL_CHECKOUT"
  ok "Using local checkout at $DATA_DIR."
elif [[ -d "$DATA_DIR/.git" ]]; then
  log "  Updating existing clone at $DATA_DIR..."
  if git -C "$DATA_DIR" pull --ff-only 2>&1 | sed 's/^/    /'; then
    ok "Up to date ($(git -C "$DATA_DIR" rev-parse --short HEAD 2>/dev/null || echo 'HEAD'))."
  else
    warn "git pull --ff-only failed (local modifications?). Using existing state."
  fi
else
  log "  Cloning $REPO_URL → $DATA_DIR..."
  mkdir -p "$(dirname "$DATA_DIR")"
  git clone "$REPO_URL" "$DATA_DIR" 2>&1 | sed 's/^/    /' \
    || die "git clone failed. Check network access and try again."
  ok "Cloned to $DATA_DIR."
fi

BIN_SRC="$DATA_DIR/bin"
MIGRATE_SCRIPT="$DATA_DIR/migrate-to-versioned.sh"

[[ -d "$BIN_SRC" ]] \
  || die "bin/ not found in $DATA_DIR — clone may be incomplete."

# ── Step 4: Wire symlinks ───────────────────────────────────────────────────
log "Step 4 — Wiring symlinks into $BIN_DST..."

mkdir -p "$BIN_DST"

for tool in "${ALL_TOOLS[@]}"; do
  src="$BIN_SRC/$tool"
  dst="$BIN_DST/$tool"

  if [[ ! -f "$src" ]]; then
    warn "Source missing: $src — skipping."
    continue
  fi
  [[ -x "$src" ]] || chmod +x "$src"

  if [[ -L "$dst" ]] && [[ "$(readlink "$dst")" == "$src" ]]; then
    skip "$tool — already linked"
    continue
  fi

  if [[ -e "$dst" && ! -L "$dst" ]]; then
    _backup="${dst}.pre-install-$(date +%Y%m%dT%H%M%S)"
    mv "$dst" "$_backup"
    log "  Moved existing $tool → $(basename "$_backup")"
  fi

  ln -sfn "$src" "$dst"
  ok "$tool"
done

# ── Step 5: Migration check ─────────────────────────────────────────────────
log "Step 5 — Checking migration status..."

if [[ -L "$OPENCLAW_DIR/current" ]]; then
  _current_target=$(readlink "$OPENCLAW_DIR/current")
  ok "Versioned layout active: ~/.openclaw/current → $_current_target"
elif [[ -d "$OPENCLAW_DIR/versions" ]]; then
  warn "versions/ exists but ~/.openclaw/current symlink is missing — migration may be incomplete."
  echo "  Run to finish: bash $MIGRATE_SCRIPT"
else
  echo ""
  echo "  ~/.openclaw is not on the versioned layout yet."
  if [[ -f "$MIGRATE_SCRIPT" ]]; then
    if [[ -t 0 ]]; then
      echo "  migrate-to-versioned.sh converts your existing install to the versioned layout."
      read -rp "  Run it now? [yes/no]: " _RUN_MIGRATE
      if [[ "$_RUN_MIGRATE" == "yes" ]]; then
        bash "$MIGRATE_SCRIPT"
      else
        echo "  Skipped. Run when ready: bash $MIGRATE_SCRIPT"
      fi
    else
      echo "  (Non-interactive — run manually: bash $MIGRATE_SCRIPT)"
    fi
  else
    warn "migrate-to-versioned.sh not found in $DATA_DIR."
  fi
fi

# ── Step 6: Verify PATH ─────────────────────────────────────────────────────
log "Step 6 — Verifying PATH..."

PATH_LINE="export PATH=\"\$HOME/.openclaw/bin:\$PATH\""

if [[ ":$PATH:" == *":$BIN_DST:"* ]]; then
  ok "$BIN_DST is on PATH."
else
  warn "$BIN_DST is NOT on PATH in this shell."

  # Check if it's already configured in a shell rc file
  _rc_files=()
  [[ -f "$HOME/.zshrc" ]]   && _rc_files+=("$HOME/.zshrc")
  [[ -f "$HOME/.bashrc" ]]  && _rc_files+=("$HOME/.bashrc")
  [[ -f "$HOME/.profile" ]] && _rc_files+=("$HOME/.profile")

  _already_in=""
  for _rc in "${_rc_files[@]}"; do
    if grep -q '\.openclaw/bin' "$_rc" 2>/dev/null; then
      _already_in="$_rc"
      break
    fi
  done

  if [[ -n "$_already_in" ]]; then
    ok "PATH entry found in $_already_in — restart your shell to activate."
  elif [[ -t 0 ]]; then
    if [[ ${#_rc_files[@]} -gt 0 ]]; then
      _target_rc="${_rc_files[0]}"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      _target_rc="$HOME/.zshrc"
    else
      _target_rc="$HOME/.bashrc"
    fi
    echo ""
    echo "  Add ~/.openclaw/bin to PATH in $_target_rc?"
    read -rp "  [yes/no]: " _ADD_PATH
    if [[ "$_ADD_PATH" == "yes" ]]; then
      printf '\n# openclaw-update tools\n%s\n' "$PATH_LINE" >> "$_target_rc"
      ok "Added to $_target_rc. Run: source $_target_rc"
    else
      echo "  Add manually: $PATH_LINE"
    fi
  else
    echo "  Add to your shell rc:"
    echo "    $PATH_LINE"
  fi
fi

# ── Step 7: Summary ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  openclaw-update installed!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Tools in $BIN_DST:"
for tool in "${ALL_TOOLS[@]}"; do
  if [[ -L "$BIN_DST/$tool" ]]; then
    echo "    ✓ $tool"
  else
    echo "    ✗ $tool (missing)"
  fi
done
echo ""
echo "  Next steps:"
echo "    openclaw-update status"
echo "    openclaw-update check"
echo ""
echo "  Re-run to update:"
echo "    curl -fsSL https://raw.githubusercontent.com/skadauke/openclaw-safe-update/main/install.sh | bash"
echo ""
