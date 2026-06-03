// Test #12 — plugins.allow audit (informational).
// plugins.allow is EXCLUSIVE: setting it with an incomplete list silently disables
// auto-loading bundled plugins (device-pair, phone-control, talk-voice, …) and breaks
// features. So we do NOT fail when allow is unset — the audit risk (stray extension
// dir auto-loading) is low because extensions only appear when explicitly installed.
//
// PASS-with-info if: no extensions, OR allow unset (informational), OR all extensions allowlisted.
// PASS-with-warning if: allow is set but misses some extensions (those won't load).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

function extensionNames(extDir) {
  if (!existsSync(extDir)) return [];
  return readdirSync(extDir)
    .filter(name => {
      try { return statSync(resolve(extDir, name)).isDirectory(); }
      catch { return false; }
    })
    // Skip dotfiles + tmp dirs
    .filter(name => !name.startsWith('.'));
}

export default {
  id: '12',
  name: 'extensions-allowlist',
  modes: ['current', 'sandbox', 'quick'],
  timeout_ms: 5000,
  run(ctx) {
    const cfgPath = resolve(ctx.configDir, 'openclaw.json');
    if (!existsSync(cfgPath)) return { ok: true, detail: 'no openclaw.json (vacuous pass)' };

    // Sandbox config dirs are isolated and do not contain the real extension tree;
    // still audit against the real ~/.openclaw/extensions because those are what
    // the live gateway will discover after promotion.
    const extDir = ctx.target === 'sandbox' ? resolve(homedir(), '.openclaw/extensions') : resolve(ctx.configDir, 'extensions');
    const exts = extensionNames(extDir);
    if (exts.length === 0) return { ok: true, detail: 'no extensions installed' };

    let cfg;
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
    catch (err) { return { ok: false, detail: `openclaw.json parse failed: ${err.message}` }; }

    const allow = cfg.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      return {
        ok: true,
        detail: `${exts.length} extension(s) present (${exts.join(', ')}); plugins.allow unset (informational — low risk; setting it requires enumerating all auto-loading bundled plugins too)`,
      };
    }

    const missing = exts.filter(e => !allow.includes(e));
    if (missing.length === 0) {
      return { ok: true, detail: `${exts.length} extension(s) in plugins.allow` };
    }
    return {
      ok: true,
      detail: `${exts.length - missing.length}/${exts.length} extensions in plugins.allow; not allowlisted: ${missing.join(', ')} (won't load — verify intentional)`,
    };
  },
};
