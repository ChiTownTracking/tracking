import { getDashboardCredentials } from './dashboardAuthEnv';
import { timingSafeStringEqual } from './timingSafeCompare';

// Pure, framework-free credential check. The /api/login route handler is only
// a thin wrapper around this (plus the rate-limit gate in dashboardGate.ts).
// Basic Auth header parsing lived here until the session-cookie rework; the
// login form now submits the fields directly, so the check takes them as-is.

export function checkDashboardCredentials(
  username: string,
  password: string,
): boolean {
  const expected = getDashboardCredentials();
  // Evaluate both comparisons before combining so the username check's
  // outcome doesn't short-circuit away the password comparison.
  const userOk = timingSafeStringEqual(username, expected.username);
  const passOk = timingSafeStringEqual(password, expected.password);
  return userOk && passOk;
}
