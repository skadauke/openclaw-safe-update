// Test #01 — Confirm the openclaw binary in installDir runs and reports version.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export default {
  id: '01',
  name: 'binary-spawn',
  modes: ['current', 'sandbox', 'quick'],
  timeout_ms: 10000,
  run(ctx) {
    const entry = resolve(ctx.installDir, 'openclaw.mjs');
    const r = spawnSync('/opt/homebrew/bin/node', [entry, '--version'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}` };
    const v = (r.stdout || '').trim();
    const m = v.match(/(\d{4}\.\d+\.\d+)/);
    if (!m) return { ok: false, detail: `unexpected version output: ${v.slice(0, 80)}` };
    return { ok: true, detail: m[1] };
  },
};
