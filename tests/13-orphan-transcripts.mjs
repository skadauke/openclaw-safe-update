// Test #13 — Orphan transcript file count exceeds threshold.
// `openclaw doctor` flags this as a state-integrity issue once it spikes.
// Threshold-based to avoid noise on healthy installs:
//   ≤100 → PASS quietly
//   100-1000 → PASS with a hint to run cleanup
//   >1000 → FAIL (suggests cleanup hasn't run in a long time; disk + ledger drift)
//
// Sandbox mode: the sandbox config dir has no sessions/ subtree, so this is a no-op pass.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WARN_AT = 100;
const FAIL_AT = 1000;

export default {
  id: '13',
  name: 'orphan-transcripts',
  modes: ['current', 'quick'],
  timeout_ms: 5000,
  run(ctx) {
    const sessionsDir = resolve(ctx.configDir, 'agents/main/sessions');
    if (!existsSync(sessionsDir)) return { ok: true, detail: 'no sessions dir (vacuous pass)' };
    const indexPath = resolve(sessionsDir, 'sessions.json');
    if (!existsSync(indexPath)) return { ok: true, detail: 'no sessions.json (vacuous pass)' };

    // Count .jsonl + .trajectory.jsonl files in the dir vs sessions.json referenced ids.
    // We don't parse sessions.json (avoids a full read on a hot dir); we just count files.
    let total = 0;
    try {
      for (const name of readdirSync(sessionsDir)) {
        if (name.endsWith('.jsonl') && !name.startsWith('sessions.')) total++;
      }
    } catch (err) {
      return { ok: false, detail: `cannot read sessions dir: ${err.message}` };
    }

    // Pull referenced ids from sessions.json (cheap; file is small).
    let referenced = 0;
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
      const sessions = Array.isArray(idx) ? idx : (idx.sessions ?? []);
      // Each session typically has a transcript file id; count entries as a rough proxy
      referenced = sessions.length * 2; // .jsonl + .trajectory.jsonl per session
    } catch {
      // If sessions.json is unparseable, fall back to file count only
    }

    const orphans = Math.max(0, total - referenced);
    if (orphans > FAIL_AT) {
      return { ok: false, detail: `${orphans} orphan transcript files (>${FAIL_AT}). Run: openclaw sessions cleanup --enforce --fix-missing` };
    }
    if (orphans > WARN_AT) {
      return { ok: true, detail: `${orphans} orphan transcript files (>${WARN_AT}). Consider: openclaw sessions cleanup --dry-run` };
    }
    return { ok: true, detail: `${orphans} orphan transcripts (under threshold)` };
  },
};
