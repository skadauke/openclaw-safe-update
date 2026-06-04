// Test #09 — Post one real Telegram message to DM via direct Bot API.
// Confirms: Bot token is valid, Bot API reachable.
// On by default; pass --no-telegram to skip (e.g., for CI or sandbox runs).
//
// Credentials resolve from env vars, repo .env, and openclaw.json:
//   OPENCLAW_TELEGRAM_BOT_TOKEN — Telegram Bot API token (or openclaw.json)
//   OPENCLAW_TELEGRAM_CHAT_ID   — numeric chat ID to send test message to

export default {
  id: '09',
  name: 'telegram-roundtrip',
  // Runs in both full and quick (used by migrate.sh/rollback). Never sandbox —
  // we don't want to spam Telegram with sandbox probes.
  modes: ['current', 'quick'],
  requiresTelegram: true,
  timeout_ms: 15000,
  async run(ctx) {
    const token = ctx.telegramToken || process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
    const chatId = ctx.telegramChatId || process.env.OPENCLAW_TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return { ok: false, detail: 'OPENCLAW_TELEGRAM_BOT_TOKEN and OPENCLAW_TELEGRAM_CHAT_ID env vars must be set' };
    }
    const text = `[openclaw smoketest] gateway=${ctx.port} ${new Date().toISOString()}`;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(chatId), text }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) return { ok: false, detail: `send failed: ${json.description ?? JSON.stringify(json).slice(0, 100)}` };
      return { ok: true, detail: `message_id=${json.result?.message_id}` };
    } catch (err) {
      return { ok: false, detail: `fetch error: ${err.message}` };
    }
  },
};
