import { describe, expect, it } from 'vitest';
import {
  computeDepartureClock,
  computePredictedArrivalClock,
  computePredictedArrivalRange,
} from '@/lib/departureTime';
import { BUS_DURATION_BUFFER } from '@/lib/tripEstimateConfig';

describe('computeDepartureClock', () => {
  it('adds the wait without wrapping', () => {
    expect(computeDepartureClock('07:00', 30)).toBe('07:30');
  });

  it('wraps exactly to midnight as 00:00, never 24:00', () => {
    expect(computeDepartureClock('23:45', 15)).toBe('00:00');
  });

  it('wraps a multi-hour wait past midnight', () => {
    expect(computeDepartureClock('22:30', 210)).toBe('02:00');
  });
});

describe('computePredictedArrivalClock', () => {
  it('adds the duration without wrapping', () => {
    // 1061s (the real captured prediction) → 18 min.
    expect(computePredictedArrivalClock('12:05', 1061)).toBe('12:23');
  });

  it('wraps past midnight', () => {
    // 1800s = 30 min from 23:45 → 00:15 next day.
    expect(computePredictedArrivalClock('23:45', 1800)).toBe('00:15');
  });

  it('rounds seconds to the NEAREST minute — 90s is +2, not +1', () => {
    expect(computePredictedArrivalClock('07:00', 90)).toBe('07:02');
  });
});

describe('computePredictedArrivalRange', () => {
  it('buffers the real fixture values and orders them — predicted is the SMALLER raw number', () => {
    // Real capture: 1061s predicted / 1332s static. Buffered:
    // 1061 × 1.1 = 1167.1 → 1167s; 1332 × 1.1 = 1465.2 → 1465s (round to
    // the nearest second BEFORE the minute math). From a 12:05 departure:
    // 1167s → +19 min → 12:24 (early, from the smaller PREDICTED value);
    // 1465s → +24 min → 12:29 (late, from the static baseline).
    expect(computePredictedArrivalRange('12:05', 1061, 1332)).toEqual({
      early: '12:24',
      late: '12:29',
    });
  });

  it('derives from the shared BUS_DURATION_BUFFER constant, not an inline copy', () => {
    // Expectations computed FROM the imported constant: retuning
    // tripEstimateConfig.ts must retune this function with it, with no
    // second number to hunt down.
    const expectedEarly = computePredictedArrivalClock(
      '12:05',
      Math.round(1061 * BUS_DURATION_BUFFER),
    );
    const expectedLate = computePredictedArrivalClock(
      '12:05',
      Math.round(1332 * BUS_DURATION_BUFFER),
    );
    expect(computePredictedArrivalRange('12:05', 1061, 1332)).toEqual({
      early: expectedEarly,
      late: expectedLate,
    });
  });

  it('collapses to an equal pair when both durations match', () => {
    // 600 × 1.1 = 660s → +11 min on both ends.
    expect(computePredictedArrivalRange('07:00', 600, 600)).toEqual({
      early: '07:11',
      late: '07:11',
    });
  });
});
