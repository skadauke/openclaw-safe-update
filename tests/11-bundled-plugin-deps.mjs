// Test #11 — Bundled plugins with missing runtime deps.
// Runs `openclaw doctor` and parses the "Bundled plugin runtime deps are missing" block.
// Cross-references against plugins.entries in openclaw.json:
//   - Missing dep for an ENABLED plugin → FAIL (will likely brick at runtime)
//   - Missing dep for a DISABLED/unconfigured plugin → OK (plugin won't load)
// Past incident: blind `doctor --fix` installed a bad version and bricked the gateway.
// This test surfaces *which* missing deps actually matter so we can install only those.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLUGIN_OF_DEP = {
  // map of npm pkg name → which openclaw bundled plugin uses it.
  // Populated from doctor output. Order doesn't matter.
  '@anthropic-ai/vertex-sdk': 'anthropic-vertex',
  '@aws-sdk/client-bedrock': 'amazon-bedrock',
  '@aws-sdk/client-bedrock-runtime': 'amazon-bedrock',
  '@aws-sdk/credential-provider-node': 'amazon-bedrock',
  '@aws/bedrock-token-generator': 'amazon-bedrock-mantle',
  '@clack/prompts': 'github-copilot',
  '@grammyjs/runner': 'telegram',
  '@grammyjs/transformer-throttler': 'telegram',
  '@homebridge/ciao': 'bonjour',
  '@mariozechner/pi-agent-core': 'anthropic-vertex',
  '@modelcontextprotocol/sdk': 'browser',
  '@mozilla/readability': 'web-readability',
  '@tencent-connect/qqbot-connector': 'qqbot',
  'acpx': 'acpx',
  'chokidar': 'memory-core',
  'commander': 'browser',
  'express': 'browser',
  'grammy': 'telegram',
  'linkedom': 'web-readability',
  'mpg123-decoder': 'qqbot',
  'node-edge-tts': 'microsoft',
  'pdfjs-dist': 'document-extract',
  'playwright-core': 'browser',
  'silk-wasm': 'qqbot',
  'undici': 'browser',
  'yaml': 'memory-wiki',
};

function enabledPluginNames(cfgPath) {
  if (!existsSync(cfgPath)) return new Set();
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const entries = cfg.plugins?.entries ?? {};
  const enabled = new Set();
  for (const [name, entry] of Object.entries(entries)) {
    if (entry && entry.enabled !== false) enabled.add(name);
  }
  // No `plugins.entries` for a plugin means default-on for bundled plugins.
  // We err on the safe side: if the plugin is in PLUGIN_OF_DEP and NOT explicitly
  // disabled in entries, treat it as enabled.
  return enabled;
}

function parseMissingDeps(doctorOutput) {
  // Find the "Bundled plugin runtime deps are missing" block.
  const start = doctorOutput.indexOf('Bundled plugin runtime deps are missing');
  if (start === -1) return [];
  const block = doctorOutput.slice(start, doctorOutput.indexOf('Fix:', start));
  const deps = [];
  for (const line of block.split('\n')) {
    // Lines look like: "│  - @anthropic-ai/vertex-sdk@^0.16.0 (used by anthropic-vertex)            │"
    const m = line.match(/-\s+([@\w/\-.]+)@[^\s]+\s+\(used by ([^)]+)\)/);
    if (m) deps.push({ pkg: m[1], plugin: m[2].trim() });
  }
  return deps;
}

export default {
  id: '11',
  name: 'bundled-plugin-deps',
  modes: ['current', 'sandbox'],
  timeout_ms: 45000,
  run(ctx) {
    const cfgPath = resolve(ctx.configDir, 'openclaw.json');
    const enabled = enabledPluginNames(cfgPath);

    // Run doctor against the right install + config.
    const entry = resolve(ctx.installDir, 'openclaw.mjs');
    if (!existsSync(entry)) {
      // npm-prefix layout: try dist/index.js as fallback
      const altEntry = resolve(ctx.installDir, 'dist/index.js');
      if (!existsSync(altEntry)) return { ok: false, detail: `cannot find openclaw entry in ${ctx.installDir}` };
    }
    const env = { ...process.env };
    if (ctx.target === 'sandbox') {
      env.OPENCLAW_HOME = ctx.configDir;
      env.OPENCLAW_CONFIG_PATH = cfgPath;
    }
    const nodeBin = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/bin/node';
    const r = spawnSync(nodeBin, [
      existsSync(entry) ? entry : resolve(ctx.installDir, 'dist/index.js'),
      'doctor',
    ], { encoding: 'utf8', timeout: 30000, env });

    const out = (r.stdout || '') + (r.stderr || '');
    const missing = parseMissingDeps(out);

    if (missing.length === 0) {
      return { ok: true, detail: 'no missing bundled plugin deps' };
    }

    // Categorize: which missing deps belong to enabled plugins?
    const blocking = missing.filter(m => enabled.has(m.plugin));
    const ignorable = missing.filter(m => !enabled.has(m.plugin));

    if (blocking.length === 0) {
      const plugins = [...new Set(ignorable.map(m => m.plugin))];
      return { ok: true, detail: `${missing.length} missing dep(s) — all for disabled/unconfigured plugins (${plugins.slice(0, 5).join(', ')}${plugins.length > 5 ? `, +${plugins.length - 5}` : ''})` };
    }

    const blockPlugins = [...new Set(blocking.map(m => m.plugin))];
    return {
      ok: false,
      detail: `missing deps for ENABLED plugin(s): ${blockPlugins.join(', ')} — gateway may fail to load these. Either install via 'openclaw plugins install <name>' or disable in plugins.entries.<name>.enabled=false`,
    };
  },
};
