import { checkDashboardCredentials } from './dashboardAuth';
import { dashboardLoginLimiter, type RateLimiter } from './rateLimiter';

export type LoginOutcome =
  | { outcome: 'allowed' }
  | { outcome: 'unauthorized' }
  | { outcome: 'rateLimited'; retryAfterMs: number };

// Called by POST /api/login (this logic guarded proxy.ts back when the
// dashboard used Basic Auth — same ordering guarantee, new call site).
// The limiter parameter exists so tests can inject an isolated instance;
// real callers use the shared dashboardLoginLimiter singleton.
export async function evaluateLoginAttempt(
  credentials: { username: string; password: string },
  ip: string,
  limiter: RateLimiter = dashboardLoginLimiter,
): Promise<LoginOutcome> {
  // Correct credentials short-circuit before the limiter is touched: only
  // FAILED attempts count against the budget, so a staff member logging in
  // correctly (or several staff behind one office NAT) can never be locked
  // out by someone else's failures.
  if (checkDashboardCredentials(credentials.username, credentials.password)) {
    return { outcome: 'allowed' };
  }

  const limit = await limiter.check(ip);
  if (!limit.allowed) {
    return { outcome: 'rateLimited', retryAfterMs: limit.retryAfterMs ?? 0 };
  }

  return { outcome: 'unauthorized' };
}
