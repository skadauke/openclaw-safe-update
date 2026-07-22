// Test #14 — Plugin config hygiene.
// Catches update-bricking risks from configured plugins that fail to load, plus
// stale disabled plugin config that continues to trigger config warnings.
//
// Source of truth is `openclaw plugins list --json` (the persisted registry), NOT
// ~/.openclaw/plugins/installs.json and NOT openclaw.json's plugins.installs:
//   - openclaw.json's plugins.installs is typically {} even when plugins are
//     installed, so reading it reported every npm plugin as missing a manifest.
//   - ~/.openclaw/plugins/installs.json is a legacy sidecar that stops being
//     rewritten once a state migration is blocked, so it goes stale silently and
//     reports plugins that were already uninstalled.
// Asking the runtime avoids both failure modes.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function readConfig(configDir) {
  return JSON.parse(readFileSync(resolve(configDir, 'openclaw.json'), 'utf8'));
}

function pluginRegistry(ctx) {
  const entry = resolve(ctx.installDir, 'openclaw.mjs');
  // Only override OPENCLAW_HOME for a non-default home. Forcing it to the real
  // ~/.openclaw makes the CLI fall back to a derived index that omits every
  // externally-installed plugin, which reads as a wave of false failures.
  const env = { ...process.env };
  if (resolve(ctx.configDir) !== resolve(homedir(), '.openclaw')) env.OPENCLAW_HOME = ctx.configDir;
  const r = spawnSync(process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/bin/node', [entry, 'plugins', 'list', '--json'], {
    encoding: 'utf8',
    timeout: 45000,
    env,
  });
  const raw = r.stdout || '';
  // The CLI prefixes human-readable doctor banners before the JSON payload.
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i === -1 || j <= i) throw new Error(`no JSON in plugins list output (exit ${r.status})`);
  return JSON.parse(raw.slice(i, j + 1));
}

export default {
  id: '14',
  name: 'plugin-config-hygiene',
  // 'current' only: this audits the live config against the live plugin registry.
  // The sandbox runs on a synthetic OPENCLAW_HOME with no installed external
  // plugins, so every global plugin would read as missing there. Bundled-plugin
  // health in the sandbox is already covered by tests 04 and 11.
  modes: ['current'],
  timeout_ms: 60000,
  run(ctx) {
    let cfg;
    try { cfg = readConfig(ctx.configDir); }
    catch (err) { return { ok: false, detail: `config read failed: ${err.message}` }; }

    let reg;
    try { reg = pluginRegistry(ctx); }
    catch (err) { return { ok: false, detail: `plugin registry unreadable: ${err.message}` }; }

    const plugins = reg.plugins ?? [];
    const byId = new Map(plugins.map(p => [p.id, p]));

    // An enabled plugin that did not reach "loaded" is the update-bricking case.
    const notLoaded = plugins
      .filter(p => p.enabled && p.status !== 'loaded')
      .map(p => `${p.id}(${p.status ?? 'unknown'})`);

    // An enabled plugin whose rootDir vanished is a dangling install.
    const missingRoot = plugins
      .filter(p => p.enabled && p.rootDir && !existsSync(p.rootDir))
      .map(p => p.id);

    // Config references a plugin the runtime does not know about at all.
    const entries = cfg.plugins?.entries ?? {};
    const unknown = Object.entries(entries)
      .filter(([name, e]) => e?.enabled !== false && !byId.has(name))
      .map(([name]) => name);

    // Disabled plugins that still carry config blocks keep emitting warnings.
    const staleDisabled = Object.entries(entries)
      .filter(([, e]) => e?.enabled === false && Object.prototype.hasOwnProperty.call(e, 'config'))
      .map(([name]) => name);

    // info-level diagnostics are routine chatter; only warn/error indicate a fault.
    const diagnostics = (reg.diagnostics ?? [])
      .concat(reg.registry?.diagnostics ?? [])
      .filter(d => d?.level === 'warn' || d?.level === 'error');

    const problems = [];
    if (notLoaded.length) problems.push(`enabled plugins not loaded: ${notLoaded.join(', ')}`);
    if (missingRoot.length) problems.push(`enabled plugins with missing rootDir: ${missingRoot.join(', ')}`);
    if (unknown.length) problems.push(`configured plugins unknown to runtime: ${unknown.join(', ')}`);
    if (staleDisabled.length) problems.push(`disabled plugins still have config blocks: ${staleDisabled.join(', ')}`);
    if (diagnostics.length) problems.push(`registry diagnostics: ${JSON.stringify(diagnostics).slice(0, 200)}`);
    if (problems.length) return { ok: false, detail: problems.join('; ') };

    const loaded = plugins.filter(p => p.status === 'loaded').length;
    const external = plugins.filter(p => p.origin !== 'bundled').length;
    const notes = [`${loaded} loaded (${external} external), ${Object.keys(entries).length} configured entries`];
    const allow = cfg.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) notes.push('plugins.allow absent/empty (non-fatal)');
    return { ok: true, detail: notes.join('; ') };
  },
};
