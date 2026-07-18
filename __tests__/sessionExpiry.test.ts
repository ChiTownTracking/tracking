import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirectIfSessionExpired } from '@/lib/sessionExpiry';

describe('redirectIfSessionExpired', () => {
  const assign = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('window', { location: { assign } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockClear();
  });

  it('redirects to / on a 401 and reports true', () => {
    expect(redirectIfSessionExpired(401)).toBe(true);
    expect(assign).toHaveBeenCalledWith('/');
  });

  it.each([200, 400, 404, 429, 502])(
    'leaves status %i alone and reports false',
    (status) => {
      expect(redirectIfSessionExpired(status)).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    },
  );
});
