import { NextResponse, type NextRequest } from 'next/server';
import { deleteSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

// Deliberately OUTSIDE proxy.ts's matchers and with no auth check of its own:
// logging out must always work, even with an invalid or expired session.
export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (token) {
      await deleteSession(token);
    }

    const response = NextResponse.json({ ok: true });
    // Max-Age=0 tells the browser to drop the cookie immediately.
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    console.error('logout route failed:', error);
    return NextResponse.json({ error: 'Unable to log out' }, { status: 502 });
  }
}
