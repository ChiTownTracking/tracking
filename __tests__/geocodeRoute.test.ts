import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeocodeCandidate } from '@/lib/orsClient';

// Phase J3: the route now calls googleMapsClient — same GeocodeCandidate
// shape, new mock target.
vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: { geocode: vi.fn() },
}));

import { POST } from '@/app/api/internal/geocode/route';
import { googleMapsClient } from '@/lib/googleMapsClient';

// Auth is NOT tested here on purpose: this route lives under /api/internal/,
// whose session gate is proxy.ts's matcher — already covered by
// __tests__/proxy.test.ts for the whole path prefix.

const CANDIDATES: GeocodeCandidate[] = [
  {
    label: 'Chicago Union Station, West Side, Chicago, IL, USA',
    lat: 41.878988,
    lng: -87.639732,
    matchType: 'exact',
    confidence: 1,
    distanceKm: 0.829,
  },
  {
    label: '2600 Navy Boulevard, Glenview, IL, USA',
    lat: 42.089919,
    lng: -87.823623,
    matchType: 'fallback',
    confidence: 0.8,
    distanceKm: 28.517,
  },
];

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/internal/geocode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/internal/geocode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a mocked candidate list through unchanged — order, fields, fallback flags intact', async () => {
    vi.mocked(googleMapsClient.geocode).mockResolvedValue(CANDIDATES);

    const response = await POST(makeRequest({ query: 'Union Station' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CANDIDATES);
    expect(googleMapsClient.geocode).toHaveBeenCalledWith('Union Station');
  });

  // The J3 swap-transparency proof: candidates shaped exactly the way the
  // REAL GoogleMapsClient derives them (values from the real Union Station
  // capture — 'match'/'fallback' at fixed 0.6 confidence, haversine
  // distanceKm) flow through this route byte-identical, same as ORS-shaped
  // ones always did. Same shape in, same shape out — nothing above the
  // client needed to change.
  it('passes Google-derived candidates through unchanged after the J3 swap', async () => {
    const googleDerived: GeocodeCandidate[] = [
      {
        label: 'Chicago Union Station',
        lat: 41.8786902,
        lng: -87.640312,
        matchType: 'match',
        confidence: 0.6,
        distanceKm: 0.873,
      },
      {
        label: 'Union Station',
        lat: 41.8786738,
        lng: -87.6403334,
        matchType: 'fallback',
        confidence: 0.6,
        distanceKm: 0.874,
      },
    ];
    vi.mocked(googleMapsClient.geocode).mockResolvedValue(googleDerived);

    const response = await POST(makeRequest({ query: 'Union Station' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(googleDerived);
  });

  it('trims the query before geocoding', async () => {
    vi.mocked(googleMapsClient.geocode).mockResolvedValue([]);

    await POST(makeRequest({ query: '  Navy Pier  ' }));

    expect(googleMapsClient.geocode).toHaveBeenCalledWith('Navy Pier');
  });

  it.each([
    ['missing query', {}],
    ['empty query', { query: '' }],
    ['whitespace-only query', { query: '   ' }],
    ['non-string query', { query: 42 }],
    ['malformed JSON', '{not json'],
  ])('rejects %s with 400 without calling the geocoder', async (_label, body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'query must be a non-empty string',
    });
    expect(googleMapsClient.geocode).not.toHaveBeenCalled();
  });

  it('returns a generic 502 when the geocode call fails', async () => {
    vi.mocked(googleMapsClient.geocode).mockRejectedValue(
      new Error('Google request failed (403): quota exceeded'),
    );

    const response = await POST(makeRequest({ query: 'Union Station' }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'Unable to search addresses',
    });
  });
});
