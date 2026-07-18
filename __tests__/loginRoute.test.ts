import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/dashboardGate', () => ({
  evaluateLoginAttempt: vi.fn(),
}));

// SESSION_COOKIE_NAME stays real — the cookie the route sets is under test.
vi.mock('@/lib/dashboardSessions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/dashboardSessions')>();
  return { ...actual, createSession: vi.fn() };
});

import { POST } from '@/app/api/login/route';
import { evaluateLoginAttempt } from '@/lib/dashboardGate';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

const SESSION_TOKEN = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '1.2.3.4',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createSession).mockResolvedValue(SESSION_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects malformed JSON with a generic 400 without touching the gate', async () => {
    const response = await POST(makeRequest('{not json'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(evaluateLoginAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['missing username', { password: 'pw' }],
    ['missing password', { username: 'dispatch' }],
    ['empty username', { username: '', password: 'pw' }],
    ['empty password', { username: 'dispatch', password: '' }],
    ['non-string fields', { username: 42, password: true }],
  ])('rejects %s with the same generic 400', async (_label, body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid request' });
    expect(evaluateLoginAttempt).not.toHaveBeenCalled();
  });

  it('returns a generic 401 for wrong credentials, creating no session and no cookie', async () => {
    vi.mocked(evaluateLoginAttempt).mockResolvedValue({
      outcome: 'unauthorized',
    });

    const response = await POST(
      makeRequest({ username: 'dispatch', password: 'wrong' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid credentials' });
    expect(createSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('returns 429 with Retry-After when the gate reports rate limiting', async () => {
    vi.mocked(evaluateLoginAttempt).mockResolvedValue({
      outcome: 'rateLimited',
      retryAfterMs: 42_000,
    });

    const response = await POST(
      makeRequest({ username: 'dispatch', password: 'wrong' }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    const body = await response.json();
    expect(typeof body.error).toBe('string');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('passes the credentials and forwarded IP to the gate', async () => {
    vi.mocked(evaluateLoginAttempt).mockResolvedValue({ outcome: 'allowed' });

    await POST(makeRequest({ username: 'dispatch', password: 'pw' }));

    expect(evaluateLoginAttempt).toHaveBeenCalledWith(
      { username: 'dispatch', password: 'pw' },
      '1.2.3.4',
    );
  });

  it('on success sets an HttpOnly SameSite=Lax session cookie with NO Max-Age/Expires', async () => {
    vi.mocked(evaluateLoginAttempt).mockResolvedValue({ outcome: 'allowed' });

    const response = await POST(
      makeRequest({ username: 'dispatch', password: 'pw' }),
    );

    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${SESSION_TOKEN}`);
    expect(cookie).toMatch(/httponly/i);
    expect(cookie).toMatch(/samesite=lax/i);
    expect(cookie).toMatch(/path=\//i);
    // A true browser-session cookie: nothing that would persist it to disk.
    expect(cookie).not.toMatch(/max-age/i);
    expect(cookie).not.toMatch(/expires/i);
  });

  it('omits Secure outside production but includes it in production', async () => {
    vi.mocked(evaluateLoginAttempt).mockResolvedValue({ outcome: 'allowed' });

    const devResponse = await POST(
      makeRequest({ username: 'dispatch', password: 'pw' }),
    );
    expect(devResponse.headers.get('set-cookie')).not.toMatch(/secure/i);

    vi.stubEnv('NODE_ENV', 'production');
    const prodResponse = await POST(
      makeRequest({ username: 'dispatch', password: 'pw' }),
    );
    expect(prodResponse.headers.get('set-cookie')).toMatch(/secure/i);
  });
});
