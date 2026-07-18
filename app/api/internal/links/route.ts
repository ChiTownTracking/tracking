import { listTrackingLinks } from '@/lib/trackingTokens';

// Staff-only (proxy.ts matches /api/internal/:path*).
export async function GET() {
  try {
    return Response.json(await listTrackingLinks());
  } catch (error) {
    console.error('links route failed:', error);
    return Response.json(
      { error: 'Unable to list tracking links' },
      { status: 502 },
    );
  }
}
