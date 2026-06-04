#!/usr/bin/env node
// Hermetic test suite for safe-state.
//
// Strategy: build a fake $HOME with a synthetic ~/.openclaw and clawd tree,
// override HOME via env, run the safe-state binary against it, assert behavior.
// Never touches the real ~/.openclaw.
//
// Usage: node tests/safe-state.test.mjs [--verbose]

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, cpSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_RESILIENCE = resolve(HERE, '..');
const REAL_SAFE_STATE = resolve(REAL_RESILIENCE, 'bin/safe-state');
const REAL_EXCLUDES = resolve(REAL_RESILIENCE, 'state-repo.gitignore');
const FIXTURE_OPENCLAW_DIR = resolve(HERE, 'fixtures/mock-openclaw-dir');

const verbose = process.argv.includes('--verbose');
const results = [];
let currentTest = '';

function log(...args) { if (verbose) console.log('   ', ...args); }

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'safe-state-test-'));
  const home = resolve(root, 'home');
  const openclawDir = resolve(home, '.openclaw');
  const clawdResilience = resolve(home, 'clawd/clawd-resilience/openclaw-update');
  // Seed from shared fixture dir so individual tests don't need to recreate
  // the base openclaw directory structure from scratch.
  cpSync(FIXTURE_OPENCLAW_DIR, openclawDir, { recursive: true });
  mkdirSync(resolve(clawdResilience, 'bin'), { recursive: true });
  // Copy the real binary + excludes into the fake tree so paths resolve there
  cpSync(REAL_SAFE_STATE, resolve(clawdResilience, 'bin/safe-state'));
  cpSync(REAL_EXCLUDES, resolve(clawdResilience, 'state-repo.gitignore'));
  // chmod +x
  spawnSync('chmod', ['+x', resolve(clawdResilience, 'bin/safe-state')]);
  return { root, home, openclawDir, bin: resolve(clawdResilience, 'bin/safe-state'), gitDir: resolve(clawdResilience, 'state-repo.git') };
}

function run(env, args, opts = {}) {
  const r = spawnSync('node', [env.bin, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: env.home },
    cwd: env.home,
  });
  if (verbose) {
    log(`$ safe-state ${args.join(' ')}`);
    if (r.stdout) log('STDOUT:', r.stdout.trim().split('\n').map(l => '  ' + l).join('\n'));
    if (r.stderr) log('STDERR:', r.stderr.trim().split('\n').map(l => '  ' + l).join('\n'));
    log(`(exit ${r.status})`);
  }
  return r;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertContains(haystack, needle, msg) {
  if (!haystack || !haystack.includes(needle)) {
    throw new Error(`${msg}: expected output to contain "${needle}", got:\n${haystack}`);
  }
}

function test(name, fn) {
  currentTest = name;
  const t0 = Date.now();
  try {
    fn();
    const dt = Date.now() - t0;
    results.push({ name, ok: true, dt });
    console.log(`✓ ${name} (${dt}ms)`);
  } catch (err) {
    const dt = Date.now() - t0;
    results.push({ name, ok: false, dt, error: err.message });
    console.log(`✗ ${name} (${dt}ms)`);
    console.log(`   ${err.message}`);
  }
}

// ─── tests ──────────────────────────────────────────────────────────────────

test('init creates bare repo and baseline commit', () => {
  const env = setup();
  // Seed a small file
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"version":1}\n');
  const r = run(env, ['init']);
  assertEq(r.status, 0, 'init exit');
  assert(existsSync(env.gitDir), 'git dir should exist');
  assert(existsSync(resolve(env.gitDir, 'HEAD')), 'bare repo should have HEAD');
  assertContains(r.stdout, 'baseline:', 'should report baseline sha');
  rmSync(env.root, { recursive: true, force: true });
});

test('init is idempotent', () => {
  const env = setup();
  run(env, ['init']);
  const r = run(env, ['init']);
  assertEq(r.status, 0, 'second init should succeed');
  assertContains(r.stdout, 'already initialized', 'should detect existing repo');
  rmSync(env.root, { recursive: true, force: true });
});

