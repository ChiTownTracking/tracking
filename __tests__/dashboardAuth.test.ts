import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDashboardCredentials } from '@/lib/dashboardAuth';

// parseBasicAuthHeader and its tests were removed with the session-cookie
// rework: the login form submits username/password directly, so there is no
// Authorization header left to parse anywhere in the app.

describe('checkDashboardCredentials', () => {
  beforeEach(() => {
    vi.stubEnv('DASHBOARD_USER', 'dispatch');
    vi.stubEnv('DASHBOARD_PASS', 'correct:horse:battery');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true for correct credentials', () => {
    expect(
      checkDashboardCredentials('dispatch', 'correct:horse:battery'),
    ).toBe(true);
  });

  it('returns false for a wrong password', () => {
    expect(checkDashboardCredentials('dispatch', 'wrong')).toBe(false);
  });

  it('returns false for a wrong username', () => {
    expect(
      checkDashboardCredentials('intruder', 'correct:horse:battery'),
    ).toBe(false);
  });

  it('returns false when both fields are empty', () => {
    expect(checkDashboardCredentials('', '')).toBe(false);
  });

  it('handles mismatched-length inputs without throwing', () => {
    // timingSafeStringEqual hashes before comparing precisely so that
    // arbitrary-length input can never crash the check.
    expect(
      checkDashboardCredentials('dispatch', 'x'.repeat(10_000)),
    ).toBe(false);
  });
});
