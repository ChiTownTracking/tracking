// "HH:mm" (24-hour, the storage format) → "2:30 PM" — THE 12-hour rendering
// every schedule display uses (Phase K2: extracted from ScheduleTimeline's
// private formatDeparture the moment a second and third consumer appeared).
// Sibling of boardStatus.formatBoardTime, which does the same for ISO
// timestamps instead of stored clocks.
export function formatClock12Hour(clock: string): string {
  const [hours, minutes] = clock.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}
