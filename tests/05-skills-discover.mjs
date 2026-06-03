// Test #05 — Skills discovery works and finds the expected baseline skills.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const EXPECTED = ['calendar', 'gog', 'github', 'book-and-reserve', 'online-shop'];

export default {
  id: '05',
  name: 'skills-discover',
  modes: ['current', 'sandbox'],
  timeout_ms: 20000,
  run(ctx) {
    const cli = resolve(ctx.installDir, 'openclaw.mjs');
    const r = spawnSync('/opt/homebrew/bin/node', [cli, 'skills', 'list', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_HOME: ctx.configDir, OPENCLAW_CONFIG_PATH: resolve(ctx.configDir, 'openclaw.json'), OPENCLAW_GATEWAY_PORT: String(ctx.port) },
      timeout: 15000 });
    if (r.status !== 0) return { ok: false, detail: `skills list failed: ${(r.stderr || r.stdout).slice(0, 200)}` };
    let payload;
    try { payload = JSON.parse(r.stdout || '{}'); }
    catch (err) { return { ok: false, detail: `skills list did not emit JSON: ${err.message}` }; }
    const skills = Array.isArray(payload.skills) ? payload.skills : [];
    const names = new Set(skills.map(s => s.name));
    if (ctx.target === 'sandbox') {
      if (skills.length < 5) return { ok: false, detail: `too few bundled skills discovered in sandbox: ${skills.length}` };
      return { ok: true, detail: `${skills.length} bundled/sandbox-visible skills discovered` };
    }
    const missing = EXPECTED.filter(n => !names.has(n));
    if (skills.length < 10) return { ok: false, detail: `too few skills discovered: ${skills.length}` };
    if (missing.length) return { ok: false, detail: `missing expected skills: ${missing.join(', ')}` };
    return { ok: true, detail: `${skills.length} skills discovered` };
  },
};
