// Fixed palette for telling routes (and their vehicles/stops) apart on one
// shared map. Not invented hex values: the first three ARE existing design
// tokens from globals.css — the customer accent terracotta (#b23a2e),
// Municipal Blue (#3a6ea5), and the customer-theme live teal (#1f8a7d) — and
// the remaining three are the harmonizing hues TrackMap's multi-vehicle
// highlight rings already established alongside them. TrackMap imports this
// same array, so the two "distinguish things by color" features stay one
// palette.
export const ROUTE_COLORS = [
  '#b23a2e',
  '#3a6ea5',
  '#1f8a7d',
  '#8a5fb0',
  '#c07b1f',
  '#4a7f2c',
] as const;

// Wraparound indexing — never throws, however many routes exist. The double
// modulo keeps even a negative index (e.g. a findIndex miss) in range.
export function getRouteColor(routeIndex: number): string {
  const length = ROUTE_COLORS.length;
  return ROUTE_COLORS[((routeIndex % length) + length) % length];
}
