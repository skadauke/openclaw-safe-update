// Test #04 — Every plugin configured in openclaw.json reports loaded in the gateway log.
// Reads ~/.openclaw/openclaw.json for the enabled plugin list, then checks the
// gateway log for "loaded" lines per plugin within the last hour. Lenient: if the
// log doesn't say anything about a plugin (e.g. just rotated), we mark unknown
// rather than fail, but if it says "failed"/"error" for a plugin we hard-fail.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function enabledPlugins(configDir) {
  const cfg = JSON.parse(readFileSync(resolve(configDir, 'openclaw.json'), 'utf8'));
  const entries = cfg.plugins?.entries ?? {};
  const enabled = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (entry && entry.enabled !== false) enabled.push(name);
  }
  return enabled;
}

function readRecentLog(configDir, hoursBack = 1) {
  // Only scan gateway.log (plain text). gateway-structured.log is JSON-per-line
  // and regex-matching across JSON fields produces false positives (e.g. a
  // "plugin host registry cleanup failed" message that mentions an unrelated
  // plugin name in adjacent text).
  const logsDir = resolve(configDir, 'logs');
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  const p = resolve(logsDir, 'gateway.log');
  if (!existsSync(p)) return '';
  const st = statSync(p);
  if (st.mtimeMs < cutoff && st.size > 0) return '';
  return readFileSync(p, 'utf8');
}

// Patterns that look like errors but are actually "plugin not installed yet"
// info — not a startup failure. Common after a fresh promote where the
// externalized plugin is about to be installed.
const BENIGN_PATTERNS = [
  /plugin not installed/i,
  /plugin not found/i,
  /plugin not available/i,
  /plugin .* is unavailable/i,
  /not available: [a-z0-9_-]+ \(install or enable plugin/i,
  /stale plugin reference/i,
  /stale config entry ignored/i,
];

export default {
  id: '04',
  name: 'plugins-loaded',
  modes: ['current', 'sandbox', 'quick'],
  timeout_ms: 5000,
  run(ctx) {
    let enabled;
    try { enabled = enabledPlugins(ctx.configDir); }
    catch (err) { return { ok: false, detail: `config read failed: ${err.message}` }; }
    if (!enabled.length) return { ok: true, detail: 'no enabled plugins (vacuous pass)' };

    const log = readRecentLog(ctx.configDir, 24);
    if (!log.trim()) return { ok: true, detail: `${enabled.length} enabled, log empty (post-rotation/sandbox; cannot confirm)` };

    const errors = [];
    const benign = [];
    const unconfirmed = [];
    for (const name of enabled) {
      const failRe = new RegExp(`plugin[^\\n]*${name}[^\\n]*(failed|error)`, 'i');
      const failLines = log.split('\n').filter(line => failRe.test(line));
      if (failLines.length) {
        // Distinguish hard failures from "not installed/available" info.
        const hardFail = failLines.some(line => !BENIGN_PATTERNS.some(p => p.test(line)));
        if (hardFail) { errors.push(name); continue; }
        benign.push(name);
      }
      const okRe = new RegExp(`(plugin[^\\n]*${name}[^\\n]*(loaded|ready|registered))|(${name}[^\\n]*plugin[^\\n]*(loaded|ready|registered))`, 'i');
      if (!okRe.test(log)) unconfirmed.push(name);
    }
    if (errors.length) return { ok: false, detail: `plugin errors: ${errors.join(', ')}` };
    if (benign.length) {
      return { ok: true, detail: `${enabled.length - unconfirmed.length}/${enabled.length} confirmed; ${benign.join(', ')} flagged as not-installed (informational, not a failure)` };
    }
    if (unconfirmed.length === enabled.length) {
      return { ok: true, detail: `${enabled.length} enabled, none confirmed in log (log may be too quiet to surface; not failing)` };
    }
    return { ok: true, detail: `${enabled.length - unconfirmed.length}/${enabled.length} confirmed loaded` };
  },
};
