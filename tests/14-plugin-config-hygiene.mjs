// Test #11 — Plugin config hygiene.
// Catches update-bricking risks from configured plugins whose manifests are not
// present in either the bundled extension tree or ~/.openclaw/extensions, plus
// stale disabled plugin config that continues to trigger config warnings.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function readConfig(configDir) {
  return JSON.parse(readFileSync(resolve(configDir, 'openclaw.json'), 'utf8'));
}

function manifestNames(dir) {
  const names = new Set();
  if (!existsSync(dir)) return names;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifest = resolve(dir, ent.name, 'openclaw.plugin.json');
    if (existsSync(manifest)) names.add(ent.name);
  }
  return names;
}

export default {
  id: '14',
  name: 'plugin-config-hygiene',
  modes: ['current', 'sandbox'],
  timeout_ms: 5000,
  run(ctx) {
    let cfg;
    try { cfg = readConfig(ctx.configDir); }
    catch (err) { return { ok: false, detail: `config read failed: ${err.message}` }; }

    const entries = cfg.plugins?.entries ?? {};
    const installs = cfg.plugins?.installs ?? {};
    const bundled = manifestNames(resolve(ctx.installDir, 'dist/extensions'));
    const local = manifestNames(resolve(homedir(), '.openclaw/extensions'));

    const missingEnabled = [];
    const staleDisabled = [];
    const missingInstalled = [];
    for (const [name, entry] of Object.entries(entries)) {
      const hasManifest = bundled.has(name) || local.has(name) || Boolean(installs[name]?.installPath && existsSync(resolve(installs[name].installPath, 'openclaw.plugin.json')));
      if (entry?.enabled !== false && !hasManifest) missingEnabled.push(name);
      if (entry?.enabled === false && Object.prototype.hasOwnProperty.call(entry, 'config')) staleDisabled.push(name);
    }
    for (const [name, inst] of Object.entries(installs)) {
      if (inst?.installPath && !existsSync(resolve(inst.installPath, 'openclaw.plugin.json'))) missingInstalled.push(name);
    }

    const problems = [];
    if (missingEnabled.length) problems.push(`enabled plugins missing manifests: ${missingEnabled.join(', ')}`);
    if (staleDisabled.length) problems.push(`disabled plugins still have config blocks: ${staleDisabled.join(', ')}`);
    if (missingInstalled.length) problems.push(`plugin installs missing manifests: ${missingInstalled.join(', ')}`);
    if (problems.length) return { ok: false, detail: problems.join('; ') };

    const notes = [];
    const allow = cfg.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) notes.push('plugins.allow absent/empty (non-fatal; non-bundled plugins may auto-load)');
    notes.push(`${Object.keys(entries).length} configured plugin entries; bundled=${bundled.size}, local=${local.size}`);
    return { ok: true, detail: notes.join('; ') };
  },
};
