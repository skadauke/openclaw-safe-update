#!/usr/bin/env node
// Hermetic smoketest runner using the mock openclaw binary and fixture config.
//
// Sets up the environment to use tests/fixtures/ as the install dir and
// tests/fixtures/mock-openclaw-dir/ as OPENCLAW_HOME, then runs the full
// smoketest suite against target:'current', skipping tests that require a
// live model API or Telegram bot (#06, #07, #09).
//
// Usage: node tests/run-with-mock.mjs [--verbose]
//
// Test modifications made to pass in this mock environment:
//   #01, #03, #05, #11 — node binary: OPENCLAW_NODE_BIN env var instead of
//     hardcoded /opt/homebrew/bin/node (Homebrew path absent on Linux CI).
//   #10 — install-drift: paths derived from ctx.configDir instead of homedir()
//     so the fixture 'current' symlink and 'bin/openclaw' stub are found without
//     requiring ~/.openclaw to exist.
//   #08 — bonjour-no-crash: passes as-is; the fixture openclaw.json sets
//     discovery.mdns.mode='off' which satisfies the config guard.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set env vars before smoketest.mjs is evaluated and test modules are imported.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, 'fixtures');
const MOCK_CONFIG_DIR = resolve(FIXTURES_DIR, 'mock-openclaw-dir');
const MOCK_PORT = 18799;

process.env.OPENCLAW_INSTALL_DIR = FIXTURES_DIR;
process.env.OPENCLAW_HOME = MOCK_CONFIG_DIR;
// Allow test files to use process.execPath in place of /opt/homebrew/bin/node
process.env.OPENCLAW_NODE_BIN = process.execPath;

// Dynamic import runs after top-level env setup above.
const { runSmoketest, formatTextReport } = await import('../lib/smoketest.mjs');

const verbose = process.argv.includes('--verbose');

// Start the mock gateway so test #02 (gateway-health) can poll /healthz.
const gateway = spawn(process.execPath, [
  resolve(FIXTURES_DIR, 'openclaw.mjs'),
  'gateway', 'run', '--port', String(MOCK_PORT),
], {
  stdio: ['ignore', 'ignore', verbose ? 'inherit' : 'ignore'],
  detached: false,
});

gateway.on('error', err => {
  process.stderr.write(`mock gateway spawn error: ${err.message}\n`);
  process.exit(2);
});

// Brief pause — the HTTP server binds very quickly; test #02 also polls up to 30s.
await new Promise(r => setTimeout(r, 300));

let report;
try {
  report = await runSmoketest({
    target: 'current',
    port: MOCK_PORT,
    configDir: MOCK_CONFIG_DIR,
    installDir: FIXTURES_DIR,
    telegram: false,   // skip #09 (requiresTelegram)
    models: false,     // skip #06, #07 (requiresModels)
    mode: 'full',
    skip: [],          // telegram/models flags already gate the relevant tests
    verbose,
  });
} finally {
  gateway.kill('SIGTERM');
}

console.log(formatTextReport(report));

if (report.failed > 0) {
  process.exit(1);
}
