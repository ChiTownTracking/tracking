import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Import the class only, never the singleton — this file must run without any
// real QUARTIX_* env vars existing.
import { QuartixClient } from '@/lib/quartixClient';

const fakeConfig = {
  baseUrl: 'https://fake.test/v2/api',
  customerId: 'x',
  username: 'y',
  password: 'z',
  application: 'w',
};

function authSuccess(tokens = { AccessToken: 'abc', RefreshToken: 'def' }) {
  return { ok: true, status: 200, json: async () => ({ Data: tokens }) };
}

function dataSuccess(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ Data: data }) };
}

describe('QuartixClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authenticates then fetches data', async () => {
    fetchMock
      .mockResolvedValueOnce(authSuccess())
      .mockResolvedValueOnce(dataSuccess([{ VehicleID: 1 }]));

    const client = new QuartixClient(fakeConfig);
    const result = await client.get('/vehicles');

    expect(result).toEqual([{ VehicleID: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends auth as application/x-www-form-urlencoded (regression: multipart/form-data got a 415 from Quartix)', async () => {
    fetchMock
      .mockResolvedValueOnce(authSuccess())
      .mockResolvedValueOnce(dataSuccess([]));

    const client = new QuartixClient(fakeConfig);
    await client.get('/vehicles');

    const [authUrl, authInit] = fetchMock.mock.calls[0];
    expect(String(authUrl)).toBe('https://fake.test/v2/api/auth');
    expect(
      (authInit.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/x-www-form-urlencoded');
  });

  it('surfaces the auth failure status and response body to the caller', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          Data: null,
          Meta: {
            Code: 422,
            Message: 'Authorization has been denied for this request',
          },
        }),
    });

    const client = new QuartixClient(fakeConfig);
    const error = await client.get('/vehicles').then(
      () => {
        throw new Error('expected client.get to reject');
      },
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('422');
    expect(error.message).toContain('Authorization has been denied');
  });

  it('retries exactly once with a fresh token when the data request 401s', async () => {
    // Obtaining the fresh token after the 401 costs one fetch of its own (the
    // refresh call), so the full sequence is 4 calls: auth, failed data
    // request, token refresh, retried data request.
    fetchMock
      .mockResolvedValueOnce(authSuccess())
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(
        authSuccess({ AccessToken: 'abc2', RefreshToken: 'def2' }),
      )
      .mockResolvedValueOnce(dataSuccess([{ VehicleID: 2 }]));

    const client = new QuartixClient(fakeConfig);
    const result = await client.get('/vehicles');

    expect(result).toEqual([{ VehicleID: 2 }]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[2][0])).toBe(
      'https://fake.test/v2/api/auth/refresh',
    );
    // The retried request carries the fresh token, not the rejected one.
    expect(
      (fetchMock.mock.calls[3][1].headers as Record<string, string>)
        .AccessToken,
    ).toBe('abc2');
  });

  it('reuses the cached token across requests instead of re-authenticating', async () => {
    fetchMock
      .mockResolvedValueOnce(authSuccess())
      .mockResolvedValueOnce(dataSuccess([{ VehicleID: 1 }]))
      .mockResolvedValueOnce(dataSuccess([{ VehicleID: 2 }]));

    const client = new QuartixClient(fakeConfig);
    await client.get('/vehicles');
    await client.get('/vehicles');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const authCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/auth'),
    );
    expect(authCalls).toHaveLength(1);
  });
});
