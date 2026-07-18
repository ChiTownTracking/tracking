import { NextResponse, type NextRequest } from 'next/server';
import { isValidSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

// Session-cookie gate for everything staff-only. Login/logout and the root
// login page sit OUTSIDE these matchers on purpose — they must stay reachable
// pre-authentication.
export async function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  // Skip the Redis round-trip entirely when there's no cookie to validate.
  const authenticated = token ? await isValidSession(token) : false;

  if (authenticated) {
    return NextResponse.next();
  }

  // API routes are fetched via JS, not navigated to — a redirect would just
  // hand fetch() the login page's HTML. They get the app's standard JSON
  // error shape instead; client code treats the 401 as "session expired".
  if (req.nextUrl.pathname.startsWith('/api/internal')) {
    return NextResponse.json({ error: 'Auth required' }, { status: 401 });
  }

  return NextResponse.redirect(new URL('/', req.url), 307);
}

export const config = { matcher: ['/dashboard/:path*', '/api/internal/:path*'] };
