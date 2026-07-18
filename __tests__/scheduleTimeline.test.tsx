// @vitest-environment happy-dom
//
// ScheduleTimeline is presentational, but it earned this test: with the
// React Compiler's auto-memoization, an earlier version served stale chip
// statuses because the status computation's inputs never changed on the
// 30-second render tick — silently wrong information for a customer, a
// different risk category than a layout glitch. This locks the mechanism:
// status must advance purely by time passing, with NO prop or data change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ScheduleTimeline from '@/components/ScheduleTimeline';

declare global {
  // Required by React 19 for act() outside a test-framework preset.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('ScheduleTimeline live status updates', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Fake timers fake Date too — advanceTimersByTime moves the clock the
    // component reads via new Date().
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('flips a chip from in-progress to completed purely by time passing', () => {
    // 20:29:50Z = 15:29:50 Chicago (CDT): ten seconds before the end of a
    // 14:30 departure with a 3600s duration (ends 15:30 Chicago).
    vi.setSystemTime(new Date('2026-07-16T20:29:50Z'));

    act(() => {
      root.render(
        <ScheduleTimeline schedule={['14:30']} durationSeconds={3600} />,
      );
    });

    const chip = () => container.querySelector('li');
    expect(chip()?.getAttribute('title')).toBe('in-progress');

    // One 30-second tick: the fake clock lands at 20:30:20Z — past the
    // boundary. Same props, same data; only time moved.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(chip()?.getAttribute('title')).toBe('completed');
    expect(chip()?.querySelector('.line-through')).not.toBeNull();
  });
});
