import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// SESSION_COOKIE_NAME stays real — the cookie the proxy reads is under test.
vi.mock('@/lib/dashboardSessions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/dashboardSessions')>();
  return { ...actual, isValidSession: vi.fn() };
});

import { proxy } from '@/proxy';
import { isValidSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

function makeRequest(path: string, cookieValue?: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: cookieValue
      ? { cookie: `${SESSION_COOKIE_NAME}=${cookieValue}` }
      : {},
  });
}

describe('proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a valid session through to dashboard pages', async () => {
    vi.mocked(isValidSession).mockResolvedValue(true);

    const response = await proxy(makeRequest('/dashboard', 'good-token'));

    expect(isValidSession).toHaveBeenCalledWith('good-token');
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('lets a valid session through to internal API routes', async () => {
    vi.mocked(isValidSession).mockResolvedValue(true);

    const response = await proxy(
      makeRequest('/api/internal/fleet-live', 'good-token'),
    );

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('redirects dashboard page requests without a cookie to / with 307', async () => {
    const response = await proxy(makeRequest('/dashboard'));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/');
    // No cookie means no session to validate — Redis is never consulted.
    expect(isValidSession).not.toHaveBeenCalled();
  });

  it('redirects dashboard sub-pages with an invalid session to / with 307', async () => {
    vi.mocked(isValidSession).mockResolvedValue(false);

    const response = await proxy(
      makeRequest('/dashboard/links', 'stale-token'),
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get('location')!).pathname).toBe('/');
  });

  it('returns 401 JSON — not a redirect — for internal API requests with an invalid session', async () => {
    vi.mocked(isValidSession).mockResolvedValue(false);

    const response = await proxy(
      makeRequest('/api/internal/fleet-live', 'stale-token'),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ error: 'Auth required' });
  });

  it('returns 401 JSON for internal API requests with no cookie at all', async () => {
    const response = await proxy(makeRequest('/api/internal/links'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Auth required' });
    expect(isValidSession).not.toHaveBeenCalled();
  });
});
