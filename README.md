# openclaw-update

Safe OpenClaw update system: versioned installs, quick rollback, smoketests, and drift detection.

Read `SPEC.md` first. Current state: MVP built; migration script exists and has been run on this host.

Useful commands:

```bash
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update status
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update check
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update smoketest --quick
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update sandbox-test latest --bonjour-watch-sec 30
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-update sandbox-test current --config-source /path/to/proposed-openclaw.json
```

One-time switchover, only on hosts that have not migrated yet:

```bash
~/clawd/clawd-resilience/openclaw-update/migrate-to-versioned.sh
```

Rollback after migration:

```bash
~/clawd/clawd-resilience/openclaw-update/bin/openclaw-rollback
```

Do not use `npm install -g openclaw` after migration; use `openclaw-update stage` + `openclaw-update promote`.
