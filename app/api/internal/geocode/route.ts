import { z } from 'zod';
import { googleMapsClient } from '@/lib/googleMapsClient';

// COMPLIANCE: results from this route are Google Maps Content and, per
// Google's Maps Service Specific Terms, must only be displayed on a Google
// Map. Every map in the app renders on Google Maps as of Phase J4 — keep it
// that way: rendering this data on any non-Google map reopens the violation.
//
// Staff-only (proxy.ts matches /api/internal/:path*) — session auth happens
// upstream, no separate check here. Thin pass-through to
// googleMapsClient.geocode: candidates go back exactly as the client returns
// them (label, lat, lng, matchType, confidence, distanceKm — the same
// GeocodeCandidate shape the ORS client produced, swapped in place in J3),
// no re-ranking or filtering — the human in the create-link UI is the one
// who judges match quality.
const geocodeInputSchema = z.object({
  query: z.string().refine((value) => value.trim().length > 0, {
    message: 'query must not be empty',
  }),
});

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = geocodeInputSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: 'query must be a non-empty string' },
        { status: 400 },
      );
    }

    const candidates = await googleMapsClient.geocode(parsed.data.query.trim());
    return Response.json(candidates);
  } catch (error) {
    console.error('geocode route failed:', error);
    return Response.json(
      { error: 'Unable to search addresses' },
      { status: 502 },
    );
  }
}
