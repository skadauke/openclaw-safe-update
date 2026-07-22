// Test #13 — Session-store integrity.
//
// This replaces an earlier version that computed orphans as
//   total_jsonl_files - (sessions.length * 2)
// sessions.json is a MAP keyed by session key, so `idx.sessions ?? []` yielded [],
// `referenced` was always 0, and every transcript on disk counted as an orphan.
// It therefore fired purely on "you have >1000 transcripts" — and its suggested
// remedy (`sessions cleanup --fix-missing`) prunes the opposite direction, so
// running it would not have cleared the failure.
//
// Three distinct things matter here, and only two are faults:
//   1. Ledger drift — an ACTIVE session whose transcript file is gone. Real; the
//      store points at nothing. Fixed by `sessions cleanup --enforce --fix-missing`.
//   2. Orphan footprint — transcripts on disk no longer referenced. Normal history
//      accumulation; only a problem when it grows large enough to matter on disk.
//   3. Missing HISTORICAL ids (usageFamilySessionIds) — expected. Retention deletes
//      those transcripts by design, so they are counted but never failed on.
//
// Sandbox mode: the sandbox config dir has no sessions/ subtree, so this is a no-op pass.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

const DRIFT_WARN = 1;
const DRIFT_FAIL = 25;
const BYTES_WARN = 250 * 1024 * 1024;
const BYTES_FAIL = 1024 * 1024 * 1024;

function mb(n) { return `${(n / 1048576).toFixed(1)}MB`; }

export default {
  id: '13',
  name: 'session-store-integrity',
  modes: ['current', 'quick'],
  timeout_ms: 10000,
  run(ctx) {
    const sessionsDir = resolve(ctx.configDir, 'agents/main/sessions');
    if (!existsSync(sessionsDir)) return { ok: true, detail: 'no sessions dir (vacuous pass)' };
    const indexPath = resolve(sessionsDir, 'sessions.json');
    if (!existsSync(indexPath)) return { ok: true, detail: 'no sessions.json (vacuous pass)' };

    let idx;
    try { idx = JSON.parse(readFileSync(indexPath, 'utf8')); }
    catch (err) { return { ok: false, detail: `sessions.json unparseable: ${err.message}` }; }

    // Accept every shape: array, {sessions:[...]}, or the map-keyed-by-session-key
    // form that the original test silently mis-read.
    const entries = Array.isArray(idx) ? idx : (idx.sessions ?? Object.values(idx));

    const activeIds = new Set();
    const historicalIds = new Set();
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      if (typeof e.sessionId === 'string') activeIds.add(e.sessionId);
      if (Array.isArray(e.usageFamilySessionIds)) {
        for (const v of e.usageFamilySessionIds) if (typeof v === 'string') historicalIds.add(v);
      }
    }

    let files;
    try { files = readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl')); }
    catch (err) { return { ok: false, detail: `cannot read sessions dir: ${err.message}` }; }

    const present = new Set();
    for (const f of files) {
      const m = f.match(UUID_PREFIX);
      if (m) present.add(m[1]);
    }

    let orphans = 0;
    let orphanBytes = 0;
    for (const f of files) {
      const m = f.match(UUID_PREFIX);
      const base = m ? m[1] : null;
      if (base && (activeIds.has(base) || historicalIds.has(base))) continue;
      orphans++;
      try { orphanBytes += statSync(resolve(sessionsDir, f)).size; } catch { /* raced */ }
    }

    let drift = 0;
    for (const id of activeIds) if (!present.has(id)) drift++;

    const stats = `${activeIds.size} active sessions, ${orphans} orphan transcripts (${mb(orphanBytes)}), ${drift} ledger drift`;

    if (drift > DRIFT_FAIL) {
      return { ok: false, detail: `${drift} active sessions reference missing transcripts (>${DRIFT_FAIL}). Run: openclaw sessions cleanup --enforce --fix-missing — ${stats}` };
    }
    if (orphanBytes > BYTES_FAIL) {
      return { ok: false, detail: `orphan transcripts occupy ${mb(orphanBytes)} (>${mb(BYTES_FAIL)}) — ${stats}` };
    }
    const hints = [];
    if (drift >= DRIFT_WARN) hints.push(`${drift} stale store entr${drift === 1 ? 'y' : 'ies'} (openclaw sessions cleanup --dry-run --fix-missing)`);
    if (orphanBytes > BYTES_WARN) hints.push(`orphan transcripts at ${mb(orphanBytes)}`);
    return { ok: true, detail: hints.length ? `${stats}; consider: ${hints.join('; ')}` : stats };
  },
};
