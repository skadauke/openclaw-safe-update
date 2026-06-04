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

## Environment variable overrides

All scripts respect these env vars for path discovery. Useful on non-standard installs (Linux npm global, nvm, custom prefix):

| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_UPDATE_NODE_MIN` | `22.19.0` | Minimum Node.js version required to run these tools. If you point `OPENCLAW_NODE` at a custom Node.js binary that is older than this, the version guard in `bin/openclaw-update` will exit with a clear error. |
| `OPENCLAW_NODE` | `process.execPath` | Path to the node binary |
| `OPENCLAW_NPM` | sibling of node binary, then `which npm` | Path to the npm binary |
| `OPENCLAW_INSTALL_DIR` | `npm root -g`/openclaw (verified via `openclaw.mjs`) | Path to the openclaw package directory (the dir containing `openclaw.mjs`) |

Example for a git-checkout install where openclaw isn't on npm global:

```bash
OPENCLAW_INSTALL_DIR=~/src/openclaw bin/openclaw-update status
```
