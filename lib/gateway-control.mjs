import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_MACOS_LABEL = 'ai.openclaw.gateway';
const DEFAULT_LINUX_UNIT = 'openclaw-gateway';

export function detectPlatform() {
  return process.platform === 'darwin' ? 'macos' : 'linux';
}

function macosLabel() {
  return process.env.OPENCLAW_LAUNCHD_LABEL ?? DEFAULT_MACOS_LABEL;
}

function linuxUnit() {
  const raw = process.env.OPENCLAW_SYSTEMD_UNIT ?? DEFAULT_LINUX_UNIT;
  return raw.endsWith('.service') ? raw : `${raw}.service`;
}

export function getDefaultServiceId() {
  return detectPlatform() === 'macos' ? macosLabel() : linuxUnit();
}

export function getPlistPath(label) {
  return resolve(homedir(), `Library/LaunchAgents/${label ?? macosLabel()}.plist`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: opts.timeout ?? 30000,
    env: opts.env ?? process.env,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}

// ── macOS rollback path ───────────────────────────────────────────────────────

function waitServiceGone(label, maxMs = 30000) {
  // launchctl bootout is async; poll until the service is fully unloaded before
  // issuing bootstrap to avoid "Bootstrap failed: 5: Input/output error".
  const target = `gui/${process.getuid()}/${label}`;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = spawnSync('launchctl', ['print', target], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 && /Could not find service/.test(r.stderr + r.stdout)) return true;
    spawnSync('sleep', ['0.5']);
  }
  return false;
}

function stopMacos(label) {
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], {
    encoding: 'utf8', timeout: 15000,
  });
  if (!waitServiceGone(label, 30000)) {
    process.stderr.write('  ⚠ service still showing after 30s; proceeding anyway\n');
  }
}

function startMacos(label) {
  const plist = getPlistPath(label);
  if (!existsSync(plist)) throw new Error(`plist not found: ${plist}`);
  const r = run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { timeout: 15000 });
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr || r.stdout}`);
}

// ── Linux rollback path ───────────────────────────────────────────────────────

function systemctlUser(args, opts = {}) {
  const r = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30000,
  });
  // Fall back to --machine <user>@ if D-Bus session bus is unavailable.
  if (r.status !== 0 && /Failed to connect to bus|DBUS_SESSION_BUS_ADDRESS/i.test(r.stderr ?? '')) {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    return spawnSync('systemctl', [`--machine=${user}@`, '--user', ...args], {
      encoding: 'utf8', stdio: 'pipe', timeout: opts.timeout ?? 30000,
    });
  }
  return r;
}

function stopLinux(unit) {
  const r = systemctlUser(['stop', unit], { timeout: 30000 });
  if (r.status !== 0 && !/not loaded|not found|No such file/i.test((r.stderr ?? '') + (r.stdout ?? ''))) {
    process.stderr.write(`  ⚠ systemctl stop returned ${r.status}: ${(r.stderr || r.stdout || '').trim()}\n`);
  }
}

function startLinux(unit) {
  const r = systemctlUser(['start', unit], { timeout: 30000 });
  if (r.status !== 0) throw new Error(`systemctl start ${unit} failed: ${r.stderr || r.stdout}`);
}

// ── Port-free check ───────────────────────────────────────────────────────────

function isPortFreeLinux(port) {
  const ss = spawnSync('ss', ['-tlnp'], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
  if (ss.status === 0) {
    return !new RegExp(`:${port}(\\s|$)`, 'm').test(ss.stdout);
  }
  // Fall back to /proc/net/tcp hex parsing when ss is unavailable.
  try {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
    const isListening = (content) =>
      content.split('\n').slice(1).some(line => {
        const cols = line.trim().split(/\s+/);
        // cols[1] = local_address:port hex, cols[3] = state (0A = TCP_LISTEN)
        return cols[1]?.endsWith(`:${hexPort}`) && cols[3] === '0A';
      });
    const tcp = existsSync('/proc/net/tcp') ? readFileSync('/proc/net/tcp', 'utf8') : '';
    const tcp6 = existsSync('/proc/net/tcp6') ? readFileSync('/proc/net/tcp6', 'utf8') : '';
    return !isListening(tcp) && !isListening(tcp6);
  } catch {
    return true;
  }
}

export function isPortFree(port) {
  if (detectPlatform() === 'macos') {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    return r.status !== 0;
  }
  return isPortFreeLinux(port);
}

// ── Promote path: delegate to the new binary's cross-platform CLI ─────────────

function runOpenclawGateway(installDir, subcmd, opts = {}) {
  const entry = resolve(installDir, 'dist/index.js');
  const r = spawnSync(process.execPath, [entry, 'gateway', ...subcmd], {
    encoding: 'utf8',
    stdio: 'inherit',
    timeout: opts.timeout ?? 90000,
    env: process.env,
  });
  if (r.error) throw new Error(`openclaw gateway ${subcmd[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`openclaw gateway ${subcmd[0]} exited ${r.status}`);
}

