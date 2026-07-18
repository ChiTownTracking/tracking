// SWR fetcher shared by TrackMap and the bare track page. Both can subscribe
// to the same key (/api/track/[token]), so they must resolve and reject
// identically — if one fetcher swallowed a 404 as data, the shared cache
// entry's meaning would depend on which subscriber happened to fetch it.
export async function trackFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      res.status === 404 ? 'not_found' : `request failed (${res.status})`,
    );
  }
  return res.json();
}
