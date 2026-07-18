// Client-side counterpart to proxy.ts's 401 JSON responses: when the 12-hour
// server-side session TTL expires while a dashboard tab is still open (the
// cookie itself only clears on browser close), every /api/internal/* fetch
// starts returning 401 — send the browser back to the login screen instead of
// letting the tab silently error forever.
export function redirectIfSessionExpired(status: number): boolean {
  if (status !== 401) {
    return false;
  }
  window.location.assign('/');
  return true;
}
