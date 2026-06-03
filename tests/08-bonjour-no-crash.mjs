// Test #08 — Detect that Bonjour is disabled (via env var OR config) AND
// no Bonjour crash signature is present.
//
// Two guard layers:
//   - env: OPENCLAW_DISABLE_BONJOUR=1 in the launchd plist
//   - config: discovery.mdns.mode = "off" in openclaw.json
// At least one must be present. Both is better (belt and suspenders).
//
// Modes:
//   current: post-facto check on the live install's err.log (fast, sync).
//   sandbox: actively watch the sandbox gateway's err.log for ctx.bonjourWatchSec
//            seconds (default 120). Catches the crash even when it takes 30–90s
//            to manifest. Async, non-blocking — the orchestrator awaits the Promise.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CRASH_SIGNATURE = 'CIAO ANNOUNCEMENT CANCELLED';

function readPlist() {
  const p = resolve(homedir(), 'Library/LaunchAgents/ai.openclaw.gateway.plist');
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function readErrLog(configDir) {
  const p = resolve(configDir, 'logs/gateway.err.log');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf8');
}

function envGuardOK(plist) {
  if (!plist) return false;
  if (!plist.includes('OPENCLAW_DISABLE_BONJOUR')) return false;
  return /<string>1<\/string>/.test(plist.slice(plist.indexOf('OPENCLAW_DISABLE_BONJOUR')));
}

function configGuardOK(configDir) {
  const p = resolve(configDir, 'openclaw.json');
  if (!existsSync(p)) return false;
  try {
    const c = JSON.parse(readFileSync(p, 'utf8'));
    return c?.discovery?.mdns?.mode === 'off';
  } catch {
    return false;
  }
}

async function watchForCrash(configDir, totalSec, log) {
  const deadline = Date.now() + totalSec * 1000;
  const startSize = existsSync(resolve(configDir, 'logs/gateway.err.log'))
    ? readFileSync(resolve(configDir, 'logs/gateway.err.log'), 'utf8').length
    : 0;
  while (Date.now() < deadline) {
    const txt = readErrLog(configDir);
    // Look only at content written after we started watching
    const tail = txt.slice(Math.max(0, startSize));
    if (tail.includes(CRASH_SIGNATURE)) return { crashed: true, secs: Math.round((Date.now() - (deadline - totalSec * 1000)) / 1000) };
    await new Promise(r => setTimeout(r, 2000));
    log(`watching err.log (${Math.round((deadline - Date.now()) / 1000)}s remaining)`);
  }
  return { crashed: false };
}

export default {
  id: '08',
  name: 'bonjour-no-crash',
  modes: ['current', 'quick', 'sandbox'],
  // Sized for sandbox watch (default 120s + slack). Post-facto modes finish in ms.
  timeout_ms: 200000,
  async run(ctx) {
    const issues = [];
    const envOK = envGuardOK(readPlist());
    const cfgOK = configGuardOK(ctx.configDir);
    if (!envOK && !cfgOK && ctx.target === 'current') {
      issues.push('neither OPENCLAW_DISABLE_BONJOUR=1 (plist) nor discovery.mdns.mode=off (openclaw.json) is set — Bonjour crash loop may occur');
    }

    if (ctx.target === 'sandbox') {
      const watchSec = ctx.bonjourWatchSec ?? 120;
      const r = await watchForCrash(ctx.configDir, watchSec, ctx.log);
      if (r.crashed) return { ok: false, detail: `Bonjour crash detected during ${watchSec}s watch (at +${r.secs}s)` };
      return { ok: true, detail: `no crash during ${watchSec}s sandbox watch` };
    }

    // current / quick: post-facto err.log scan
    const log = readErrLog(ctx.configDir);
    if (log.includes(CRASH_SIGNATURE)) {
      issues.push('CIAO ANNOUNCEMENT CANCELLED found in gateway.err.log — Bonjour crash detected');
    }
    if (issues.length) return { ok: false, detail: issues.join('; ') };
    const guards = [envOK && 'env', cfgOK && 'config'].filter(Boolean).join('+');
    return { ok: true, detail: `bonjour guard: ${guards || 'none'}; no crash in log` };
  },
};
