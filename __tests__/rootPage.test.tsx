import { beforeEach, describe, expect, it, vi } from 'vitest';

// The page's redirect-if-already-authenticated decision is real logic; the
// LoginForm it falls back to is presentation and gets stubbed out.
vi.mock('@/components/LoginForm', () => ({
  default: () => null,
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(),
}));

// Mirror the real behavior: redirect() throws, it never returns.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock('@/lib/dashboardSessions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/dashboardSessions')>();
  return { ...actual, isValidSession: vi.fn() };
});

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Home from '@/app/page';
import { isValidSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

function stubCookie(value?: string) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) =>
      value !== undefined && name === SESSION_COOKIE_NAME
        ? { name, value }
        : undefined,
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

describe('root page (login screen)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to /dashboard when the session cookie is valid', async () => {
    stubCookie('good-token');
    vi.mocked(isValidSession).mockResolvedValue(true);

    await expect(Home()).rejects.toThrow('NEXT_REDIRECT:/dashboard');

    expect(isValidSession).toHaveBeenCalledWith('good-token');
    expect(redirect).toHaveBeenCalledWith('/dashboard');
  });

  it('renders the login form when there is no session cookie, without consulting Redis', async () => {
    stubCookie(undefined);

    await expect(Home()).resolves.toBeTruthy();

    expect(isValidSession).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the login form when the session cookie is invalid or expired', async () => {
    stubCookie('stale-token');
    vi.mocked(isValidSession).mockResolvedValue(false);

    await expect(Home()).resolves.toBeTruthy();

    expect(redirect).not.toHaveBeenCalled();
  });
});
