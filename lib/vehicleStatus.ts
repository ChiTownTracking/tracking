const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIVE_THRESHOLD_MS = 2 * MINUTE_MS;
const STALE_THRESHOLD_MS = 24 * HOUR_MS;

export function isVehicleLive(lastUpdatedAt: string): boolean {
  const diffMs = Date.now() - new Date(lastUpdatedAt).getTime();
  return diffMs < LIVE_THRESHOLD_MS;
}

export function formatRelativeTime(dateString: string): string {
  const diffMs = Date.now() - new Date(dateString).getTime();
  // Clock skew can put the timestamp slightly in the future — never show a
  // negative age.
  if (diffMs < 0) {
    return 'just now';
  }
  const seconds = Math.floor(diffMs / SECOND_MS);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(diffMs / MINUTE_MS);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(diffMs / HOUR_MS);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  if (days < 7) {
    return `${days}d ago`;
  }
  // Beyond a week, a real date reads better than a large, alarming number.
  const date = new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `on ${date}`;
}

export function getStatusLabel(speed: number, lastUpdatedAt: string): string {
  const diffMs = Date.now() - new Date(lastUpdatedAt).getTime();
  // A stale position with a nonzero speed is not "en route" — the speed is
  // just as stale as the position.
  if (diffMs > STALE_THRESHOLD_MS) {
    return 'No recent signal';
  }
  return speed > 2 ? 'En route' : 'Stopped';
}
