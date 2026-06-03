// Test #07 — Send a tiny prompt to each configured text model via the gateway.
// Catches credential revocation, billing failures, upstream outages, and gateway
// intelligence routing failures. Runs only in 'current' mode because it uses live
// credentials and intentionally spends a tiny number of model tokens.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function getConfiguredModels(configDir) {
  const cfg = JSON.parse(readFileSync(resolve(configDir, 'openclaw.json'), 'utf8'));
  const found = new Set();
  const add = (m) => { if (typeof m === 'string' && m.includes('/')) found.add(m); };

  add(cfg.agents?.defaults?.model?.primary);
  for (const m of cfg.agents?.defaults?.model?.fallbacks || []) add(m);
  for (const m of Object.keys(cfg.agents?.defaults?.models || {})) add(m);
  add(cfg.agents?.defaults?.heartbeat?.model);
  for (const agent of cfg.agents?.list || []) add(agent.model);

  // Exclude image-only models from the text roundtrip.
  add(cfg.agents?.defaults?.imageGenerationModel?.primary);
  return [...found].filter(m => !/image|gemini-3-pro-image/i.test(m));
}

function probeModel(model) {
  const r = spawnSync('openclaw', [
    'infer', 'model', 'run',
    '--gateway',
    '--model', model,
    '--prompt', 'Smoketest. Reply with exactly: ok',
    '--json',
  ], { encoding: 'utf8', timeout: 90000 });
  if (r.status !== 0) return { ok: false, detail: `exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 200)}` };
  const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
  if (!text.includes('ok')) return { ok: false, detail: `no ok in response: ${r.stdout.slice(0, 160)}` };
  return { ok: true };
}

export default {
  id: '07',
  name: 'models-roundtrip',
  modes: ['current'], // never in sandbox — no live credentials
  requiresModels: true,
  timeout_ms: 120000, // up to 2 min for slow providers
  async run(ctx) {
    let configured;
    try { configured = getConfiguredModels(ctx.configDir); }
    catch (err) { return { ok: false, detail: `config read failed: ${err.message}` }; }

    if (!configured.length) return { ok: true, detail: 'no models found in config (vacuous pass)' };

    const results = [];
    for (const model of configured) {
      ctx.log(`probing ${model}`);
      try { results.push({ model, ...probeModel(model) }); }
      catch (err) { results.push({ model, ok: false, detail: err.message }); }
    }
    const failed = results.filter(r => !r.ok);
    const detail = results.map(r => `${r.model}:${r.ok ? 'ok' : 'FAIL(' + (r.detail ?? '') + ')'}`).join(' / ');
    return { ok: failed.length === 0, detail };
  },
};
