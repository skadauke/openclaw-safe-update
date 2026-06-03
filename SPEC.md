# openclaw-update — Safe Update System for OpenClaw

**Status:** SPEC (2026-05-30). Build in progress.

**Goal:** Make openclaw updates safe — staged install, fast rollback, post-update verification, and forensics on failure. Eliminate the "blind in-place upgrade that may brick the gateway" failure mode.

**Lives at:** `~/clawd/clawd-resilience/openclaw-update/`.

---

## 1. The problem in two pieces

### 1.1 Blast-radius problem
Current install: `npm install -g openclaw@latest` overwrites `/opt/homebrew/lib/node_modules/openclaw/` in place. No previous version exists to roll back to. Test = "is the gateway still up after the update?". Found-out-too-late failure.

### 1.2 Rescue-channel problem
When the gateway dies, Telegram dies with it. That used to leave Stephan with no remote way to act. **Already solved** — Stephan has Jump Desktop + Moby-Dock as independent sudo-shell paths. We only need a one-command rollback inside that shell, not a separate Telegram bot.

These two problems shape everything below.

---

## 2. Current state (as discovered 2026-05-30)

- Install: `npm install -g openclaw` via Homebrew's npm.
- Package: `/opt/homebrew/lib/node_modules/openclaw/` (~85 MB).
- Binary symlink: `/opt/homebrew/bin/openclaw → ../lib/node_modules/openclaw/openclaw.mjs`.
- Current version: `2026.4.24`.
- Gateway plist: `~/Library/LaunchAgents/ai.openclaw.gateway.plist`. Hard-codes:
  - `/opt/homebrew/bin/node`
  - `/opt/homebrew/lib/node_modules/openclaw/dist/index.js`
  - `OPENCLAW_SERVICE_VERSION=2026.4.24` (drifts when openclaw updates)
- State: `~/.openclaw/` — credentials, devices, sessions, telegram, etc. **Shared across versions, never moves.**
- Existing safety nets (already in place):
  - `openclaw.json.last-good`, `openclaw.json.bak.*`, `openclaw.json.clobbered.*` — config snapshots
  - `OPENCLAW_DISABLE_BONJOUR=1` env flag — workaround for known crash
  - Daily `openclaw_version` heartbeat check (compares `openclaw --version` to `npm view openclaw version`)

---

## 3. Target architecture

### 3.1 Versioned install layout

```
~/.openclaw/                           # state dir (unchanged, shared across versions)
  current → versions/2026.4.24/        # symlink, atomic swap
  previous → versions/2026.3.15/       # symlink, written on every promote
  versions/
    2026.3.15/                         # previous
      lib/node_modules/openclaw/
      bin/openclaw
    2026.4.24/                         # active
    2026.5.30/                         # staged or promoted-then-rolled-back
  versions-manifest.json               # ledger of versions, install dates, promote/rollback events
```

Each `versions/<version>/` is the output of `npm install --prefix ~/.openclaw/versions/<version>/ openclaw@<version>`. Self-contained, including node_modules.

### 3.2 Launchd plist points at the symlink

```xml
<string>/opt/homebrew/bin/node</string>
<string>/Users/skadauke/.openclaw/current/lib/node_modules/openclaw/dist/index.js</string>
```

launchd resolves the symlink at exec time. Promote = swap symlink + kickstart launchd. The `OPENCLAW_SERVICE_VERSION` env var is dropped (it would lie); a `OPENCLAW_VERSION_SOURCE=symlink` marker replaces it.

### 3.3 Shell PATH

A wrapper script at `~/.openclaw/bin/openclaw` exec's `~/.openclaw/current/lib/node_modules/openclaw/openclaw.mjs`. `~/.openclaw/bin` goes first on `PATH` in the user shell rc. This makes `which openclaw` return the symlinked version regardless of what brew thinks.

### 3.4 The Homebrew install gets neutered

Two-part defense against accidental re-install:

