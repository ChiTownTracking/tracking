import { describe, expect, it } from 'vitest';
import { getWindowStatus, isWithinWindow } from '@/lib/trackingWindow';

// Explicit `now` arguments — no fake timers needed, and every boundary is
// visible right at the assertion.
const START = '2026-07-20T14:00:00.000Z';
const END = '2026-07-20T18:00:00.000Z';

const atStart = new Date(START);
const secondBeforeStart = new Date('2026-07-20T13:59:59.000Z');
const atEnd = new Date(END);
const secondAfterEnd = new Date('2026-07-20T18:00:01.000Z');

describe('isWithinWindow', () => {
  it('is true exactly at windowStart (inclusive)', () => {
    expect(isWithinWindow(START, END, atStart)).toBe(true);
  });

  it('is false one second before windowStart', () => {
    expect(isWithinWindow(START, END, secondBeforeStart)).toBe(false);
  });

  it('is true exactly at windowEnd (inclusive)', () => {
    expect(isWithinWindow(START, END, atEnd)).toBe(true);
  });

  it('is false one second after windowEnd', () => {
    expect(isWithinWindow(START, END, secondAfterEnd)).toBe(false);
  });
});

describe('getWindowStatus', () => {
  it('is active exactly at windowStart (inclusive)', () => {
    expect(getWindowStatus(START, END, atStart)).toBe('active');
  });

  it('is not_started one second before windowStart', () => {
    expect(getWindowStatus(START, END, secondBeforeStart)).toBe('not_started');
  });

  it('is active exactly at windowEnd (inclusive)', () => {
    expect(getWindowStatus(START, END, atEnd)).toBe('active');
  });

  it('is ended one second after windowEnd', () => {
    expect(getWindowStatus(START, END, secondAfterEnd)).toBe('ended');
  });

  it('is active strictly inside the window', () => {
    expect(getWindowStatus(START, END, new Date('2026-07-20T16:00:00Z'))).toBe(
      'active',
    );
  });
});
