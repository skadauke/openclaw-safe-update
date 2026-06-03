// Test #12 — Session transcript hygiene diagnostic.
// Orphaned trajectory-path files are not an update blocker, but a growing pile
// makes transcript/session tooling brittle. This test surfaces the count without
// failing the update gate unless the sessions directory cannot be inspected.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export default {
  id: '15',
  name: 'session-hygiene',
  modes: ['current'],
  timeout_ms: 10000,
  run(ctx) {
    const dir = resolve(ctx.configDir, 'agents/main/sessions');
    if (!existsSync(dir)) return { ok: true, detail: 'sessions dir absent in this config dir' };
    let files;
    try { files = readdirSync(dir); }
    catch (err) { return { ok: false, detail: `cannot read sessions dir: ${err.message}` }; }
    const jsonl = new Set(files.filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')));
    const trajectories = files.filter(f => f.endsWith('.trajectory-path.json'));
    const orphaned = trajectories.filter(f => !jsonl.has(f.replace(/\.trajectory-path\.json$/, '')));
    const oldCutoff = Date.now() - 7 * 24 * 3600 * 1000;
    let old = 0;
    for (const f of orphaned) {
      try { if (statSync(resolve(dir, f)).mtimeMs < oldCutoff) old++; } catch {}
    }
    return {
      ok: true,
      detail: `${files.length} session files; ${jsonl.size} transcripts; ${trajectories.length} trajectory pointers; ${orphaned.length} orphaned (${old} older than 7d)`,
    };
  },
};
