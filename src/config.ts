// Runtime configuration from environment variables (see .env.example).
import { isValidTimeZone } from './time.ts';

export type Config = {
  botToken: string;
  allowedUserIds: Set<number>;
  publicUrl: string;          // https base URL serving the Mini App, e.g. https://todo.example.com
  port: number;
  dbPath: string;
  defaultTz: string;
  pinPreview: boolean;
  apiBase: string;            // Bot API base, overridable for tests / local Bot API server
  widgets: 'auto' | 'on' | 'off'; // auto: use widgets, fall back to inline keyboards if Telegram refuses them
};

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function loadConfig(): Config {
  const ids = req('ALLOWED_USER_IDS').split(',').map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length) throw new Error('ALLOWED_USER_IDS must contain at least one numeric Telegram user id');
  const defaultTz = process.env.DEFAULT_TZ || 'UTC';
  if (!isValidTimeZone(defaultTz)) throw new Error(`DEFAULT_TZ is not a valid IANA time zone: ${defaultTz}`);
  const publicUrl = req('PUBLIC_URL').replace(/\/+$/, '');
  if (!publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must be an https:// URL (Telegram requires HTTPS for Mini Apps)');
  return {
    botToken: req('BOT_TOKEN'),
    allowedUserIds: new Set(ids),
    publicUrl,
    port: Number(process.env.PORT || 8080),
    dbPath: process.env.DB_PATH || './data/todo.sqlite',
    defaultTz,
    pinPreview: /^(1|true|yes)$/i.test(process.env.PIN_PREVIEW || ''),
    widgets: (['on', 'off'].includes((process.env.WIDGETS || '').toLowerCase()) ? process.env.WIDGETS!.toLowerCase() : 'auto') as Config['widgets'],
    apiBase: (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
  };
}
