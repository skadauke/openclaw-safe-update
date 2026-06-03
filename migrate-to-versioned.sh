#!/bin/bash
# migrate-to-versioned.sh — one-time switchover from brew npm install to versioned layout.
#
# SAFE TO RE-RUN — idempotent for each step. Steps are labelled and skipped if already done.
# Gateway downtime is ≤30s (steps D–E).
#
# Recovery if something goes wrong:
#   launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
#   cp ~/Library/LaunchAgents/ai.openclaw.gateway.plist.pre-migrate-<TS> \
#      ~/Library/LaunchAgents/ai.openclaw.gateway.plist
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
#
# After running this script:
#   1. Use 'openclaw-update' for future updates (never 'npm install -g openclaw').
#   2. Add ~/.openclaw/bin to the front of your PATH in ~/.zshrc.

set -uo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
BREW_MODULE_DIR="/opt/homebrew/lib/node_modules/openclaw"
BREW_BIN="/opt/homebrew/bin/openclaw"
NODE=/opt/homebrew/bin/node
LAUNCHD_LABEL="ai.openclaw.gateway"
PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKETEST="$SCRIPT_DIR/bin/openclaw-smoketest"

die() { echo ""; echo "FATAL: $*" >&2; echo ""; echo "Manual recovery:"; echo "  launchctl bootout gui/\$(id -u)/$LAUNCHD_LABEL 2>/dev/null"; echo "  cp $PLIST.pre-migrate-* $PLIST"; echo "  launchctl bootstrap gui/\$(id -u) $PLIST"; exit 1; }
log() { echo "[migrate] $*"; }
ok() { echo "  ✓ $*"; }
skip() { echo "  · [skip] $*"; }

echo ""
echo "openclaw versioned install migration"
echo "====================================="
echo ""
echo "This script converts the openclaw install from a global brew/npm install"
echo "to a versioned layout under ~/.openclaw/versions/."
echo ""

# ── Pre-flight checks ───────────────────────────────────────────────────────
log "Pre-flight checks..."

# Check brew install exists
[[ -d "$BREW_MODULE_DIR" ]] || die "$BREW_MODULE_DIR not found. Is openclaw installed via brew npm?"
[[ -L "$BREW_BIN" ]] || [[ -f "$BREW_BIN" ]] || die "$BREW_BIN not found."
[[ -d "$OPENCLAW_DIR" ]] || die "$OPENCLAW_DIR not found."
[[ -O "$OPENCLAW_DIR" ]] || die "$OPENCLAW_DIR not owned by $(whoami). Check permissions."
[[ -f "$PLIST" ]] || die "Gateway plist not found at $PLIST."

# Bonjour MUST be disabled at either the env-var or config layer (ideally both).
# Without this, the gateway crashes in a loop on macOS due to mDNS issues
# ("CIAO ANNOUNCEMENT CANCELLED") and a fresh launchd bootstrap will hang.
ENV_GUARD=0
CFG_GUARD=0
if grep -q "OPENCLAW_DISABLE_BONJOUR" "$PLIST" && grep -A1 "OPENCLAW_DISABLE_BONJOUR" "$PLIST" | grep -q "<string>1</string>"; then
  ENV_GUARD=1
