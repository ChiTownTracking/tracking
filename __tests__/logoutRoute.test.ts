import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// SESSION_COOKIE_NAME stays real — the cookie the route clears is under test.
vi.mock('@/lib/dashboardSessions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/dashboardSessions')>();
  return { ...actual, deleteSession: vi.fn() };
});

import { POST } from '@/app/api/logout/route';
import { deleteSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

function makeRequest(cookieValue?: string): NextRequest {
  return new NextRequest('http://localhost/api/logout', {
    method: 'POST',
    headers: cookieValue
      ? { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` }
      : {},
  });
}

describe('POST /api/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });

  it('deletes the session from Redis and expires the cookie', async () => {
    const response = await POST(makeRequest('session-token-123'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteSession).toHaveBeenCalledWith('session-token-123');

    const cookie = response.headers.get('set-cookie');
    expect(cookie).toMatch(new RegExp(`${SESSION_COOKIE_NAME}=;`));
    expect(cookie).toMatch(/max-age=0/i);
  });

  it('still succeeds and clears the cookie when no session cookie is present', async () => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toMatch(/max-age=0/i);
  });
});
