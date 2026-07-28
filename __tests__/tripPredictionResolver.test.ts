import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/googleMapsClient', () => ({
  googleMapsClient: { predictArrival: vi.fn() },
}));

// nextOccurrenceOf stays real — turning a clock into a departure Date is
// part of what this function is responsible for getting right.

import { googleMapsClient } from '@/lib/googleMapsClient';
import { resolvePredictionsForClocks } from '@/lib/tripPredictionResolver';

const FIRST = { lat: 41.878988, lng: -87.639732 };
const LAST = { lat: 41.948437, lng: -87.655334 };

// Real values from __fixtures__/googleRoutePredicted.json.
const FRESH = { predictedDurationSeconds: 1061, staticDurationSeconds: 1332 };
// Deliberately different numbers, so a reused prediction can't be confused
// with a freshly fetched one.
const KNOWN = { predictedDurationSeconds: 812, staticDurationSeconds: 995 };

describe('resolvePredictionsForClocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(googleMapsClient.predictArrival).mockResolvedValue(FRESH);
  });

  it('reuses an already-known clock, spending NO Google call', async () => {
    const resolved = await resolvePredictionsForClocks(
      ['07:10'],
      FIRST,
      LAST,
      new Map([['07:10', KNOWN]]),
    );

    expect(googleMapsClient.predictArrival).not.toHaveBeenCalled();
    expect(resolved.get('07:10')).toEqual(KNOWN);
  });

  it('calls Google for an unknown clock, first point to last point direct', async () => {
    const resolved = await resolvePredictionsForClocks(
      ['07:10'],
      FIRST,
      LAST,
      new Map(),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    // Origin/destination only — no intermediates — at a real future Date
    // for that clock's next occurrence.
    expect(googleMapsClient.predictArrival).toHaveBeenCalledWith(
      FIRST,
      LAST,
      expect.any(Date),
    );
    expect(resolved.get('07:10')).toEqual(FRESH);
  });

  it('in one batch, reuses what it knows and fetches only what it does not', async () => {
    const resolved = await resolvePredictionsForClocks(
      ['07:10', '08:30'],
      FIRST,
      LAST,
      new Map([['07:10', KNOWN]]),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    expect(resolved.get('07:10')).toEqual(KNOWN);
    expect(resolved.get('08:30')).toEqual(FRESH);
  });

  it('one clock failing yields null for THAT clock only, never throwing or spoiling the batch', async () => {
    // Calls are issued in the order the clocks are given, so the rejection
    // lands on '07:10' and '08:30' still resolves normally.
    vi.mocked(googleMapsClient.predictArrival)
      .mockRejectedValueOnce(
        new Error('Google request failed (429): quota exceeded'),
      )
      .mockResolvedValue(FRESH);

    const resolved = await resolvePredictionsForClocks(
      ['07:10', '08:30'],
      FIRST,
      LAST,
      new Map(),
    );

    // null = attempted and failed, distinct from an absent key.
    expect(resolved.get('07:10')).toBeNull();
    expect(resolved.has('07:10')).toBe(true);
    expect(resolved.get('08:30')).toEqual(FRESH);
  });

  it('asks once for a clock repeated in the input', async () => {
    const resolved = await resolvePredictionsForClocks(
      ['07:10', '07:10', '07:10'],
      FIRST,
      LAST,
      new Map(),
    );

    expect(googleMapsClient.predictArrival).toHaveBeenCalledTimes(1);
    expect(resolved.get('07:10')).toEqual(FRESH);
  });
});
