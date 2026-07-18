import { NextResponse } from 'next/server';
import { z } from 'zod';
import { evaluateLoginAttempt } from '@/lib/dashboardGate';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

// Deliberately OUTSIDE proxy.ts's matchers — this route must stay reachable
// pre-authentication, it's how a session gets created in the first place.

const loginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = loginInputSchema.safeParse(body);
    if (!parsed.success) {
      // Generic on purpose — a login endpoint should never explain which
      // part of the input was wrong.
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }

    const ip = request.headers.get('x-forwarded-for') ?? 'unknown';
    const access = await evaluateLoginAttempt(parsed.data, ip);

    if (access.outcome === 'rateLimited') {
      return NextResponse.json(
        { error: 'Too many attempts. Try again shortly.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil(access.retryAfterMs / 1000)),
          },
        },
      );
    }
    if (access.outcome === 'unauthorized') {
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 },
      );
    }

    const token = await createSession();
    const response = NextResponse.json({ ok: true });
    // No Max-Age/Expires: a true browser-session cookie that clears on
    // browser close. The Redis-side 12h TTL is the independent server-side
    // lifetime cap (see dashboardSessions.ts).
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
    });
    return response;
  } catch (error) {
    console.error('login route failed:', error);
    return NextResponse.json({ error: 'Unable to log in' }, { status: 502 });
  }
}
