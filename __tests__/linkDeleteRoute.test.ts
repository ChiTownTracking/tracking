import { beforeEach, describe, expect, it, vi } from 'vitest';

// isUuidShaped stays real — the route's token-shape gate is under test here.
vi.mock('@/lib/trackingTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trackingTokens')>();
  return { ...actual, deleteTrackingLink: vi.fn() };
});

import { DELETE } from '@/app/api/internal/links/[token]/route';
import { deleteTrackingLink } from '@/lib/trackingTokens';

const TOKEN = 'a1b2c3d4-1111-4222-8333-abcdefabcdef';

function makeParams(token: string): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

describe('DELETE /api/internal/links/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteTrackingLink).mockResolvedValue(undefined);
  });

  it('deletes a UUID-shaped token and reports ok', async () => {
    const response = await DELETE(new Request('http://localhost'), makeParams(TOKEN));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(deleteTrackingLink).toHaveBeenCalledWith(TOKEN);
  });

  it('rejects a token that is not UUID-shaped with 404, before any Redis lookup', async () => {
    const response = await DELETE(
      new Request('http://localhost'),
      makeParams('not-a-uuid'),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(deleteTrackingLink).not.toHaveBeenCalled();
  });
});
