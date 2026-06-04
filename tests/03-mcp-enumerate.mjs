// Test #03 — MCP surface: shallow config check + full JSON-RPC tools/list handshake.
// Phase 1: openclaw mcp list --json exits 0 and returns parseable JSON (fast pre-check).
// Phase 2: detect transport from mcp list output; send tools/list; assert ≥1 tool returned.

import { spawnSync, spawn } from 'node:child_process';
import { resolve } from 'node:path';

function normalizeServers(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.servers)) return parsed.servers;
    if (parsed.servers && typeof parsed.servers === 'object') {
      return Object.entries(parsed.servers).map(([name, cfg]) => ({ name, ...cfg }));
    }
    const vals = Object.values(parsed);
    if (vals.length && vals.every(v => v && typeof v === 'object')) {
      return Object.entries(parsed).map(([name, cfg]) => ({ name, ...cfg }));
    }
  }
  return [];
}

// Streamable HTTP transport: POST tools/list directly (no session setup required).
async function tryStreamableHttp(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj?.result?.tools !== undefined) return obj.result.tools;
        } catch { /* */ }
      }
      return null;
    }
    const body = await res.json();
    return body?.result?.tools ?? null;
  } catch { return null; }
}

// SSE transport: open <baseUrl>/sse, receive session endpoint, send initialize + tools/list.
async function trySSETransport(baseUrl, timeoutMs) {
  const sseUrl = baseUrl.replace(/\/?$/, '/sse');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const postMsg = (endpoint, msg) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg),
  }).catch(() => {});

  let reader;
  try {
    const sseRes = await fetch(sseUrl, {
      headers: { Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!sseRes.ok || !sseRes.headers.get('content-type')?.includes('text/event-stream')) {
      clearTimeout(timer);
      return null;
    }

    reader = sseRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let endpoint = null;
    let initialized = false;
    let toolsResult = null;

    while (!ctrl.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const raw of lines) {
        if (!raw.startsWith('data:')) continue;
        const data = raw.slice(5).trim();

        if (!endpoint) {
          if (data.startsWith('/') || data.startsWith('http')) {
            endpoint = data.startsWith('/') ? new URL(data, sseUrl).href : data;
          } else {
            try {
              const obj = JSON.parse(data);
              endpoint = obj.endpoint || obj.url || null;
            } catch { /* */ }
          }
          if (endpoint) {
            postMsg(endpoint, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoketest', version: '1' } } });
          }
          continue;
        }

        try {
          const obj = JSON.parse(data);
          if (!initialized && obj?.id === 0 && obj?.result) {
            initialized = true;
            postMsg(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            postMsg(endpoint, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
          } else if (obj?.id === 1 && obj?.result?.tools !== undefined) {
            toolsResult = obj.result.tools;
            ctrl.abort();
          }
        } catch { /* */ }
      }
    }

    clearTimeout(timer);
    return toolsResult;
  } catch {
    clearTimeout(timer);
    return null;
  } finally {
    try { reader?.cancel(); } catch { /* */ }
  }
}

// Stdio transport: spawn server, send initialize + tools/list, parse newline-delimited JSON responses.
async function tryStdioMcp(command, args, extraEnv, timeoutMs) {
  return new Promise((res) => {
    let settled = false;
    let proc;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc?.kill(); } catch { /* */ }
      res(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);

    try {
      proc = spawn(command, args || [], {
        env: { ...process.env, ...(extraEnv || {}) },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      proc.on('error', () => done(null));

      let stdout = '';
      let initialized = false;
      proc.stdout.on('data', chunk => {
        stdout += chunk;
        for (const line of stdout.split('\n')) {
          try {
            const obj = JSON.parse(line.trim());
            if (!initialized && obj?.id === 0 && obj?.result) {
              initialized = true;
              proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
              proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
            } else if (obj?.id === 1 && obj?.result?.tools !== undefined) {
              done(obj.result.tools);
            }
          } catch { /* */ }
        }
      });

      proc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoketest', version: '1' } },
      }) + '\n');
    } catch { done(null); }
  });
}

export default {
  id: '03',
  name: 'mcp-enumerate',
  modes: ['current', 'sandbox'],
  timeout_ms: 30000,
  async run(ctx) {
    const cli = resolve(ctx.installDir, 'openclaw.mjs');
    const nodeBin = process.env.OPENCLAW_NODE_BIN || '/opt/homebrew/bin/node';
    const env = {
      ...process.env,
      OPENCLAW_HOME: ctx.configDir,
      OPENCLAW_CONFIG_PATH: resolve(ctx.configDir, 'openclaw.json'),
      OPENCLAW_GATEWAY_PORT: String(ctx.port),
    };

    // Phase 1: shallow pre-check (fast fail if CLI surface is broken)
    const r = spawnSync(nodeBin, [cli, 'mcp', 'list', '--json'], { encoding: 'utf8', env, timeout: 8000 });
    if (r.status !== 0) {
      return { ok: false, detail: `openclaw mcp list failed: ${(r.stderr || r.stdout).slice(0, 200)}` };
    }
    let parsed;
    try { parsed = JSON.parse(r.stdout || '{}'); }
    catch (err) { return { ok: false, detail: `mcp list did not emit JSON: ${err.message}` }; }

    const servers = normalizeServers(parsed);
    const configCount = Array.isArray(parsed) ? parsed.length
      : Object.keys(parsed?.servers || parsed || {}).length;

    // Phase 2: JSON-RPC tools/list handshake — detect transport from mcp list output.
    const httpCandidates = [];
    const stdioCandidates = [];

    for (const s of servers) {
      const url = s.url || s.serverUrl || s.endpoint || s.baseUrl;
      if (url && typeof url === 'string') httpCandidates.push(url.replace(/\/$/, ''));
      if (s.command && typeof s.command === 'string') {
        stdioCandidates.push({ command: s.command, args: s.args || [], env: s.env || {} });
      }
    }
    // Always try the gateway's own /mcp endpoint as a fallback
    httpCandidates.push(`http://127.0.0.1:${ctx.port}/mcp`);

    let tools = null;
    let transport = null;

    for (const url of httpCandidates) {
      tools = await tryStreamableHttp(url, 4000);
      if (tools !== null) { transport = `Streamable HTTP ${url}`; break; }
      tools = await trySSETransport(url, 6000);
      if (tools !== null) { transport = `SSE ${url}/sse`; break; }
    }

    if (tools === null) {
      for (const { command, args, env: sEnv } of stdioCandidates) {
        tools = await tryStdioMcp(command, args, sEnv, 6000);
        if (tools !== null) { transport = `stdio ${command}`; break; }
      }
    }

    if (tools === null) {
      return {
        ok: false,
        detail: `mcp list ok (${configCount} server${configCount === 1 ? '' : 's'}) but tools/list handshake failed on all candidates`,
      };
    }

    if (!Array.isArray(tools) || tools.length === 0) {
      return {
        ok: false,
        detail: `tools/list returned empty tools array via ${transport}; expected ≥1`,
      };
    }

    return {
      ok: true,
      detail: `${configCount} configured server${configCount === 1 ? '' : 's'}; tools/list: ${tools.length} tool${tools.length === 1 ? '' : 's'} via ${transport}`,
    };
  },
};
