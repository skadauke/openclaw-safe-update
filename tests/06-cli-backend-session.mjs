// Test #06 — Gateway can run one default agent turn without delivering externally.
// This catches the important class where the gateway is healthy but intelligence
// execution is unavailable. Kept out of quick mode because it spends model tokens.

import { spawnSync } from 'node:child_process';

export default {
  id: '06',
  name: 'cli-backend-session',
  modes: ['current'],
  requiresModels: true,
  timeout_ms: 120000,
  run() {
    const sessionId = `smoketest-${Date.now()}`;
    const r = spawnSync('openclaw', [
      'agent',
      '--session-id', sessionId,
      '--message', 'Smoketest. Reply with exactly: ok',
      '--timeout', '90',
      '--thinking', 'off',
      '--json',
    ], { encoding: 'utf8', timeout: 110000 });
    if (r.status !== 0) return { ok: false, detail: `agent turn failed: ${(r.stderr || r.stdout).slice(0, 300)}` };
    const text = `${r.stdout}\n${r.stderr}`.toLowerCase();
    if (!text.includes('ok')) return { ok: false, detail: `agent response did not include ok: ${r.stdout.slice(0, 200)}` };
    return { ok: true, detail: `session ${sessionId}` };
  },
};