fi
if [[ -f "$OPENCLAW_DIR/openclaw.json" ]]; then
  CFG_GUARD=$(python3 -c "
import json, sys
try:
  c = json.load(open('$OPENCLAW_DIR/openclaw.json'))
  print(1 if c.get('discovery',{}).get('mdns',{}).get('mode') == 'off' else 0)
except Exception:
  print(0)
")
fi
if [[ "$ENV_GUARD" != "1" && "$CFG_GUARD" != "1" ]]; then
  die "Bonjour is NOT disabled. Set either OPENCLAW_DISABLE_BONJOUR=1 in $PLIST or discovery.mdns.mode=off in $OPENCLAW_DIR/openclaw.json before migrating."
fi
ok "Bonjour guard: env=$ENV_GUARD config=$CFG_GUARD"

# Get current version from the installed package
CURRENT_VER=$("$NODE" "$BREW_MODULE_DIR/openclaw.mjs" --version 2>/dev/null | grep -oE '[0-9]{4}\.[0-9]+\.[0-9]+' | head -1)
[[ -n "$CURRENT_VER" ]] || die "Could not determine current version from $BREW_MODULE_DIR"

VERSIONS_DIR="$OPENCLAW_DIR/versions"
TARGET_DIR="$VERSIONS_DIR/$CURRENT_VER"
STUB_FINGERPRINT="openclaw is managed by openclaw-update"

ok "Current version: $CURRENT_VER"
ok "Target directory: $TARGET_DIR"

# Check if already migrated — requires BOTH the current symlink AND the
# launchd plist to be on the versioned path. An interrupted migration may have
# created the symlink but had the plist rolled back; in that case we resume.
if [[ -L "$OPENCLAW_DIR/current" ]]; then
  RESOLVED=$(readlink -f "$OPENCLAW_DIR/current" 2>/dev/null || echo "")
  if [[ "$RESOLVED" == *"$CURRENT_VER"* ]] && grep -q "openclaw/current" "$PLIST"; then
    echo ""
    echo "Already migrated to versioned layout (current → $CURRENT_VER, plist on versioned path)."
    echo "Nothing to do. Use 'openclaw-update' for future updates."
    exit 0
  fi
  if [[ "$RESOLVED" == *"$CURRENT_VER"* ]] && ! grep -q "openclaw/current" "$PLIST"; then
    echo ""
    echo "Detected partial migration (symlink set, plist on brew path) — resuming."
    echo ""
  fi
fi

echo ""
echo "Plan:"
echo "  A. Copy $BREW_MODULE_DIR → $TARGET_DIR"
echo "  B. Create ~/.openclaw/current → versions/$CURRENT_VER"
echo "  C. Create ~/.openclaw/bin/openclaw wrapper"
echo "  D. Update launchd plist to use symlinked path [≤30s downtime]"
echo "  E. Run live smoketest — abort and restore plist if it fails"
echo "  F. Neuter brew openclaw binary (replace with stub)"
echo "  G. Remind you to update PATH in ~/.zshrc"
echo ""
read -rp "Proceed? [yes/no]: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 0; }
echo ""

# ── Step A — Copy current install into versioned layout ────────────────────
log "Step A — Copying openclaw $CURRENT_VER into $TARGET_DIR ..."

if [[ -d "$TARGET_DIR/lib/node_modules/openclaw" ]]; then
  skip "Target dir already exists — skipping copy."
else
  mkdir -p "$TARGET_DIR/lib/node_modules"
  cp -a "$BREW_MODULE_DIR" "$TARGET_DIR/lib/node_modules/openclaw"
  mkdir -p "$TARGET_DIR/bin"
  # Create a bin/openclaw shim inside the versioned dir (mirrors what npm --prefix would make)
  ln -sf "../lib/node_modules/openclaw/openclaw.mjs" "$TARGET_DIR/bin/openclaw"
  ok "Copied. (~$(du -sh "$TARGET_DIR" 2>/dev/null | cut -f1))"
fi

# Seed an initial state-snapshot for this baseline version so a future rollback
# (even one targeting the baseline) has the "last known good" config to restore.
if [[ -f "$SCRIPT_DIR/lib/state-snapshot.sh" ]]; then
  # shellcheck source=lib/state-snapshot.sh
  source "$SCRIPT_DIR/lib/state-snapshot.sh"
  snapshot_state "$TARGET_DIR" "$OPENCLAW_DIR" >/dev/null && ok "Initial state snapshot seeded."
fi

# ── Step B — Create current + previous symlinks ─────────────────────────────
log "Step B — Creating symlinks..."

if [[ ! -L "$OPENCLAW_DIR/current" ]]; then
  ln -sfn "versions/$CURRENT_VER" "$OPENCLAW_DIR/current"
  ok "~/.openclaw/current → versions/$CURRENT_VER"
else
  skip "current symlink already exists: $(readlink "$OPENCLAW_DIR/current")"
fi

if [[ ! -L "$OPENCLAW_DIR/previous" ]]; then
  ln -sfn "versions/$CURRENT_VER" "$OPENCLAW_DIR/previous"
  ok "~/.openclaw/previous → versions/$CURRENT_VER (same as current initially)"
else
  skip "previous symlink already exists: $(readlink "$OPENCLAW_DIR/previous")"
fi

# ── Step C — Create managed wrapper ─────────────────────────────────────────
log "Step C — Creating ~/.openclaw/bin/openclaw wrapper..."

mkdir -p "$OPENCLAW_DIR/bin"
WRAPPER="$OPENCLAW_DIR/bin/openclaw"
if [[ -f "$WRAPPER" ]]; then
  skip "Wrapper already exists."
else
  cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/bin/sh
# Managed openclaw wrapper — resolves current version via ~/.openclaw/current symlink.
exec /opt/homebrew/bin/node "$HOME/.openclaw/current/lib/node_modules/openclaw/openclaw.mjs" "$@"
WRAPPER_EOF
  chmod +x "$WRAPPER"
  ok "~/.openclaw/bin/openclaw created."
fi

# ── Step D — Update launchd plist ───────────────────────────────────────────
log "Step D — Updating launchd plist (≤30s gateway downtime)..."

TS=$(date +%Y%m%dT%H%M%S)
PLIST_BACKUP="${PLIST}.pre-migrate-${TS}"

if grep -q "openclaw/current" "$PLIST"; then
  skip "Plist already points at versioned path."
else
  cp "$PLIST" "$PLIST_BACKUP"
  ok "Plist backed up to $PLIST_BACKUP"

  # Build the new plist by replacing the hard-coded brew paths with the symlinked path.
  NEW_ENTRY="$HOME/.openclaw/current/lib/node_modules/openclaw/dist/index.js"
  sed -i '' \
    "s|/opt/homebrew/lib/node_modules/openclaw/dist/index.js|$NEW_ENTRY|g" \
    "$PLIST"

  # Drop the hard-coded version env var — it would lie after version changes.
  python3 - "$PLIST" <<'PYEOF'
import sys, re
p = sys.argv[1]
txt = open(p).read()
# Remove the OPENCLAW_SERVICE_VERSION key-value pair block
txt = re.sub(
  r'<key>OPENCLAW_SERVICE_VERSION</key>\s*<string>[^<]*</string>\s*',
  '',
  txt
)
open(p, 'w').write(txt)
PYEOF

  ok "Plist updated to use ~/.openclaw/current/..."
  log "Restarting gateway..."
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  # Wait for the previous process to actually release port 18789 before bootstrapping.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/tmp/launchctl-bootstrap.err; then
    log "  launchctl bootstrap failed: $(cat /tmp/launchctl-bootstrap.err)"
    log "  Trying legacy launchctl load..."
    launchctl load "$PLIST" || die "Both bootstrap and load failed. Gateway is NOT running. Restore manually: cp $PLIST_BACKUP $PLIST && launchctl bootstrap gui/\$(id -u) $PLIST"
  fi
  # Poll for /healthz instead of fixed sleep — gateway boot varies 8-25s.
  log "  Waiting for /healthz to come up..."
  GATEWAY_UP=0
  for i in $(seq 1 40); do
    if curl -sf --max-time 1 http://127.0.0.1:18789/healthz | grep -q '"ok":true' 2>/dev/null; then
      GATEWAY_UP=1
      ok "Gateway healthy after ${i}s."
      break
    fi
    sleep 1
  done
  if [[ "$GATEWAY_UP" != "1" ]]; then
    log "  Gateway did not respond on /healthz within 40s — proceeding to smoketest anyway (it has its own retry)."
  fi
fi

# ── Step E — Live smoketest ──────────────────────────────────────────────────
# Skip test 10 (install-drift): brew binary stub isn't installed yet (Step F).
log "Step E — Running live smoketest..."

restore_plist_and_die() {
  local reason="$1"
  echo ""
  echo "SMOKETEST FAILED ($reason). Restoring original plist..."
  launchctl bootout "gui/$(id -u)/$LAUNCHD_LABEL" 2>/dev/null || true
  # Wait for port release before re-bootstrapping the original
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
  cp "$PLIST_BACKUP" "$PLIST"
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/tmp/launchctl-bootstrap-rollback.err; then
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  CRITICAL: Rollback bootstrap failed!"
    echo "  $(cat /tmp/launchctl-bootstrap-rollback.err)"
    echo ""
    echo "  Gateway is NOT running. Manual recovery:"
    echo "    launchctl bootout gui/\$(id -u)/$LAUNCHD_LABEL 2>/dev/null"
    echo "    sleep 5"
    echo "    launchctl bootstrap gui/\$(id -u) $PLIST"
    echo "═══════════════════════════════════════════════════════════"
    exit 2
  fi
  # Verify rollback gateway actually comes back up
  echo "  Waiting for rolled-back gateway to come up..."
  for i in $(seq 1 40); do
    if curl -sf --max-time 1 http://127.0.0.1:18789/healthz | grep -q '"ok":true' 2>/dev/null; then
      echo "  ✓ Rolled-back gateway healthy after ${i}s."
      die "$reason — plist restored, gateway back on old path."
    fi
    sleep 1
  done
  echo "  ✗ Rolled-back gateway did NOT come up within 40s either!"
  die "$reason — and rollback gateway did not come up. Manual intervention required: tail $OPENCLAW_DIR/logs/gateway.log"
}

if [[ -f "$SMOKETEST" ]]; then
  if "$NODE" "$SMOKETEST" --quick --skip 10; then
    ok "Smoketest passed."
  else
    restore_plist_and_die "smoketest failed on new versioned install"
  fi
else
  log "Smoketest script not found — skipping (verify gateway manually)."
fi

# ── Step F — Neuter brew binary ──────────────────────────────────────────────
log "Step F — Neutering brew openclaw binary..."

if [[ -f "$BREW_BIN" ]] && grep -q "$STUB_FINGERPRINT" "$BREW_BIN" 2>/dev/null; then
  skip "Brew binary is already our stub."
else
  # Remove the old package from brew's npm first (copies are in versioned dir)
  log "  Uninstalling from brew npm (this is safe — we already copied everything)..."
  /opt/homebrew/bin/npm uninstall -g openclaw 2>&1 | sed 's/^/    /' || true

  # If the binary still exists after uninstall (shouldn't, but be safe), replace it.
  # If it was cleaned up, recreate as stub.
  cat > "$BREW_BIN" << STUB_EOF
#!/bin/sh
echo "$STUB_FINGERPRINT" >&2
echo "Run: \$HOME/.openclaw/bin/openclaw or: openclaw-update" >&2
exit 64
STUB_EOF
  chmod +x "$BREW_BIN"
  ok "Brew binary replaced with stub."
fi

# ── Step G — PATH reminder ────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Migration complete!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Versioned install: $TARGET_DIR"
echo "  Active version:    $CURRENT_VER (via ~/.openclaw/current)"
echo "  Plist backup:      $PLIST_BACKUP"
echo ""
echo "  One manual step — add to your ~/.zshrc (if not already):"
echo ""
echo "    export PATH=\"\$HOME/.openclaw/bin:\$PATH\""
echo ""
echo "  After sourcing, 'which openclaw' should return:"
echo "    $HOME/.openclaw/bin/openclaw"
echo ""
echo "  Future updates:"
echo "    openclaw-update              (interactive)"
echo "    openclaw-update check        (is a new version available?)"
echo ""
echo "  To roll back quickly if something goes wrong:"
echo "    openclaw-rollback"
echo ""

# Update versions manifest
MANIFEST="$OPENCLAW_DIR/versions-manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  cat > "$MANIFEST" << EOF
{
  "schema": 1,
  "current": "$CURRENT_VER",
  "previous": "$CURRENT_VER",
  "events": [
    {
      "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "event": "migrate",
      "version": "$CURRENT_VER",
      "note": "Initial migration from brew global install"
    }
  ]
}
EOF
  ok "versions-manifest.json created."
fi