test('status reports clean after init', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  const r = run(env, ['status']);
  assertEq(r.status, 0, 'status exit');
  assertContains(r.stdout, 'clean', 'should report clean');
  rmSync(env.root, { recursive: true, force: true });
});

test('status detects edits', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":2}\n');
  const r = run(env, ['status']);
  assertEq(r.status, 0, 'status exit');
  assertContains(r.stdout, 'openclaw.json', 'should mention modified file');
  rmSync(env.root, { recursive: true, force: true });
});

test('snapshot returns a sha and commits the change', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":2}\n');
  const r = run(env, ['snapshot', 'edit-test']);
  assertEq(r.status, 0, 'snapshot exit');
  assertContains(r.stdout, 'snapshot:', 'should announce snapshot');
  assertContains(r.stdout, 'pre-edit-test-', 'should include note in message');
  // After snapshot, status should be clean again
  const st = run(env, ['status']);
  assertContains(st.stdout, 'clean', 'should be clean after snapshot');
  rmSync(env.root, { recursive: true, force: true });
});

test('snapshot allows empty commits (no churn)', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  const r = run(env, ['snapshot', 'no-change']);
  assertEq(r.status, 0, 'snapshot exit even with no changes');
  assertContains(r.stdout, 'snapshot:', 'should still emit a snapshot line');
  rmSync(env.root, { recursive: true, force: true });
});

test('restore rolls back to a prior sha', () => {
  const env = setup();
  const cfg = resolve(env.openclawDir, 'openclaw.json');
  writeFileSync(cfg, '{"v":1}\n');
  run(env, ['init']);
  // baseline sha
  const baseSha = run(env, ['log', '-n', '1']).stdout.trim().split(' ')[0];
  assert(baseSha.length >= 7, 'should have baseline sha');
  // make a change + snapshot
  writeFileSync(cfg, '{"v":2}\n');
  run(env, ['snapshot', 'v2']);
  assertEq(readFileSync(cfg, 'utf8'), '{"v":2}\n', 'should be at v2');
  // restore to baseline
  const r = run(env, ['restore', baseSha]);
  assertEq(r.status, 0, 'restore exit');
  assertContains(r.stdout, 'restored', 'should report restored');
  assertEq(readFileSync(cfg, 'utf8'), '{"v":1}\n', 'should be back to v1');
  rmSync(env.root, { recursive: true, force: true });
});

test('restore preserves untracked files', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  const baseSha = run(env, ['log', '-n', '1']).stdout.trim().split(' ')[0];
  // Add an untracked file AFTER baseline (would not be in baseline)
  const untracked = resolve(env.openclawDir, 'side-note.txt');
  writeFileSync(untracked, 'do not touch\n');
  run(env, ['restore', baseSha]);
  assert(existsSync(untracked), 'untracked file should survive restore');
  assertEq(readFileSync(untracked, 'utf8'), 'do not touch\n', 'untracked content unchanged');
  rmSync(env.root, { recursive: true, force: true });
});