1. `npm uninstall -g openclaw` (clean removal from brew's npm prefix).
2. Replace `/opt/homebrew/bin/openclaw` with a stub:
   ```sh
   #!/bin/sh
   echo "openclaw is managed by openclaw-update. Run: openclaw-update --help" >&2
   exit 64  # EX_USAGE
   ```
   If a future `npm install -g openclaw` recreates the brew symlink, our stub gets overwritten — but `~/.openclaw/bin` is first on PATH, so `which openclaw` still hits our wrapper. **Drift detection in the smoketest catches the brew install** and emits a clear alert.

### 3.5 Rollback is one command

```
openclaw-rollback
```

No flags. Reads `~/.openclaw/previous` symlink, swaps `current → previous`, kickstarts launchd, runs the live smoketest, persists forensics for whatever was just rolled back from.

If `previous` is missing (first install, or already rolled back), it fails loudly with the manual recovery steps.

---

## 4. The smoketest suite

### 4.1 Design

- Each test is one small `.mjs` file in `tests/`.
- Tests output JSON: `{ name, ok, duration_ms, detail }`.
- Orchestrator `lib/smoketest.mjs` runs all tests serially, emits a summary JSON.
- Two modes:
  - **`--target current`** — run against the live gateway (post-promote verification).
  - **`--target sandbox`** — spawn a sandbox gateway on alt port + alt config and run against that.
- `openclaw-update sandbox-test current --config-source <file>` tests proposed config edits against the current installed version before touching live config.
- `--skip <test-id>` to skip individual tests.
- Token-spending intelligence probes are opt-in with `--with-models` until the current gateway CLI route is confirmed stable; they are still part of the suite and should be used for final promotion gates.

### 4.2 Test list

| ID | Name | What it checks |
|----|------|----------------|
| 01 | `binary-spawn` | `node openclaw.mjs --version` exits 0 within 5s |
| 02 | `gateway-health` | `GET http://localhost:<port>/healthz` returns 200 within 10s |
| 03 | `mcp-enumerate` | MCP config/CLI surface is readable; full stdio tool-list handshake is a v2 hardening item |
| 04 | `plugins-load` | Configured plugins (telegram, mcp, …) all report `loaded` or no explicit failures |
| 05 | `skills-discover` | Skill count ≥ baseline and key expected skills are present |
| 06 | `cli-backend-session` ⭐ | Opt-in with `--with-models`: spawn a gateway-backed agent session with a tiny "say ok" prompt |
| 07 | `models-roundtrip` ⭐ | Opt-in with `--with-models`: send a tiny prompt to **each** configured text model in `openclaw.json` (Opus, Sonnet, GPT-5.5, etc). Assert ok. Catches credential/billing/upstream failures. |
| 08 | `bonjour-no-crash` | Watch the gateway log for 10s after start. Fail if `CIAO ANNOUNCEMENT CANCELLED` appears. |
| 09 | `telegram-roundtrip` 🚨 | Core live gate. Post to DM via direct Bot API call (not gateway). Confirms Telegram credentials + Bot API reachability. Included by default for `current` live tests; skip only with explicit `--no-telegram` for sandbox/CI. |
| 10 | `install-drift` | Verify `/opt/homebrew/bin/openclaw` is the stub, `~/.openclaw/current` exists, and interactive zsh resolves `openclaw` to `~/.openclaw/bin/openclaw`. Catches accidental `npm install -g`. |
| 11 | `bundled-plugin-deps` | Run `openclaw doctor` and fail only when missing bundled plugin runtime deps belong to enabled plugins. Catches install-bricking plugin dependency gaps. |
| 12 | `extensions-allowlist` | Fail when local extensions exist but `plugins.allow` is unset/empty. Prevents surprise auto-loading of non-bundled plugins. |
| 13 | `orphan-transcripts` | Threshold diagnostic for orphan transcript files; warns above 100, fails above 1000. |
| 14 | `plugin-config-hygiene` | Fail enabled plugin entries with no manifest, stale disabled plugin config blocks, or installs pointing to missing manifests. |
| 15 | `session-hygiene` | Diagnostic count of transcripts, trajectory pointers, and orphaned trajectory files. |

Test #07 is the answer to "should we talk to all configured models?" — **yes, for final promotion gates**, but not for every heartbeat. It spends a tiny prompt per model, catches credentials/billing/upstream/routing failures, and pulls the model list from `openclaw.json` automatically. During the initial build, `--with-models` exposed a current gateway CLI failure (`Requested agent harness "claude-cli" is not registered`), so the default non-mutating suite skips model probes until that route is fixed or replaced with a direct Gateway API probe.

### 4.3 Where the smoketest runs

- **After every `openclaw-update promote`**: quick live suite by default, including #09 Telegram roundtrip; add `--with-models` for strict intelligence probes once the model route is green. Use `--no-telegram` only for CI/offline diagnostics.
- **Before any `openclaw-update promote`**: `sandbox-test <version>` boots the staged version on an alternate port with an isolated config directory and channels disabled, then runs the sandbox suite. #09 remains live/current-only because sandbox gateways must not poll or post through the real Telegram channel.
- **Heartbeat sanity check** (1x/day): `openclaw-update smoketest --quick` runs #01, #02, #04, #08, #09, #10. Catches gateway health, Bonjour regression, Telegram reachability, and install drift.

---

## 5. The unified CLI: `openclaw-update`

```
openclaw-update [subcommand] [options]
```

### 5.1 Subcommands

| Subcommand | What it does |
|-----------|--------------|
| `check` | Compare current vs `npm view openclaw version`. Prints diff. Exits 0 if up to date, 1 if not. Read-only. |
| `stage <version>` | `npm install --prefix ~/.openclaw/versions/<version>/ openclaw@<version>`. Validates checksum if available. No symlink change. |
| `sandbox-test <version|latest|current>` | Boot the staged/current version on alt port + isolated sanitized config, run the sandbox smoketest, tear down. Stages the version first if needed. Supports `--config-source <file>` for proposed config edits. |
| `promote <version>` | Stop gateway → backup `openclaw.json` → swap `current` symlink → reload launchd → run live smoketest → on failure, auto-rollback. |
| `rollback` | Swap `current ← previous` symlink → reload launchd → run live smoketest → persist forensics for the version we just left. |
| `status` | Print: current version, previous version, staged versions, last update timestamp, last forensic event. |
| `cleanup` | Delete `versions/<v>/` directories older than the previous + N retained. Never deletes versions tagged `.broken`. |

### 5.2 Interactive default

Planned v2: `openclaw-update` with no args runs the full update flow interactively. MVP currently defaults to `status` and exposes explicit subcommands:

```
[1/6] Checking for updates...           → 2026.5.30 available
[2/6] Stage?                            → y → installing... ok (47s)
[3/6] Sandbox smoke test?               → y → 9/9 passed
[4/6] Promote?                          → y
[4a/6]   Backing up openclaw.json       → openclaw.json.pre-promote-2026-05-30T12-04
[4b/6]   Swapping symlink               → current → 2026.5.30
[4c/6]   Reloading launchd              → kickstart ok
[4d/6]   Live smoke test                → 8/9 passed (#07 models-roundtrip: Anthropic 200 / OpenAI 200 / Gemini 200)
[5/6] Promote successful.
[6/6] Previous version (2026.4.24) retained at ~/.openclaw/versions/2026.4.24/
```

Failure at step 4d auto-rollback fires. Exits non-zero.

### 5.3 Non-CLI update detection (Stephan's failure-mode #4)

A human or background bot could still type `npm install -g openclaw` and bypass everything. Defenses:

1. **Stub at `/opt/homebrew/bin/openclaw`** (see §3.4) — refuses to run and points at `openclaw-update`.
2. **Smoketest #10 `install-drift`** — runs in heartbeat. If `/opt/homebrew/bin/openclaw` no longer matches our stub fingerprint, or if a fresh `versions/<X>/` appeared without a manifest entry, fire an alert through alert-bus.
3. **Versions-manifest checksum** — `versions-manifest.json` records every `stage`, `promote`, `rollback`. Drift between manifest and disk is a signal.
4. **Docs/instructions** — workspace guidance should say: "openclaw updates use `openclaw-update`, never `npm install -g openclaw`."

This isn't a hard lockout (impossible without taking away root from yourself), but it's a tight enough net that the bypass gets caught the next heartbeat.

---

## 6. Forensics on rollback

When `openclaw-update --rollback` (or auto-rollback after a failed promote) fires:

```
~/clawd/clawd-resilience/openclaw-update/forensics/<timestamp>-<version-rolled-back-from>/
  manifest.json              # versions involved, reason, who triggered
  gateway.log.tail            # last 500 lines of gateway.log at time of rollback
  gateway.err.log.tail        # same for err log
  smoketest-result.json       # the failing smoketest output (live or sandbox)
  openclaw.json.at-rollback   # config snapshot
  diff-config.txt             # diff vs previous version's last-good config
  diff-pkg.txt                # npm pkg diff between rolled-back-from and rolled-back-to
  env-dump.txt                # plist env at rollback time
```

The rolled-back-from version directory is **renamed** (not deleted): `versions/<X>/` → `versions/<X>.broken-<timestamp>/`. It stays on disk until manual `openclaw-update cleanup --include-broken`.

A subagent can later read the forensics dir and file a GitHub issue against openclaw with a clean repro. That's a future automation, not part of v1.

---

## 7. Heartbeat integration

Can replace the current `openclaw_version` heartbeat check once migration has been run.

```bash
# 1x/day
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update check --json
```

Output:
- `{ status: "current", current: "X", latest: "X" }` → silent
- `{ status: "stale", current: "X", latest: "Y", days_since_notify: 31 }` → notify Stephan with `Run: openclaw-update`
- Heartbeat should keep using its existing 30-day OpenClaw update notification cooldown (one nag per month, regardless of version count).

Also runs (every heartbeat):

```bash
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update smoketest --quick
```

Quick smoketest (#01, #02, #04, #10). Silent when clean.

---

## 8. Migration plan (current → versioned)

**One-time switchover script:** `~/clawd/clawd-resilience/openclaw-update/migrate-to-versioned.sh`.

Runs as the user (no sudo needed — all paths are user-owned). Safe to re-run (idempotent for partial completion). Atomic for the parts that matter — gateway downtime ≤30s.

### 8.1 Pre-flight

1. Detect current version from `openclaw --version`.
2. Verify Homebrew npm install: `ls -la /opt/homebrew/bin/openclaw` resolves to `/opt/homebrew/lib/node_modules/openclaw/`. Bail if not.
3. Check that `~/.openclaw/` exists and is owned by the user. Bail if not.
4. Confirm with `read -p`: prints what's about to happen, requires "yes" to proceed.

### 8.2 The switchover

```
Step A — Stage current version into new layout
  mkdir -p ~/.openclaw/versions/<current>/
  cp -a /opt/homebrew/lib/node_modules/openclaw/ ~/.openclaw/versions/<current>/lib/node_modules/openclaw/
  ln -s ../lib/node_modules/openclaw/openclaw.mjs ~/.openclaw/versions/<current>/bin/openclaw
  # Cheap copy — ~85MB, takes ~5s. Avoids re-downloading deps.

Step B — Create symlinks
  ln -sfn versions/<current> ~/.openclaw/current
  ln -sfn versions/<current> ~/.openclaw/previous   # initially same as current
  mkdir -p ~/.openclaw/bin
  cat > ~/.openclaw/bin/openclaw <<'EOF'
  #!/bin/sh
  exec /opt/homebrew/bin/node "$HOME/.openclaw/current/lib/node_modules/openclaw/openclaw.mjs" "$@"
  EOF
  chmod +x ~/.openclaw/bin/openclaw

Step C — Write versions-manifest.json
  Records: current version, install date, "migrated" event.

Step D — Update launchd plist
  Backup current plist → ai.openclaw.gateway.plist.pre-migrate-<timestamp>
  Generate new plist pointing at ~/.openclaw/current/...
  launchctl bootout gui/$(id -u)/ai.openclaw.gateway
  cp new plist into place
  launchctl bootstrap gui/$(id -u) ai.openclaw.gateway

Step E — Live smoketest
  Run #01, #02, #04, #06, #10. Hard fail = manual recovery.

Step F — Neuter the brew install (only after smoketest passes)
  npm uninstall -g openclaw   # (uses brew's npm)
  # This deletes /opt/homebrew/lib/node_modules/openclaw/ (we already copied it in Step A)
  cat > /opt/homebrew/bin/openclaw <<'EOF'
  #!/bin/sh
  echo "openclaw is managed by openclaw-update. Run: openclaw-update --help" >&2
  exit 64
  EOF
  chmod +x /opt/homebrew/bin/openclaw

Step G — Add ~/.openclaw/bin to PATH
  Append to ~/.zshrc (or ~/.bashrc): `export PATH="$HOME/.openclaw/bin:$PATH"`
  Note: shell doesn't reload mid-script. New shells will pick it up.

Step H — Confirm
  Print: current install layout, gateway pid, smoketest summary, next steps.
```

### 8.3 If migration fails partway

The pre-existing plist backup is the rescue point. Manual recovery in a sudo shell:

```sh
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
cp ~/Library/LaunchAgents/ai.openclaw.gateway.plist.pre-migrate-<ts> ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

This is documented at the top of the migration script and in `~/clawd/clawd-resilience/openclaw-update/README.md`. The migration script prints the exact commands if it bails.

---

## 9. Build order

1. **Smoketest suite as a standalone tool.** Works against current install today, no architecture change required. Highest immediate value.
2. **`openclaw-rollback` script.** Trivial, depends on versioned install.
3. **`migrate-to-versioned.sh`.** The architecture change. Reversible via plist backup. Run once.
4. **`openclaw-update` CLI** wrapping check/stage/promote/rollback/status/cleanup.
5. **Sandboxed pre-promotion testing.** Reuses smoketest with `--target sandbox`.
6. **Forensics + auto-rollback** on failed live smoketest.

Each step is independently useful and committable.

---

## 10. Open questions / decisions deferred

- **Sandbox state dir:** does the sandbox gateway share `~/.openclaw/` or use a sanitized copy? Leaning **sanitized copy** so the sandbox can't accidentally write into live state (e.g., post real Telegram messages, mutate dedup state).
- **Versions retention:** keep N=3 previous versions by default? User can tune via `openclaw-update cleanup --keep N`.
- **What happens to the daily `update-check.json`?** Remove it when found. It is an ephemeral cache; `openclaw-update check` uses `npm view` and OpenClaw can regenerate its own cache if needed.
- **Plist `OPENCLAW_SERVICE_VERSION`:** dropped from the new plist. If something downstream reads it, we'll find out in the smoketest.
- **Multiple plists:** only `ai.openclaw.gateway.plist` is in scope. `ai.openclaw.claude-oauth-refresh.plist`, `ai.openclaw.regression-detector.plist`, `ai.openclaw.sqlite-snapshot.plist` are separate concerns and not touched.

---

## 11. Non-goals

- Auto-updating without human confirmation. Stephan triggers every promote.
- Live-patching a running gateway (no hot swap; we stop/start with ≤30s downtime).
- Cross-machine update orchestration. This system is one-mac-mini.
- Replacing the OS/hardware resilience work. This is the app-layer update system.

---

## 12. Telemetry to alert-bus

Auto-rollback events post to alert-bus (DM) with envelope:

```json
{
  "source": "openclaw-update",
  "kind": "rollback",
  "entity_id": "<version>",
  "urgency": "soon",
  "message": "openclaw-update auto-rolled-back from <X> to <Y>. Forensics: <path>",
  "auto_post": true
}
```

Smoketest failures in heartbeat post similarly with `urgency: "now"`.

---

## 13. Working-directory snapshots

Versioned binary rollback alone is insufficient. A new openclaw version can mutate state outside its install dir on first boot — most importantly schema migrations to `~/.openclaw/openclaw.json`. If we roll back the binary without restoring config, the old version may not boot against the new-format file. This section defines the snapshot/restore strategy that closes that gap.

### 13.1 Two state surfaces, two mechanisms

| Surface | Mechanism | Why |
|---------|-----------|-----|
| `~/.openclaw/` (config & runtime state) | Explicit per-version snapshot under `versions/<X>/.state-snapshot/` | Not under git. Mutable. We know the file set. |
| `~/clawd/` (skills, ops, workspace, memory) | Git tag + commit-or-stash before each promote | Already under git. User edits daily — auto-revert would destroy work. |

### 13.2 `~/.openclaw/` snapshots

**Whitelist of files captured per snapshot:**

```
openclaw.json                         — primary config; schema can change between versions
.environment                          — env overrides
exec-approvals.json                   — approved exec commands; version-schema field present
state/routing-config-snapshot.json    — launch/routing runtime snapshot used by health checks
agents/main/agent/models.json         — per-agent model catalog overrides
agents/main/agent/auth-state.json     — provider order/lastGood routing state (no token material)
agents/dev/agent/models.json          — dev agent model catalog overrides
```

`update-check.json` is intentionally excluded and should be removed when found — it is an ephemeral "last seen version" cache that openclaw refetches harmlessly if absent.

`agents/*/agent/auth-profiles.json` is intentionally excluded even though it affects routing: it can contain OAuth/access-token material, so duplicating it into version snapshots would unnecessarily spread secrets.

**Excluded (user state, never restored by rollback):**
- `credentials/`, `delivery-queue/`, `cron/`, `devices/`, `sessions/`, `subagents/`, `tasks/`, `telegram/`, `memory/`, `logs/`, `wiki/`, `workspace/`, `flows/`, and `state/` except the explicit `state/routing-config-snapshot.json` whitelist entry.

The whitelist lives at `~/clawd/clawd-resilience/openclaw-update/snapshot-whitelist.txt` so it's easy to amend without re-spec.

**Layout:**

```
~/.openclaw/versions/<version>/
  node_modules/openclaw/        ← npm --prefix layout for newly staged versions
  # or lib/node_modules/openclaw/ for the initial copied legacy version
  bin/openclaw                  ← shim
  .state-snapshot/              ← snapshot taken when leaving this version
    openclaw.json
    .environment
    exec-approvals.json
    state/routing-config-snapshot.json
    agents/main/agent/models.json
    agents/main/agent/auth-state.json
    agents/dev/agent/models.json
    snapshot.json               ← timestamp, manifest, sha256s
```

**Promote flow (in `openclaw-update promote <new>`):**
1. Identify currently-running version `<cur>`.
2. `cp` whitelist files from `~/.openclaw/` → `versions/<cur>/.state-snapshot/`.
3. Compute sha256s, write `snapshot.json`.
4. Then proceed with symlink swap.

**Rollback flow:**
1. Identify rollback target `<prev>` from `~/.openclaw/previous`.
2. Check `versions/<prev>/.state-snapshot/snapshot.json` exists.
3. If yes: restore whitelist files from snapshot → `~/.openclaw/`. Backup the live versions to `versions/<cur>.broken-<TS>/state-at-rollback/` first.
4. If no (e.g., snapshot was never taken — first install, manual upgrade): proceed with symlink-only rollback, warn the user that `openclaw.json` may need manual recovery from `.bak.*` files.
5. Then swap symlink and restart gateway.

### 13.3 `~/clawd/` git integration

Before any promote, the CLI:

1. Runs `git -C ~/clawd status --porcelain`. If dirty:
   - Prompt: "Uncommitted changes in ~/clawd. Commit / stash / abort?"
   - Default to **commit** with a generated message (`pre-openclaw-update-<new-version>`). Stash is the second choice.
2. Creates a tag: `git tag openclaw-update-pre-<TS>-from-<old>-to-<new>` at HEAD.
3. Pushes the tag (best-effort): `git push origin --tags`. Failure here is a warning, not a hard stop — local tag is sufficient for rollback purposes.

On rollback:

1. Find the most recent `openclaw-update-pre-*` tag.
2. Report: `git -C ~/clawd diff <tag>` — files changed since the promote.
3. **Do not auto-revert.** Print: "If any of these changes look related to the broken update, you can revert with `git -C ~/clawd reset --hard <tag>`. The tag is preserved." User can also cherry-pick what to keep.

This is the right trade-off because `~/clawd` accumulates legitimate edits (CLAUDE.md tweaks, new skills, memory writes) that we must not destroy.

### 13.4 Idempotence and safety

- A second promote without a rollback overwrites `versions/<cur>/.state-snapshot/` — that's correct (current state = the snapshot for the current version).
- A rollback then a re-promote-of-same-broken-version is intentionally allowed: the user may have manually fixed the upstream issue.
- The `snapshot.json` includes sha256s so the rollback can detect if the live config has drifted from the snapshotted version (warn, but proceed — user may have made deliberate edits).

### 13.5 Safe window for editing openclaw.json

openclaw has a history of clobbering `openclaw.json` on updates (captured in prior `.clobbered.*` backups). The snapshot mechanism closes this gap, but edits must be timed correctly:

| When | Safe? | Notes |
|------|-------|-------|
| Before promote | ✅ Yes | Your edits are live config; the snapshot captures them at promote time |
| After promote, before next promote | ✅ Yes | Edits accumulate; the next promote's pre-snapshot captures the current state |
| Between a failed promote and rollback | ⚠️ Careful | The snapshot restore will overwrite any edits made post-promote. Make the edits *after* rollback completes, not before. |
| During rollback (restore phase) | ❌ No | Restore overwrites live files; your edits will be lost |

**Rule of thumb:** if the gateway is not in a healthy state (failed promote, mid-rollback), don't edit `openclaw.json` until the situation is resolved and the gateway is confirmed healthy.

### 13.6 What we explicitly don't snapshot

- **`credentials/`** — never. Secrets shouldn't be duplicated. If openclaw-update somehow corrupts credentials, that's an upstream openclaw bug, not something we recover from with our snapshots.
- **`memory/` / `wiki/`** — agent-written content. Restoring would destroy days of memory accumulation.
- **`sessions/`, `tasks/`, `delivery-queue/`** — operational state. Restoring would resurrect old sessions.
- **`logs/`** — out-of-scope for snapshotting; they're forensic data.

If a future openclaw release changes the schema of one of these directories, we deal with it at that release — not by pre-emptive snapshotting.
