// Google's Routes API has no bus/heavy-vehicle travel mode — DRIVE models a
// standard passenger car. This is a manual placeholder buffer, not sourced
// data, chosen because a real bus-vs-car comparison doesn't exist yet. Once
// real trips have run, compare actual arrival times against Google's
// predictions and adjust this number based on real observed data, not
// guesswork.
//
// Deliberately its own tiny file: the single obvious place to find and tune
// this later.
export const BUS_DURATION_BUFFER = 1.1; // 10% starting estimate
