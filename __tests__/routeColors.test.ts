import { describe, expect, it } from 'vitest';
import { getRouteColor, ROUTE_COLORS } from '@/lib/routeColors';

describe('getRouteColor', () => {
  it('returns the same color for the same index every time', () => {
    expect(getRouteColor(2)).toBe(getRouteColor(2));
    expect(getRouteColor(0)).toBe(ROUTE_COLORS[0]);
  });

  it('returns distinct colors for distinct indices within the palette', () => {
    const colors = Array.from({ length: ROUTE_COLORS.length }, (_, index) =>
      getRouteColor(index),
    );
    expect(new Set(colors).size).toBe(ROUTE_COLORS.length);
  });

  it('wraps around past the palette length instead of throwing', () => {
    expect(getRouteColor(ROUTE_COLORS.length)).toBe(getRouteColor(0));
    expect(getRouteColor(ROUTE_COLORS.length * 3 + 1)).toBe(getRouteColor(1));
  });

  it('stays in range even for a negative index (a findIndex miss)', () => {
    expect(ROUTE_COLORS).toContain(getRouteColor(-1));
  });
});
