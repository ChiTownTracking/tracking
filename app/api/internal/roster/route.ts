import { getVehicleRoster } from '@/lib/vehicleRoster';

// Staff-only (proxy.ts matches /api/internal/:path*): feeds the create-link
// form's vehicle picker.
export async function GET() {
  try {
    return Response.json(await getVehicleRoster());
  } catch (error) {
    console.error('roster route failed:', error);
    return Response.json(
      { error: 'Unable to fetch vehicle roster' },
      { status: 502 },
    );
  }
}
