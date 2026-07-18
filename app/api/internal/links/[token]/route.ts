import { deleteTrackingLink, isUuidShaped } from '@/lib/trackingTokens';

// Staff-only (proxy.ts matches /api/internal/:path*).
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params;
    // Malformed tokens never reach Redis, and get the same 404 shape the
    // public track route uses for anything that doesn't resolve to a link.
    if (!isUuidShaped(token)) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    await deleteTrackingLink(token);
    return Response.json({ ok: true });
  } catch (error) {
    console.error('delete-link route failed:', error);
    return Response.json(
      { error: 'Unable to revoke tracking link' },
      { status: 502 },
    );
  }
}
