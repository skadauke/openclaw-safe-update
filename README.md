# openclaw-update

Safe OpenClaw update system: versioned installs, quick rollback, smoketests, and drift detection.

Read `SPEC.md` first. Current state: MVP built; migration script exists and has been run on this host.

## Installation / Getting started

```bash
git clone <repo-url> openclaw-update
cd openclaw-update
```

Scripts live in `bin/`. Run them directly from the repo root (no global install needed):

```bash
bin/openclaw-update status
```

Prerequisites: Node.js (see `package.json` for the required version).

## Useful commands

```bash
bin/openclaw-update status
bin/openclaw-update check
bin/openclaw-update smoketest --quick
bin/openclaw-update sandbox-test latest --bonjour-watch-sec 30
bin/openclaw-update sandbox-test current --config-source /path/to/proposed-openclaw.json
```

One-time switchover, only on hosts that have not migrated yet:

```bash
./migrate-to-versioned.sh
```

Rollback after migration:

```bash
bin/openclaw-rollback
```

Do not use `npm install -g openclaw` after migration; use `openclaw-update stage` + `openclaw-update promote`.
