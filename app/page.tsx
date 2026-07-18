import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { isValidSession, SESSION_COOKIE_NAME } from '@/lib/dashboardSessions';

// Staff login screen. Sits OUTSIDE proxy.ts's matchers so it's reachable
// pre-authentication; an already-valid session skips straight to /dashboard.
export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token && (await isValidSession(token))) {
    redirect('/dashboard');
  }

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-bg p-6 text-text">
      <LoginForm />
    </main>
  );
}
