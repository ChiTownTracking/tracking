import { describe, expect, it } from 'vitest';
import { boardStatusLine } from '@/lib/boardStatus';

// THE regression test for the G2 status-line fix: the one bug found in the
// stop-timing audit lived here, not in the chip JSX — a live position with a
// null stopEtas (estimate unavailable) was reported as "At the final stop".
describe('boardStatusLine', () => {
  it('distinguishes "estimate unavailable" from "at the final stop" for a live vehicle', () => {
    const now = new Date('2026-07-17T15:00:00.000Z');
    const stopLabels = ['Union Station', 'Wrigley Field'];
    const position = { lat: 41.9, lng: -87.65 };

    // Live position, degraded estimate: must NOT claim the trip finished.
    expect(
      boardStatusLine(
        { position, nextStopIndex: null, stopEtas: null },
        stopLabels,
        now,
      ),
    ).toBe('Live position shown — arrival times unavailable');

    // Genuinely at the final stop: estimate present, all stops passed.
    expect(
      boardStatusLine(
        {
          position,
          nextStopIndex: null,
          stopEtas: [
            { arrival: null, departure: null },
            { arrival: null, departure: null },
          ],
        },
        stopLabels,
        now,
      ),
    ).toBe('At the final stop');

    // The other branches keep their meanings: dark vehicle, en-route with a
    // future arrival, and the dwell window (arrival passed, departure not).
    expect(
      boardStatusLine(
        { position: null, nextStopIndex: null, stopEtas: null },
        stopLabels,
        now,
      ),
    ).toBe('Position unavailable');
    expect(
      boardStatusLine(
        {
          position,
          nextStopIndex: 1,
          stopEtas: [
            { arrival: null, departure: null },
            {
              arrival: '2026-07-17T15:14:00.000Z',
              departure: '2026-07-17T15:19:00.000Z',
            },
          ],
        },
        stopLabels,
        now,
      ),
    ).toMatch(/^En route to Wrigley Field · arriving /);
    expect(
      boardStatusLine(
        {
          position,
          nextStopIndex: 1,
          stopEtas: [
            { arrival: null, departure: null },
            {
              arrival: '2026-07-17T14:58:00.000Z',
              departure: '2026-07-17T15:03:00.000Z',
            },
          ],
        },
        stopLabels,
        now,
      ),
    ).toMatch(/^At Wrigley Field · departs /);
  });
});
