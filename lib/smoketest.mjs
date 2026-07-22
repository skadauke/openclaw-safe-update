// Smoketest orchestrator. Loads ./tests/*.mjs, runs them serially, reports.
//
// Test contract: each test module exports
//   { id, name, modes: ['current'|'sandbox'|'quick'][], run(ctx): Promise<{ok, detail?, duration_ms?}> }
// ctx fields: { target: 'current'|'sandbox', port: number, configDir: string,
//                installDir: string, telegram: boolean, models: boolean, log(msg) }

import { readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTelegramCreds } from './telegram-creds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = resolve(HERE, '..', 'tests');

export async function loadTests() {
  const files = readdirSync(TESTS_DIR)
    .filter(f => /^\d{2}-[\w-]+\.mjs$/.test(f))
    .sort();
  const tests = [];
  for (const f of files) {
    const mod = await import(resolve(TESTS_DIR, f));
    if (!mod.default) throw new Error(`test ${f} has no default export`);
    tests.push(mod.default);
  }
  return tests;
}

export async function runSmoketest(opts = {}) {
  const {
    target = 'current',
    port = 18789,
    configDir = process.env.HOME + '/.openclaw',
    installDir = '/opt/homebrew/lib/node_modules/openclaw', // pre-migration default
    telegram = true,   // Telegram roundtrip is core; pass telegram:false to opt out
    models = false,
    mode = 'full', // 'full' | 'quick'
    skip = [],
    verbose = false,
    bonjourWatchSec = 120, // sandbox mode: seconds to watch for Bonjour crash
    onResult = null,   // called with each result as it lands, so long runs aren't silent
    abortIf = null,    // () => reason|null; checked before each test to bail out early
  } = opts;

  const all = await loadTests();
  const telegramCreds = resolveTelegramCreds(configDir);
  const telegramCredsPresent = Boolean(telegramCreds.token && telegramCreds.chatId);
  const selected = all.filter(t => {
    if (skip.includes(t.id) || skip.includes(t.name)) return false;
    if (mode === 'quick' && !t.modes.includes('quick')) return false;
    if (!t.modes.includes(target)) return false;
    if (t.requiresTelegram && (!telegram || !telegramCredsPresent)) return false;
    if (t.requiresModels && !models) return false;
    return true;
  });

  const ctx = {
    target, port, configDir, installDir, telegram, models, bonjourWatchSec,
    telegramToken: telegramCreds.token,
    telegramChatId: telegramCreds.chatId,
    log: (msg) => { if (verbose) process.stderr.write(`  · ${msg}\n`); },
  };

  const results = [];
  let aborted = null;
  for (const t of selected) {
    // Bail out rather than grinding through every remaining timeout when the thing
    // under test is already dead (e.g. the sandbox gateway exited at startup).
    const reason = abortIf ? abortIf() : null;
    if (reason) { aborted = reason; break; }

    const t0 = Date.now();
    let r;
    let timer;
    try {
      r = await Promise.race([
        Promise.resolve(t.run(ctx)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), t.timeout_ms ?? 30000); }),
      ]);
    } catch (err) {
      r = { ok: false, detail: `error: ${err.message}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const dt = Date.now() - t0;
    const entry = { id: t.id, name: t.name, ok: !!r.ok, detail: r.detail ?? '', duration_ms: r.duration_ms ?? dt };
    results.push(entry);
    if (onResult) onResult(entry);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const notRun = all.length - selected.length + (aborted ? selected.length - results.length : 0);
  return { target, mode, passed, failed, results, skipped: notRun, aborted };
}

export function formatTextReport(report) {
  const lines = [];
  lines.push(`OpenClaw smoketest — target=${report.target} mode=${report.mode}`);
  for (const r of report.results) {
    const status = r.ok ? '✓' : '✗';
    lines.push(`  ${status} ${r.id}-${r.name} (${r.duration_ms}ms)${r.detail ? `  — ${r.detail}` : ''}`);
  }
  lines.push(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  return lines.join('\n');
}
