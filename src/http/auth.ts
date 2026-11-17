// Mini App initData verification (HMAC-SHA256 per Telegram's Web Apps docs).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const INIT_DATA_MAX_AGE_S = 24 * 3600;

export type InitUser = { id: number; first_name?: string; username?: string };
export type VerifiedInit = { user: InitUser; authDate: number; startParam: string | null };

export type InitCheck = { ok: VerifiedInit } | { reason: 'missing' | 'malformed' | 'bad-signature' | 'expired' };

/** Verifies Telegram Mini App initData and says why it was rejected. */
export function checkInitData(initData: string, botToken: string, nowMs: number, maxAgeS = INIT_DATA_MAX_AGE_S): InitCheck {
  if (!initData) return { reason: 'missing' };
  if (initData.length > 8192) return { reason: 'malformed' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { reason: 'malformed' };
  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(pairs.join('\n')).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { reason: 'bad-signature' };
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || nowMs / 1000 - authDate > maxAgeS || authDate - nowMs / 1000 > 300) return { reason: 'expired' };
  let user: InitUser;
  try { user = JSON.parse(params.get('user') || ''); } catch { return { reason: 'malformed' }; }
  if (!user || !Number.isSafeInteger(user.id)) return { reason: 'malformed' };
  return { ok: { user, authDate, startParam: params.get('start_param') } };
}

export function verifyInitData(initData: string, botToken: string, nowMs: number, maxAgeS = INIT_DATA_MAX_AGE_S): VerifiedInit | null {
  const r = checkInitData(initData, botToken, nowMs, maxAgeS);
  return 'ok' in r ? r.ok : null;
}

/** Test helper: produce a valid initData string. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const p = new URLSearchParams(fields);
  p.set('hash', hash);
  return p.toString();
}
