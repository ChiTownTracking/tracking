# ChiTown Fleet Tracking (v2)

A from-scratch rebuild of ChiTown Trolley's live fleet-tracking app: a staff
dispatch dashboard showing every vehicle's live position from Quartix, and
customer-facing tracking links that show a subset of vehicles for a booked
event window. This rebuild exists to fix the fallback/silent-default anti-pattern
in the original app's env and API-response handling — config and upstream data
should fail loudly when they're wrong, not quietly degrade.

> **Editor's note on this README:** this project was scaffolded from a task
> that asked for an "architecture layer table" and a "Known Quartix API
> Quirks" section copied verbatim from a project spec (§4 and §2
> respectively). No such spec document could be found anywhere on this
> machine — I searched this and sibling project directories and came up
> empty. Rather than block the whole scaffold on that, the two sections
> below are my own write-up, built from facts actually verified against the
> live Quartix API during this project's earlier development (not
> guessed). If you have the real spec, share it and these sections should be
> replaced with the authoritative text.

## Architecture

Each layer only knows about the one below it — components never see raw
Quartix fields, and API routes never see Quartix's actual field casing.

| Layer | Responsibility | Where |
|---|---|---|
| Env validation | Fail loudly on missing/malformed config — no fallback, no silent default | `lib/env.ts` |
| External API client | Auth + raw HTTP calls to Quartix | `lib/quartix.ts` (added when Phase 1 needs it) |
| Normalization | Map Quartix's raw, inconsistently-documented fields into a stable internal shape; caching lives here | `lib/*.ts` (added as each phase needs it) |
| API routes | Thin HTTP boundary over the lib functions; this is also the auth boundary | `app/api/**/route.ts` |
| Components | Render already-normalized data; no knowledge of Quartix's raw shape | `components/**.tsx`, `app/**/page.tsx` |

Phase 0 (this commit) only proves the env-validation mechanism (`lib/env.ts`)
and locks in one real API fact as an executable test
(`__tests__/fixtures.test.ts`). Nothing here is wired to real Quartix or Redis
credentials yet.

## Known Quartix API Quirks

Verified directly against the live Quartix API — not from Quartix's own
documentation, which is wrong or silent on all three of these:

- **`VehicleId` casing.** Both `/vehicles` and `/vehicles/live` return the
  field as `VehicleId` (lowercase "d"), not `VehicleID`. This was confirmed
  by fetching both endpoints directly and inspecting the raw JSON keys — an
  earlier, unverified assumption that the two endpoints used different
  casing turned out to be wrong and caused a real bug (every row collided on
  the same `undefined` React key). Treat any claim about this field's
  casing as unverified until checked against a live response.
- **`LastEventDateTime` casing.** The live-position endpoint's timestamp
  field is `LastEventDateTime` (capital "D" in "Date"), not
  `LastEventDatetime`. Silently wrong for a while because the bug didn't
  throw — it just rendered "Invalid Date" everywhere a last-update time was
  shown.
- **`LocationText` is a full sentence, not a short place name.** A real
  value looks like `"Stationary with Ignition OFF at 1265 Oakton St, Elk
  Grove Village, Illinois 60007 since May 18 2026 1:32:05 PM CDT."` — not
  something short like "Near Elgin, IL". Any UI treating this field as a
  compact label (e.g. a heading) needs to handle long strings gracefully;
  don't assume brevity without checking a real response.

## Development

```bash
npm run dev          # start the dev server
npm run test          # run the test suite once (vitest run)
npm run test:watch    # run tests in watch mode
npm run build          # production build
npm run lint            # eslint
```

## Getting Started (from create-next-app)

Open [http://localhost:3000](http://localhost:3000) after `npm run dev` to see
the result. This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts)
to load Space Grotesk, Inter, and IBM Plex Mono for the staff dispatch theme,
and Fraunces (plus reused Inter) for the customer-facing theme.
