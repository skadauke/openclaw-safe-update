// Test #02 — Gateway responds on /healthz with {"ok": true}.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function startupFailureDetail(configDir) {
  const candidates = [resolve(configDir, 'gateway.err.log'), resolve(configDir, 'logs/gateway.err.log')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const txt = readFileSync(p, 'utf8');
    const idx = Math.max(txt.lastIndexOf('Gateway failed to start'), txt.lastIndexOf('Invalid config'));
    if (idx !== -1) return txt.slice(idx, idx + 500).replace(/\s+/g, ' ').trim();
  }
  return '';
}
// Polls for up to 30s — gateway boot can take 15-25s on first launch after
// launchd bootstrap (plugin init, Tailscale handshake, etc).
export default {
  id: '02',
  name: 'gateway-health',
  modes: ['current', 'sandbox', 'quick'],
  timeout_ms: 35000,
  async run(ctx) {
    const url = `http://127.0.0.1:${ctx.port}/healthz`;
    const deadline = Date.now() + 30000;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          if (body.ok) {
            const elapsed = Math.round((Date.now() - (deadline - 30000)) / 1000);
            return { ok: true, detail: `port ${ctx.port} status=${body.status ?? 'live'} (ready in ${elapsed}s)` };
          }
          return { ok: false, detail: `body did not assert ok: ${JSON.stringify(body).slice(0, 100)}` };
        }
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err.message;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const startup = startupFailureDetail(ctx.configDir);
    return { ok: false, detail: startup ? `no healthy response within 30s (${lastErr}); ${startup}` : `no healthy response within 30s (${lastErr})` };
  },
};