// ── Public exports ────────────────────────────────────────────────────────────

/**
 * Stop the gateway.
 * Promote path (installDir provided): `openclaw gateway stop`.
 * Rollback path (no installDir): platform-native commands — safe even when the
 * current binary is broken.
 */
export async function stopGateway(installDir, opts = {}) {
  if (installDir) {
    runOpenclawGateway(installDir, ['stop'], opts);
  } else if (detectPlatform() === 'macos') {
    stopMacos(macosLabel());
  } else {
    stopLinux(linuxUnit());
  }
}

/**
 * Start the gateway.
 * Promote path (installDir provided): `openclaw gateway start`.
 * Rollback path (no installDir): platform-native commands.
 */
export async function startGateway(installDir, opts = {}) {
  if (installDir) {
    runOpenclawGateway(installDir, ['start'], opts);
  } else if (detectPlatform() === 'macos') {
    startMacos(macosLabel());
  } else {
    startLinux(linuxUnit());
  }
}

/**
 * Restart the gateway.
 * Promote path (installDir provided): `openclaw gateway restart` via the
 * new binary — cross-platform, profile-aware, rewrites plist/unit if needed.
 * Rollback path (no installDir): platform-native stop then start.
 */
export async function restartGateway(installDir, opts = {}) {
  if (installDir) {
    process.stdout.write('  → openclaw gateway restart ...\n');
    runOpenclawGateway(installDir, ['restart'], { timeout: 90000, ...opts });
    return;
  }
  if (detectPlatform() === 'macos') {
    process.stdout.write('  → launchctl bootout (waiting for service to unload)...\n');
    stopMacos(macosLabel());
    process.stdout.write('  → launchctl bootstrap...\n');
    startMacos(macosLabel());
  } else {
    const unit = linuxUnit();
    process.stdout.write(`  → systemctl --user stop/start ${unit}...\n`);
    stopLinux(unit);
    startLinux(unit);
  }
}

/**
 * Wait for the gateway /healthz endpoint to return {"ok":true}.
 * Returns true if healthy within maxMs, false on timeout.
 */
export async function waitGatewayHealthy(port, maxMs = 40000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = spawnSync('curl', ['-sf', '--max-time', '1', `http://127.0.0.1:${port}/healthz`], {
      encoding: 'utf8', timeout: 3000, stdio: 'pipe',
    });
    if (r.status === 0 && /"ok":true/.test(r.stdout)) return true;
    spawnSync('sleep', ['1']);
  }
  return false;
}

// ── CLI mode (bash script interop) ───────────────────────────────────────────

async function cliMain(argv) {
  const cmd = argv[2];
  if (cmd === 'detect-platform') {
    process.stdout.write(detectPlatform() + '\n');
  } else if (cmd === 'service-id') {
    process.stdout.write(getDefaultServiceId() + '\n');
  } else if (cmd === 'stop') {
    await stopGateway(null);
  } else if (cmd === 'start') {
    await startGateway(null);
  } else if (cmd === 'wait-port-free') {
    const port = Number(argv[3]);
    const maxSec = Number(argv[4] ?? 30);
    if (!port) { process.stderr.write('usage: wait-port-free <port> [maxSeconds]\n'); process.exit(2); }
    const deadline = Date.now() + maxSec * 1000;
    while (Date.now() < deadline) {
      if (isPortFree(port)) process.exit(0);
      spawnSync('sleep', ['1']);
    }
    process.exit(1);
  } else {
    process.stderr.write(`gateway-control: unknown command: ${cmd ?? '(none)'}\nCommands: detect-platform, service-id, stop, start, wait-port-free <port> [maxSec]\n`);
    process.exit(2);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  cliMain(process.argv).catch(err => {
    process.stderr.write(`gateway-control: ${err.message}\n`);
    process.exit(1);
  });
}
