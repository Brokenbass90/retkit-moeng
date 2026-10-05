import crypto from 'node:crypto';

export const ALLOWED_ORIGIN = 'https://dashboard-02.moengage.com';

export function assertLoopbackHost(host) {
  const value = String(host || '');
  if (value !== '127.0.0.1') throw new Error('RetKit AI bridge must bind to loopback 127.0.0.1');
  return value;
}

export function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(String(origin));
    return `${url.protocol}//${url.host}` === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

// WebSocket sessions are browser-only: a missing Origin means a non-browser
// client, which must not be able to open a chat session or drive the page.
export function isAllowedBrowserOrigin(origin) {
  return Boolean(origin) && isAllowedOrigin(origin);
}

export function createSessionSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

export function sessionSecretMatches(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
