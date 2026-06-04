import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

function parseDotenv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();

    const equals = line.indexOf('=');
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (!key) continue;

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function readRepoEnv() {
  try {
    return parseDotenv(readFileSync(join(REPO_ROOT, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

function readTelegramTokenFromConfig(configDir) {
  try {
    const config = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8'));
    const accounts = config?.channels?.telegram?.accounts;
    if (!accounts || typeof accounts !== 'object') return null;

    const defaultToken = accounts.default?.botToken;
    if (defaultToken) return defaultToken;

    for (const account of Object.values(accounts)) {
      if (account?.botToken) return account.botToken;
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveTelegramCreds(configDir = process.env.HOME + '/.openclaw') {
  const repoEnv = readRepoEnv();
  const token = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
    || repoEnv.OPENCLAW_TELEGRAM_BOT_TOKEN
    || readTelegramTokenFromConfig(configDir);
  const chatId = process.env.OPENCLAW_TELEGRAM_CHAT_ID
    || repoEnv.OPENCLAW_TELEGRAM_CHAT_ID;

  return { token: token || null, chatId: chatId || null };
}
