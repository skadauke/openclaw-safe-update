// Test #03 — MCP surface is present and configurable.
// A full MCP JSON-RPC stdio handshake is intentionally deferred; this catches
// the practical failure where the CLI/gateway build no longer exposes MCP commands.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export default {
  id: '03',
  name: 'mcp-enumerate',
  modes: ['current', 'sandbox'],
  timeout_ms: 10000,
  run(ctx) {
    const cli = resolve(ctx.installDir, 'openclaw.mjs');
    const nodeBin = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/bin/node';
    const r = spawnSync(nodeBin, [cli, 'mcp', 'list', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_HOME: ctx.configDir, OPENCLAW_CONFIG_PATH: resolve(ctx.configDir, 'openclaw.json'), OPENCLAW_GATEWAY_PORT: String(ctx.port) },
      timeout: 8000 });
    if (r.status !== 0) return { ok: false, detail: `openclaw mcp list failed: ${(r.stderr || r.stdout).slice(0, 200)}` };
    let parsed;
    try { parsed = JSON.parse(r.stdout || '{}'); }
    catch (err) { return { ok: false, detail: `mcp list did not emit JSON: ${err.message}` }; }
    const count = Array.isArray(parsed) ? parsed.length : Object.keys(parsed.servers || parsed || {}).length;
    return { ok: true, detail: `mcp config readable (${count} configured server${count === 1 ? '' : 's'})` };
  },
};
