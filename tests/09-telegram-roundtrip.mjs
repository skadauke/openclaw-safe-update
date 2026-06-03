// Test #09 — Post one real Telegram message to DM via direct Bot API.
// Confirms: Bot token is valid, Bot API reachable.
// On by default; pass --no-telegram to skip (e.g., for CI or sandbox runs).
// Uses the alert-bus telegram-post.mjs directly — no gateway needed.

import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ALERT_BUS = resolve(homedir(), 'clawd/moby-os/intelligence/alert-bus');
const DM_CHAT_ID = 8290418965;

export default {
  id: '09',
  name: 'telegram-roundtrip',
  // Runs in both full and quick (used by migrate.sh/rollback). Never sandbox —
  // we don't want to spam Telegram with sandbox probes.
  modes: ['current', 'quick'],
  requiresTelegram: true,
  timeout_ms: 15000,
  async run(ctx) {
    let sendMessage;
    try {
      ({ sendMessage } = await import(resolve(ALERT_BUS, 'lib/telegram-post.mjs')));
    } catch (err) {
      return { ok: false, detail: `could not load telegram-post: ${err.message}` };
    }
    const text = `[openclaw smoketest] gateway=${ctx.port} ${new Date().toISOString()}`;
    const r = await sendMessage({ chat_id: DM_CHAT_ID, thread_id: null, text });
    if (!r.ok) return { ok: false, detail: `send failed: ${r.reason} (${JSON.stringify(r.raw ?? '').slice(0, 100)})` };
    return { ok: true, detail: `message_id=${r.message_id}` };
  },
};