test('gitignore excludes big/transient dirs', () => {
  const env = setup();
  // Create entries that SHOULD be excluded
  mkdirSync(resolve(env.openclawDir, 'logs'), { recursive: true });
  writeFileSync(resolve(env.openclawDir, 'logs/gateway.log'), 'log line\n');
  mkdirSync(resolve(env.openclawDir, 'browser/clawd'), { recursive: true });
  writeFileSync(resolve(env.openclawDir, 'browser/clawd/profile'), 'profile data\n');
  writeFileSync(resolve(env.openclawDir, 'openclaw.json.bak'), 'old backup\n');
  writeFileSync(resolve(env.openclawDir, 'openclaw.json.pre-foo-20260530T120000'), 'pre-foo\n');
  // And things that SHOULD be tracked
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  mkdirSync(resolve(env.openclawDir, 'cron'), { recursive: true });
  writeFileSync(resolve(env.openclawDir, 'cron/jobs.json'), '{}\n');

  run(env, ['init']);
  // ls-files via internal git invocation through `status`
  const r = spawnSync('git', ['--git-dir', env.gitDir, '--work-tree', env.openclawDir, 'ls-files'], { encoding: 'utf8' });
  const tracked = r.stdout.split('\n').filter(Boolean);
  if (verbose) log('tracked:', tracked);
  // Positive: tracked
  assert(tracked.includes('openclaw.json'), 'openclaw.json should be tracked');
  assert(tracked.includes('cron/jobs.json'), 'cron/jobs.json should be tracked');
  // Negative: ignored
  assert(!tracked.some(f => f.startsWith('logs/')), 'logs/ should be ignored');
  assert(!tracked.some(f => f.startsWith('browser/')), 'browser/ should be ignored');
  assert(!tracked.some(f => f.includes('.bak')), '.bak should be ignored');
  assert(!tracked.some(f => f.includes('.pre-')), '.pre-* should be ignored');
  rmSync(env.root, { recursive: true, force: true });
});

test('session .jsonl files are excluded', () => {
  const env = setup();
  mkdirSync(resolve(env.openclawDir, 'agents/main/sessions'), { recursive: true });
  writeFileSync(resolve(env.openclawDir, 'agents/main/sessions/sessions.json'), '{}\n');
  writeFileSync(resolve(env.openclawDir, 'agents/main/sessions/abc123.jsonl'), '{}\n{}\n');
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  const r = spawnSync('git', ['--git-dir', env.gitDir, '--work-tree', env.openclawDir, 'ls-files'], { encoding: 'utf8' });
  const tracked = r.stdout.split('\n').filter(Boolean);
  assert(tracked.includes('agents/main/sessions/sessions.json'), 'sessions.json tracked');
  assert(!tracked.some(f => f.endsWith('.jsonl')), '.jsonl files should be excluded');
  rmSync(env.root, { recursive: true, force: true });
});

test('diff shows pending changes', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":2}\n');
  const r = run(env, ['diff']);
  assertEq(r.status, 0, 'diff exit');
  assertContains(r.stdout, 'openclaw.json', 'should mention changed file');
  assertContains(r.stdout, '"v":2', 'should show new content');
  rmSync(env.root, { recursive: true, force: true });
});

test('log shows snapshot history', () => {
  const env = setup();
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":1}\n');
  run(env, ['init']);
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":2}\n');
  run(env, ['snapshot', 'v2-edit']);
  writeFileSync(resolve(env.openclawDir, 'openclaw.json'), '{"v":3}\n');
  run(env, ['snapshot', 'v3-edit']);
  const r = run(env, ['log']);
  assertEq(r.status, 0, 'log exit');
  assertContains(r.stdout, 'v3-edit', 'should list newest commit');
  assertContains(r.stdout, 'v2-edit', 'should list middle commit');
  assertContains(r.stdout, 'baseline', 'should list baseline');
  rmSync(env.root, { recursive: true, force: true });
});

test('restore back-and-forth keeps working', () => {
  const env = setup();
  const cfg = resolve(env.openclawDir, 'openclaw.json');
  writeFileSync(cfg, '{"v":1}\n');
  run(env, ['init']);
  const v1Sha = run(env, ['log', '-n', '1']).stdout.trim().split(' ')[0];
  writeFileSync(cfg, '{"v":2}\n');
  run(env, ['snapshot', 'v2']);
  const v2Sha = run(env, ['log', '-n', '1']).stdout.trim().split(' ')[0];
  // back to v1
  run(env, ['restore', v1Sha]);
  assertEq(readFileSync(cfg, 'utf8'), '{"v":1}\n', 'back to v1');
  // forward to v2
  run(env, ['restore', v2Sha]);
  assertEq(readFileSync(cfg, 'utf8'), '{"v":2}\n', 'forward to v2');
  rmSync(env.root, { recursive: true, force: true });
});

