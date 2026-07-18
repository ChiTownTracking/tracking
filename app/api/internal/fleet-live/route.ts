import { getTrackedVehicleIds } from '@/lib/appEnv';
import { getLiveVehicles } from '@/lib/liveVehicles';

// Auth is handled upstream by proxy.ts (/api/internal/:path* matcher);
// this handler only fetches and shapes data.
export async function GET() {
  try {
    const ids = getTrackedVehicleIds();
    const vehicles = await getLiveVehicles(ids);
    return Response.json(vehicles);
  } catch (error) {
    // Log the real failure server-side only — the response body must never
    // carry the actual error or stack.
    console.error('fleet-live route failed:', error);
    return Response.json(
      { error: 'Unable to fetch fleet data' },
      { status: 502 },
    );
  }
}
