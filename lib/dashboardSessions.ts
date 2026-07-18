import { getRedis } from './redisClient';

// Opaque server-side sessions for the staff dashboard, mirroring
// trackingTokens.ts exactly: reuse the shared lazy Redis client (missing env
// vars fail loudly via parseEnv on first real use), no local-file fallback of
// any kind.
//
// The cookie carrying this token is a browser-session cookie (no Max-Age), so
// it dies when the browser closes; this Redis TTL is the independent
// server-side safety net for browsers that stay open — or cookies that stick
// around — longer than a shift.
const SESSION_TTL_SECONDS = 12 * 60 * 60;

// Single source of truth for the cookie name — login/logout routes, proxy.ts,
// and the root page must all agree on it.
export const SESSION_COOKIE_NAME = 'dashboard_session';

function sessionKey(token: string): string {
  return `dashboard:session:${token}`;
}

export async function createSession(): Promise<string> {
  const token = crypto.randomUUID();
  await getRedis().set(sessionKey(token), '1', { ex: SESSION_TTL_SECONDS });
  return token;
}

export async function isValidSession(token: string): Promise<boolean> {
  return (await getRedis().get(sessionKey(token))) !== null;
}

export async function deleteSession(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
}