test('commands fail cleanly when not initialized', () => {
  const env = setup();
  const r = run(env, ['status']);
  assert(r.status !== 0, 'should fail without init');
  assertContains(r.stderr, 'not initialized', 'should hint to run init');
  rmSync(env.root, { recursive: true, force: true });
});

test('snapshot requires a note', () => {
  const env = setup();
  run(env, ['init']);
  const r = run(env, ['snapshot']);
  assert(r.status !== 0, 'should fail without note');
  rmSync(env.root, { recursive: true, force: true });
});

test('restore requires a sha', () => {
  const env = setup();
  run(env, ['init']);
  const r = run(env, ['restore']);
  assert(r.status !== 0, 'should fail without sha');
  rmSync(env.root, { recursive: true, force: true });
});

test('restore rejects invalid sha', () => {
  const env = setup();
  run(env, ['init']);
  const r = run(env, ['restore', 'deadbeefnotreal']);
  assert(r.status !== 0, 'should fail on bad sha');
  rmSync(env.root, { recursive: true, force: true });
});

test('repo size stays small after many edits', () => {
  const env = setup();
  const cfg = resolve(env.openclawDir, 'openclaw.json');
  writeFileSync(cfg, JSON.stringify({ v: 1, data: 'x'.repeat(10000) }) + '\n');
  run(env, ['init']);
  // 20 edits, snapshot each
  for (let i = 2; i <= 21; i++) {
    writeFileSync(cfg, JSON.stringify({ v: i, data: 'x'.repeat(10000) }) + '\n');
    run(env, ['snapshot', `iter-${i}`]);
  }
  run(env, ['gc']);
  const r = spawnSync('du', ['-sk', env.gitDir], { encoding: 'utf8' });
  const kib = parseInt(r.stdout.split(/\s+/)[0], 10);
  if (verbose) log(`repo size after 20 snapshots of 10K file: ${kib} KiB`);
  // 20 nearly-identical 10K commits should pack to well under 500KB
  assert(kib < 500, `repo should stay compact, got ${kib} KiB`);
  rmSync(env.root, { recursive: true, force: true });
});

test('restore works when invoked from a non-worktree cwd (regression)', () => {
  // Regression: `git checkout <sha> -- .` resolves pathspecs against cwd, so if
  // the user runs safe-state from ~/.openclaw/bin (or anywhere not the worktree
  // root), restore would silently do nothing. The fix pins cwd to OPENCLAW_DIR
  // inside the script. This test invokes safe-state from a deliberately wrong
  // cwd to make sure restore still touches the full worktree.
  const env = setup();
  const cfg = resolve(env.openclawDir, 'openclaw.json');
  writeFileSync(cfg, '{"v":1}\n');
  // Make a subdir to invoke from — anywhere but the worktree root
  const wrongCwd = resolve(env.openclawDir, 'bin');
  mkdirSync(wrongCwd, { recursive: true });
  // init from worktree root (normal case)
  run(env, ['init']);
  const baseSha = run(env, ['log', '-n', '1']).stdout.trim().split(' ')[0];
  // mutate + snapshot
  writeFileSync(cfg, '{"v":2}\n');
  run(env, ['snapshot', 'v2']);
  // Now restore from the WRONG cwd — would silently no-op pre-fix
  const r = spawnSync('node', [env.bin, 'restore', baseSha], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: env.home },
    cwd: wrongCwd, // ← deliberately wrong
  });
  assertEq(r.status, 0, 'restore exit from wrong cwd');
  assertEq(readFileSync(cfg, 'utf8'), '{"v":1}\n',
    'restore from wrong cwd must still revert worktree-root files');
  rmSync(env.root, { recursive: true, force: true });
});

// ─── summary ────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.ok).length;
const failed = results.filter(r => !r.ok).length;
const totalMs = results.reduce((s, r) => s + r.dt, 0);
console.log(`\n${passed}/${results.length} passed (${totalMs}ms total)`);
if (failed) {
  console.log('\nFailures:');
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  }
  process.exit(1);
}
