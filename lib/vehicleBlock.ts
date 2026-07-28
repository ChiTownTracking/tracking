// Phase O3: the vehicle-assignment form state, lifted out of the create-trip
// page the moment adding a vehicle to an EXISTING trip became its second
// consumer. Same shape, same validation, same departure math for both —
// a vehicle assignment is edited the same way whichever page you're on.

// One run row as edited: waitMinutes stays a raw string until submit so the
// input never fights the user mid-typing; validation names bad values.
export interface RunRow {
  key: string;
  arrivalTime: string;
  waitMinutes: string;
}

export interface VehicleBlock {
  key: string;
  vehicleId: string | null;
  query: string;
  // Phase N4: optional customer-facing card prefix ("Route A"). Submitted
  // as cardLabel only when non-empty.
  cardLabel: string;
  runs: RunRow[];
}

export function makeRun(): RunRow {
  return { key: crypto.randomUUID(), arrivalTime: '', waitMinutes: '0' };
}

export function makeVehicleBlock(): VehicleBlock {
  return {
    key: crypto.randomUUID(),
    vehicleId: null,
    query: '',
    cardLabel: '',
    runs: [makeRun()],
  };
}

export function parseWaitMinutes(raw: string): number | null {
  if (raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// "07:05" + 25 → "07:30": the computed departure staff see live next to
// their own inputs, so nobody does clock math in their head. Wraps past
// midnight the same way the schedule status logic would read it.
export function computeDeparture(
  arrivalTime: string,
  waitRaw: string,
): string | null {
  const wait = parseWaitMinutes(waitRaw);
  if (!/^\d{2}:\d{2}$/.test(arrivalTime) || wait === null) {
    return null;
  }
  const [hours, minutes] = arrivalTime.split(':').map(Number);
  const total = (hours * 60 + minutes + wait) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(
    total % 60,
  ).padStart(2, '0')}`;
}

// Client-side mirror of one vehicle's slice of the server schema. First
// problem wins — one clear, named message at a time; never a silently
// disabled button. `position` names which block is at fault ("Vehicle 2")
// on a form that has several.
export function findVehicleBlockBlocker(
  block: VehicleBlock,
  position: string,
): string | null {
  if (block.vehicleId === null) {
    return `${position} needs a vehicle selected.`;
  }
  if (block.runs.length === 0) {
    return `${position} needs at least one departure time.`;
  }
  if (block.runs.some((run) => run.arrivalTime.trim() === '')) {
    return `${position}: every arrival time needs a value (or remove the empty row).`;
  }
  if (block.runs.some((run) => parseWaitMinutes(run.waitMinutes) === null)) {
    return `${position}: wait minutes must be a whole number of 0 or more.`;
  }
  return null;
}

// The block as the API wants it — identical for POST /trips (nested per
// vehicle) and POST /trips/[id]/vehicles (one on its own), because both
// validate through the same vehicleAssignmentInputSchema.
export function toVehiclePayload(block: VehicleBlock): {
  vehicleId: string | null;
  cardLabel?: string;
  schedule: { arrivalTime: string; waitMinutes: number }[];
} {
  return {
    vehicleId: block.vehicleId,
    // Only send a card label when the staff actually typed one.
    ...(block.cardLabel.trim() !== ''
      ? { cardLabel: block.cardLabel.trim() }
      : {}),
    schedule: block.runs.map((run) => ({
      arrivalTime: run.arrivalTime,
      waitMinutes: parseWaitMinutes(run.waitMinutes) ?? 0,
    })),
  };
}
