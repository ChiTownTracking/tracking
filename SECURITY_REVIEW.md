# Phase 6 Security Review — chitown-fleet-tracking-v2

Reviewed 2026-07-15 against the working tree as it stands (one git commit,
`2e9f17f`, everything since uncommitted). Every item below was verified
against the actual current code and build output — not against prior
conversation claims. No code was changed as part of this review.

---

## §3 threat model — "must never happen" list

### 1. Quartix credentials never reach the browser

Checked three ways against the current production build (`.next/static`):

- Marker strings `QUARTIX`, `CustomerID`, `UPSTASH`, `DASHBOARD_USER`,
  `DASHBOARD_PASS`: **0 client-bundle files** contain any of them.
- The **actual secret values** from `.env.local` (every non-empty value,
  checked programmatically without printing them): **0 client-bundle files**
  contain any value.
- One chunk (`.next/static/chunks/0cz1d0mv5g_q7.js`) contains
  `x-www-form-urlencoded`; inspected — it is a `fetch` polyfill inside a
  framework chunk with zero Quartix references, not our client code.

Structurally: every client component imports server types with
`import type` only (erased at compile time), and the only `process.env`
reads in the codebase are in `lib/quartixClient.ts:129`, `lib/appEnv.ts:14`,
`lib/dashboardAuthEnv.ts:16`, `lib/trackingTokens.ts:19` — all server-side
lib modules.

**Verdict: PASS**

### 2. A tracking link can never reveal a vehicle not granted to that token

The good half: the server derives the vehicle list exclusively from the
Redis-stored link (`app/api/track/[token]/route.ts` → `getTrackingLink` →
`getLiveVehicles(link.vehicleIds)`). The client cannot influence which IDs
are requested.

The gap: **the response is never filtered back against the granted IDs.**
`lib/liveVehicles.ts:54` maps *every* entry Quartix returns, and lines
57–65 deliberately *include* vehicles with no roster match (empty
registration/description, `console.warn`) rather than dropping them — a
sensible choice for the staff dashboard, but on the public endpoint it
means the guarantee rests entirely on Quartix honoring the `VehicleIDList`
request parameter. If Quartix ever ignores that parameter, partially
matches it, or errors into returning the full fleet, those positions flow
straight to the customer. A "must never happen" item needs to be enforced
in our code, not delegated to upstream behavior.

Fix (later, not applied now): in `app/api/track/[token]/route.ts`, filter
the `getLiveVehicles` result to `new Set(link.vehicleIds)` before
responding. One line; does not touch protected Phase 0–3 files.

**Verdict: FAIL** (no local enforcement; currently safe only if upstream
behaves)

### 3. A tracking link can never work outside its window

- Boundary logic in `lib/trackingWindow.ts:11–12` (`>=` start, `<=` end —
  inclusive both ends) and `:22–25` (strict `<` / `>` for
  not_started/ended). Tested at *exactly* the boundaries plus one second
  either side, for both functions
  (`__tests__/trackingWindow.test.ts`, 9 tests).
- The route gates before any Quartix call:
  `app/api/track/[token]/route.ts:30–43` returns `{ status, message }` for
  `not_started`/`ended` without fetching positions; only `active` reaches
  `getLiveVehicles`.
- Status is computed fresh on every request (no cached verdict), and a
  revoked/unknown token 404s before any window check.

**Verdict: PASS**

### 4. Staff dashboard unreachable without credentials

`proxy.ts:27` — `matcher: ['/dashboard/:path*', '/api/internal/:path*']`.
Next's path-to-regexp `:path*` means *zero or more* segments, so
`/dashboard` itself, `/dashboard/create-link`, and `/dashboard/links` are
all matched (all three pages exist; confirmed against the route list in the
current build). Auth is enforced by `proxy.ts:6–24` →
`evaluateDashboardAccess`, which returns 401 + `WWW-Authenticate` for
anything without valid credentials.

Informational, not a failure: the pages' static JS/CSS chunks under
`/_next/static/` are not behind the matcher (standard for middleware-based
auth). Item 1 confirms those chunks contain no secrets and no data — all
fleet data arrives via the protected `/api/internal/*` calls.

**Verdict: PASS**

### 5. No internal-only API route reachable unauthenticated

Complete enumeration of `app/api/internal/**/route.ts` in the current tree:

| Route | Covered by `/api/internal/:path*`? |
|---|---|
| `/api/internal/fleet-live` | yes |
| `/api/internal/roster` | yes |
| `/api/internal/create-link` | yes |
| `/api/internal/links` | yes |
| `/api/internal/links/[token]` | yes (nested segments; `*` = zero or more) |

The only other API route, `/api/track/[token]`, is public **by design**
(token-gated customer endpoint) and sits outside the matcher deliberately.

**Verdict: PASS**

### 6. No secrets committed to git

- `.gitignore` contains `.env*` (line: "# env files … `.env*`") — covers
  `.env.local`.
- `git log --all -- '.env*'` → empty; `git ls-files | grep -i env` → empty
  (never tracked, not even in the initial commit).
- History grep for `QUARTIX_`/`UPSTASH_`/`DASHBOARD_PASS` across all
  commits → no hits. History is a single create-next-app commit.
- `git remote -v` → **no remotes**; this repo has never been pushed.

Observation (outside git's scope): the project lives inside a OneDrive
folder, so `.env.local` — real credentials included — is being synced to
Microsoft's cloud right now. Worth a deliberate decision (exclude the
folder from sync, or accept it).

**Verdict: PASS**

### 7. No unhandled error leaks internals to a client

Every route's catch block checked (all six, not a sample). Each follows the
same pattern — `console.error('<route> failed:', error)` server-side, then
a fixed generic body:

| Route | Failure response |
|---|---|
| fleet-live | `{ error: 'Unable to fetch fleet data' }` 502 |
| roster | `{ error: 'Unable to fetch vehicle roster' }` 502 |
| create-link | `{ error: 'Unable to create tracking link' }` 502 |
| links | `{ error: 'Unable to list tracking links' }` 502 |
| links/[token] | `{ error: 'Unable to revoke tracking link' }` 502 |
| track/[token] | `{ error: 'Unable to fetch tracking data' }` 502 |

Missing-env failures (lazy `parseEnv` throws) occur *inside* these
try/catches, so they surface as the same generic 502s. create-link's 400
responses echo zod validation messages (field path + message) — intended
user feedback, no stack traces/paths/internals. An exception thrown inside
`proxy.ts` itself (e.g. `DASHBOARD_USER` unset) produces Next's generic
production 500 page, which does not include stack traces in prod.

**Verdict: PASS**

---

## §5 security controls

### 8. Timing-safe comparison for the staff password check

`lib/dashboardAuth.ts:36–38`: both username and password go through
`timingSafeStringEqual` into independent locals *before* combining
(`userOk && passOk`), so the username result doesn't short-circuit away the
password comparison. `lib/timingSafeCompare.ts` hashes both inputs
(sha256 → fixed 32 bytes) before `crypto.timingSafeEqual`, avoiding the
throw-on-length-mismatch bug (explicitly tested). Grep for `===` across
auth code found only `colonIndex === -1` (header parsing) — no plain
equality on any secret anywhere in `app/`, `lib/`, `components/`, or
`proxy.ts`.

**Verdict: PASS**

### 9. Rate limiting on staff login and /api/track/[token] — in-memory vs Redis

Both limiters exist and are wired correctly at the single-instance level:

- Staff: `lib/rateLimiter.ts:29` (`dashboardLoginLimiter`, 5/60s), consumed
  via `lib/dashboardGate.ts:23`, which counts **only failed** attempts
  (line 19 returns `allowed` before touching the limiter).
- Public tracking: `app/api/track/[token]/route.ts:12`
  (`trackingLimiter`, 30/60s per IP).

**Both are in-memory** (`lib/rateLimiter.ts:2` — a per-process
`Map<string, number[]>`). This is definitive: no Redis backing.

What that means on Vercel's serverless model:

- Each lambda/edge instance holds its own `Map`. Vercel scales to many
  concurrent instances and multiple regions, so an attacker's effective
  budget is *N × limit* where N is however many instances their traffic
  fans out across — and they partially control N by spraying requests.
- Cold starts reset counters to zero; idle instances are recycled
  constantly, so windows rarely survive even 60s under low traffic.
- The middleware (proxy) and the track route run in *different* processes,
  so their counters were never shared to begin with.
- Minor: keys are never evicted, so per-instance memory grows with
  distinct-IP churn — bounded in practice only by instance recycling.

Consequences, honestly assessed: for the **staff login**, rate limiting is
a secondary control — the primary defenses (timing-safe compare + a strong
password) remain fully intact, but the "5 attempts per minute" brake is
best-effort-per-instance, not a real global cap. For **/api/track**, the
limiter was explicitly scoped as a cost/abuse cap, not an access control
(tokens are 122-bit UUIDs; guessing is computationally infeasible
regardless), so the degradation is a cost concern, not a security one.

Since Upstash Redis is already a dependency, `@upstash/ratelimit` (or a
hand-rolled INCR/EXPIRE) would make both limits globally correct with
little code.

**Verdict: FAIL** as a distributed control (works as designed on a single
long-lived process; does not deliver its stated limits on serverless)

### 10. Zod validation + roster check at link creation

- `app/api/internal/create-link/route.ts` parses the body with
  `createLinkInputSchema.safeParse` (non-empty vehicleIds array, non-empty
  customerName, ISO datetimes, `windowEnd > windowStart` refine), returns a
  clean `{ error: string }` 400 built from issue paths+messages (no raw zod
  internals), **and** independently verifies every submitted vehicleId
  against `getVehicleRoster()`'s live result, rejecting unknowns with 400.
  This is the only route that accepts a request body.
- Caveat: the `[token]` **path params** on `links/[token]` (DELETE) and
  `track/[token]` (GET) are not zod-validated. They are used solely as
  opaque Redis key lookups (unknown token → `null` → 404; the Upstash REST
  client takes keys as data, no injection surface), so this is safe — but
  a strict reading of "every route validates input via zod" isn't met. A
  cheap hardening: validate UUID shape and short-circuit garbage tokens
  before the Redis round-trip.

**Verdict: PASS** (with the path-param caveat noted above)

### 11. Missing required env vars fail loudly — all four modules

All four env-dependent modules funnel through `parseEnv` → `schema.parse`,
which **throws** on missing keys, and every field is `z.string().min(1)`,
so empty strings also fail. Verified each first-use site:

| Module | Parse site | First-use failure surface |
|---|---|---|
| quartixEnv | `lib/quartixClient.ts:129` (lazy singleton) | any Quartix call → throw → generic 502 |
| appEnv | `lib/appEnv.ts:14` (`getTrackedVehicleIds`) | fleet-live / track routes → 502 |
| dashboardAuthEnv | `lib/dashboardAuthEnv.ts:16` | every dashboard request → 500 (nobody gets in) |
| redisEnv | `lib/trackingTokens.ts:19` (`getRedis`) | any link operation → 502 |

The complete `process.env` grep (item 1) confirms there are no other env
reads — so no path exists where a missing var silently defaults. Notably,
the dashboardAuthEnv failure mode is *closed* (500 for everyone), not
*open*.

**Verdict: PASS**

### 12. No NEXT_PUBLIC_ variable holds anything secret

`grep -rn NEXT_PUBLIC` across the entire codebase (excluding
`node_modules`/`.next`): **zero matches**. The project defines no
NEXT_PUBLIC variables at all; nothing to list.

**Verdict: PASS**

### 13. Every API route returns generic `{ error: string }`, logs detail server-side

Covered route-by-route in item 7 (all six routes — full check, not a
sample): every catch logs via `console.error` and returns a fixed
`{ error: '<generic>' }`. The two non-generic error surfaces are both
intentional and internal-free: create-link's 400 validation messages, and
`proxy.ts`'s plain-text `Auth required` / `Too many attempts` responses.

**Verdict: PASS**

### 14. npm audit

Real output (2026-07-15):

```
# npm audit report

postcss  <8.5.10
Severity: moderate
PostCSS has XSS via Unescaped </style> in its CSS Stringify Output - https://github.com/advisories/GHSA-qx2v-qp2m-jg93
fix available via `npm audit fix --force`
Will install next@9.3.3, which is a breaking change
node_modules/next/node_modules/postcss
  next  9.3.4-canary.0 - 16.3.0-canary.5
  Depends on vulnerable versions of postcss

2 moderate severity vulnerabilities
```

Assessment: **not exploitable here.** The flagged postcss is Next.js's own
vendored copy, used at *build time* to process CSS we author ourselves
(Tailwind pipeline). The advisory concerns emitting untrusted CSS through
postcss's stringifier into HTML; this app never feeds user-controlled CSS
into any build or runtime CSS pipeline. The suggested "fix"
(downgrading to `next@9.3.3`) is npm-audit resolver noise and must not be
applied. Action: none now; pick up the fix when Next ships a release
bundling postcss ≥ 8.5.10.

**Verdict: PASS** (2 moderate findings, both assessed non-exploitable;
suggested auto-fix rejected as a breaking false path)

---

## Build-history follow-up

### 15. Original spec doc §2 field-name table staleness

The "original spec doc" **does not exist in this repository** — and
README.md:10–19 records that it couldn't be found anywhere on this machine
when the README was scaffolded; its "Known Quartix API Quirks" section is
an independent write-up. That in-repo write-up is **correct** against the
real fixtures: README.md:44–55 states `VehicleId` (both endpoints) and
`LastEventDateTime`, matching `__fixtures__/vehicles.json` and
`__fixtures__/vehiclesLive.json` byte-for-byte, and both facts are locked
in as executable tests (`__tests__/fixtures.test.ts`).

So: if the external spec's §2 table says `VehicleID` for `/vehicles/live`,
it is stale relative to the verified fixtures and needs a doc-only fix —
but the document itself isn't available here to confirm or correct.
Nothing in-repo is stale.

**Verdict: UNCLEAR** (the doc to check is absent; all in-repo documentation
verified accurate)

---

## Prioritized findings (everything that isn't a clean PASS)

1. **[HIGH] Item 2 — track endpoint doesn't enforce the granted-vehicle
   set locally.** Filter the `getLiveVehicles` result to `link.vehicleIds`
   inside `app/api/track/[token]/route.ts` (one line, no protected files
   touched). Until then the "never reveal an ungranted vehicle" guarantee
   is delegated to Quartix honoring `VehicleIDList`.
2. **[MEDIUM] Item 9 — in-memory rate limiting is per-instance on
   serverless.** Both limits (staff 5/min, track 30/min) multiply by
   instance count and reset on cold starts. Move both to Upstash
   (`@upstash/ratelimit`) — the Redis dependency already exists. Staff
   auth remains strong without it; the track-route cost cap is the weaker
   spot.
3. **[LOW] Item 10 caveat — `[token]` path params aren't zod-validated.**
   Safe as used (opaque Redis lookups), but validating UUID shape in
   `track/[token]` and `links/[token]` would skip pointless Redis
   round-trips and satisfy the "all input via zod" rule literally.
4. **[DOC-ONLY] Item 15 — external spec §2 table.** If/when the original
   spec doc is located, correct its `/vehicles/live` field casing to
   `VehicleId` / `LastEventDateTime` per the verified fixtures. In-repo
   docs are already accurate.
5. **[OBSERVATION] `.env.local` syncs to OneDrive** (repo lives inside a
   OneDrive folder) — real Quartix/Upstash/dashboard credentials are in
   Microsoft cloud sync. Decide deliberately whether that's acceptable.
6. **[OBSERVATION] Nearly all work is uncommitted** — a single
   create-next-app commit exists; the entire application is sitting
   unversioned in the working tree (also the reason item 6 was easy to
   pass). Worth committing (secrets stay excluded via `.gitignore`).

---

# Extension Review — 2026-07-18

Extends the Phase 6 review above after the ORS→Google migration (J1–J4),
traffic prediction (K1+), the trip surface (`/api/public/trip/[token]`),
and the first push to the public GitHub remote
(`github.com/ChiTownTracking/tracking`, single commit `a7af510`). Every
item below was verified against the actual current code, tests, git
metadata, and production client bundles — not against build summaries. No
code was changed as part of this review; findings are report-only.

Status changes to Phase 6 findings, verified in current code:

- **Phase 6 item 2 (FAIL → resolved):** `app/api/track/[token]/route.ts:56–63`
  now filters `getLiveVehicles`' result against `new Set(link.vehicleIds)`
  before responding — the granted-vehicle set is enforced locally, exactly
  the fix the original review specified. The trip surface achieves the same
  effect structurally (`lib/tripDetail.ts` looks vehicles up from a map
  keyed only by the trip's own assigned IDs; upstream extras are ignored).
- **Phase 6 item 9 (FAIL → resolved):** `lib/rateLimiter.ts` is now a
  Redis-backed `@upstash/ratelimit` sliding window (`RedisRateLimiter`),
  not the per-process in-memory Map. Limits now hold across serverless
  instances.
- **Phase 6 item 10 caveat (resolved):** `[token]` path params are now
  shape-gated (`isUuidShaped`) before any Redis lookup on every token
  route, including the internal DELETE.
- **Phase 6 observation 5 (no longer applicable):** the repo now lives at
  `c:\Dev\`, not inside a OneDrive-synced folder.
- **Auth architecture changed since Phase 6:** Basic-Auth-in-proxy was
  replaced by session cookies (`/api/login` → Redis-backed session, cookie
  `httpOnly` + `secure` in prod + `sameSite: lax`; `proxy.ts` validates the
  session). The underlying credential check and rate-limit ordering are
  unchanged — see item 30.

## A. Public API surface — /api/public/trip/[token]

### 16. Token shape gate before Redis, uniform 404s

- `app/api/public/trip/[token]/route.ts:40–46`: `isUuidShaped(token)` runs
  before `getTripByToken`; both the malformed and the
  well-formed-but-unknown paths return the same
  `{ error: 'Not found' }` 404. A real test
  (`__tests__/tripTokenRoute.test.ts:152–164`) asserts body equality
  between the two AND that the store was consulted exactly once (i.e. the
  shape gate short-circuited the malformed request).
- Informational: the two 404 paths differ in timing (the unknown-token
  path performs two Redis reads — token index then trip). That
  distinguishes "wrong shape" from "wrong token" to a timing observer, but
  reveals nothing useful: shape is already publicly known (UUID), and the
  122-bit token space makes enumeration infeasible regardless.

**Verdict: PASS**

### 17. Rate limiting actually wired

`RedisRateLimiter(30, 60, 'ratelimit:trip')` at
`app/api/public/trip/[token]/route.ts:14`, checked before params are even
read; 429 carries `Retry-After`. The 429 path is exercised by a real test
(`tripTokenRoute.test.ts:200–215`) which asserts the status, the
`Retry-After` header value, that the store was never touched, the 30/60s
window, and the `ratelimit:trip` prefix specifically.

**Verdict: PASS**

### 18. Response shape — minimal disclosure

Complete field enumeration from `lib/tripDetail.ts` (the route returns
`buildTripDetailResponse` verbatim):

- `trip`: `id`, `name`, `geometry`, `stops[{label,lat,lng}]`,
  `totalDistanceMeters`, `totalDurationSeconds` — no `token` (tested).
- `vehicles[]`: `vehicleId`, `vehicleLabel`, `position{lat,lng,headingDegrees}`,
  `positionConfident`, `positionUpdatedAt`, `speedMph`, `nextStopIndex`,
  `stopEtas[]`, `schedule[{id, arrivalTime, waitMinutes, status,
  departureClock, predictedArrivalRange{early,late}}]`.

Items beyond the expected baseline, flagged:

- **`vehicles[].vehicleId` is the raw Quartix vehicle ID** (e.g.
  `1000067169`), exposed to anyone holding a trip token. It's used
  client-side only as a React key/focus id — an opaque per-response index
  would serve equally well. Not a credential and not actionable against
  Quartix on its own, but it is a persistent internal identifier that
  contradicts the "no raw Quartix data" ambition. (The link surface,
  `/api/track/[token]`, has always exposed the same field plus
  `locationText` — Quartix `LocationText` content under a normalized name —
  as an intentional part of that page's UI.)
- `trip.id` and `schedule[].id` are internal random UUIDs (trip id doubles
  as a Redis key component; run ids exist for future per-run features).
  Low risk — random, unguessable, grant nothing — but they are internal
  IDs in a public response.

**Verdict: CONCERN** (functionally safe today; `vehicleId` is the item to
tighten if minimal disclosure is taken literally)

### 19. Public/internal path separation

`proxy.ts:26` matcher is `['/dashboard/:path*', '/api/internal/:path*']`.
`/api/public/trip/[token]` sits outside it **by design** — the 122-bit
token is the gate, same rationale as `/api/track`. No route under
`app/api/internal/` is reachable via any public path: the directory trees
are disjoint, and no public route imports or re-exports an internal
handler (verified by reading every public route's imports).

**Verdict: PASS**

## B. Google API key handling

### 20. Server key (GOOGLE_MAPS_API_KEY) stays server-side

- Source grep: the name appears only in `lib/googleMapsEnv.ts` (zod
  schema), `lib/googleMapsClient.ts` (lazy singleton `parseEnv` — the only
  read), and a comment in `components/GoogleMapsProvider.tsx`. No page
  prop, no API response field.
- Production bundles (`.next/static`, current build): the marker string
  `GOOGLE_MAPS_API_KEY` appears in **0** files; the actual key value
  (checked programmatically, value not printed) appears in **0** bundle
  files and **0** git-tracked files.

**Verdict: PASS**

### 21. Browser key (NEXT_PUBLIC_GOOGLE_MAPS_MAP_KEY) scope

Used in exactly one place: `components/GoogleMapsProvider.tsx` →
`<APIProvider apiKey=…>` (map rendering). All geocode/route/predict calls
go through the server-side `googleMapsClient` with the server key — no
client code path performs a Places/Routes call with the browser key. Its
value appears in exactly **1** client bundle chunk, which is the expected
and intended behavior of a NEXT_PUBLIC inlined browser key.

**Manual control point (not verifiable from code):** the browser key's
website-referrer restriction and API restrictions (Maps JavaScript API
only) live in the Google Cloud Console. They should be confirmed now and
re-confirmed periodically — a referrer-unrestricted browser key is
usable by anyone who views source.

**Verdict: PASS** (code side; console restrictions are an external control)

## C. Data exposure / minimal disclosure

### 22. Raw prediction data and buffer never reach clients

Read directly in `lib/tripDetail.ts`: schedule mapping emits only
`predictedArrivalRange` with two formatted clock strings;
`predictedArrivalDurationSeconds` / `predictedArrivalStaticDurationSeconds`
are consumed inside the builder and never copied to the output. A test
asserts both raw fields are absent from the response
(`tripDetail.test.ts`). `BUS_DURATION_BUFFER` greps to exactly three
files: `lib/tripEstimateConfig.ts` (definition), `lib/departureTime.ts`
(the one consumer), `__tests__/departureTime.test.ts` — no component, no
route, no response.

**Verdict: PASS**

### 23. Public vehicle labels from the normalized roster only

`lib/tripDetail.ts:66–69`: `vehicleLabel` is
`rosterEntry?.registrationNumber || rosterEntry?.description || 'Unknown
vehicle'` — normalized roster fields with a safe fallback; no raw Quartix
field passes through as a label. (`/api/track`'s `Vehicle` objects also
draw `registrationNumber`/`description`/`iconUrl` from the roster;
position/speed/`locationText` are the live telemetry that surface exists
to publish.)

**Verdict: PASS**

### 24. "included: false" trips

**The concept does not exist in the current code.** A repo-wide grep for
`included` finds only an unrelated test comment — no such flag on `Trip`,
no filtered listing. What the current model actually guarantees, verified
in `lib/tripsStore.ts`: a trip resolves ONLY through its own token's
reverse index (`trips:token:<token>` → id → trip); `buildTripDetailResponse`
reads nothing but that one trip; no public response anywhere contains
another trip's token (`listTrips` is reachable only via the
proxy-protected `/api/internal/trips`). So the intended property — one
token reveals exactly one trip, and no trip leaks through another's data —
holds; the `included` flag itself appears to be a stale memory from an
earlier build.

**Verdict: PASS** (with the naming discrepancy noted)

## D. Input validation

### 25. Trip creation schema

Read directly from `lib/tripInput.ts` + `lib/createLinkInput.ts` (shared
pieces): `name` non-empty-after-trim; `waypoints` ≥ 2, each with
non-empty-after-trim label and `lat ∈ [-90,90]`, `lng ∈ [-180,180]`;
`vehicles` ≥ 1, each `vehicleId` non-empty string and `schedule` ≥ 1;
each entry `arrivalTime` strictly `HH:mm` 24-hour
(`/^([01]\d|2[0-3]):[0-5]\d$/`) and `waitMinutes` integer ≥ 0. The route
additionally verifies every `vehicleId` against the live roster
(accumulated 400s) BEFORE any external call, and schema failures
short-circuit before roster/Google (tested). Validation error responses
are formatted paths+messages, no raw zod internals.

**Verdict: PASS**

### 26. departureTime construction for predictArrival

The only inputs are schema-validated values: `arrivalTime` (strict HH:mm)
+ `waitMinutes` (int ≥ 0) → `computeDepartureClock` (pure modular
arithmetic) → `nextOccurrenceOf(clock, new Date())` — the `now` anchor is
server-generated, never request-supplied. No user-controlled string
reaches the RFC3339 serialization (`Date.toISOString()`); nothing can
push the timestamp outside today/tomorrow or inject content into the
Google request body.

**Verdict: PASS**

## E. Rate limiting / Redis key hygiene

### 27. Prefix inventory

Complete list of limiter constructions in the codebase (grep-verified):

| Prefix | Limit | Used by |
|---|---|---|
| `ratelimit:dashboard-login` | 5 / 60s | `/api/login` via `dashboardGate` (failed attempts only) |
| `ratelimit:track` | 30 / 60s | `/api/track/[token]` AND `/api/track/[token]/[routeIndex]` |
| `ratelimit:trip` | 30 / 60s | `/api/public/trip/[token]` |

The `ratelimit:track` sharing is **deliberate and documented in code**
(`[routeIndex]/route.ts:7–10`): both endpoints are one customer surface,
and a shared budget prevents the split from doubling an abuser's
allowance. The trip surface's separate prefix is likewise deliberate
(`trip/route.ts:12–13`). No two *unrelated* endpoints share a prefix. No
dead prefix exists in code; any Redis keys from previously deleted
endpoints expire naturally with the sliding window's TTL, and the
single-commit git history contains no other prefixes to orphan.

**Verdict: PASS**

## F. Repo/build hygiene (post-push)

### 28. .gitignore and history

Read directly: `.gitignore` contains `.env*` (covers `.env.local`), plus
`.next/`, `node_modules`, `*.pem`, `*.tsbuildinfo`. Git metadata:
**1 commit** (`a7af510`), remote `github.com/ChiTownTracking/tracking`.
`git log --all -- '.env*'` → empty; `git ls-files` shows no env file
tracked (only the `lib/*Env.ts` schema modules, which contain no values).

**Verdict: PASS**

### 29. No real credentials in committed/fixture content — with one major finding

Every value in `.env.local` was scanned programmatically (values never
printed) against ALL git-tracked file contents and ALL production client
bundles: Quartix (URL/customer/username/password/application), Upstash
(URL/token), ORS key, Google server key, vehicle IDs — **0 hits
everywhere**. Fixtures contain only public API response data.

The exception that became the finding: the `DASHBOARD_PASS` **value**
matched, as a plain substring, 11 tracked source files — including files
this review independently confirms contain no literal credentials
(`lib/dashboardAuth.ts`, `SECURITY_REVIEW.md`, test files) — and 4
framework bundle chunks. An 8-character value matching the ordinary
English text of auth-related source code means the password is, with very
high confidence, the literal string "password" (or an equally common
8-character substring of everyday prose). `DASHBOARD_USER` (5 characters)
similarly matches as a substring inside two ORS geocode fixtures'
address text — a short, common string.

To be precise about what this is and isn't: **no credential was committed
or leaked by the push** — these are substring collisions, not copies of
`.env.local`. The finding is that the staff dashboard is protected by a
trivially guessable password on an internet-reachable login endpoint,
while the pushed public repo documents the exact auth mechanism, rate
limits, and endpoints. The login limiter (5 failed/min, Redis-backed)
does not meaningfully protect a password that appears in the first
handful of any guessing list. Timing-safe comparison is irrelevant at
this strength.

Action (report-only, not applied): rotate both `DASHBOARD_USER` and
`DASHBOARD_PASS` to long random values immediately.

Additional observation: `SECURITY_REVIEW.md` itself is committed to the
**public** repository. It's an honest document, and none of its content
is secret, but it hands any reader a curated map of the app's controls,
prior weaknesses, and rate-limit budgets. Worth a deliberate decision
(private repo, or exclude the file), especially while item 29's
credential weakness exists.

**Verdict: FAIL** (credential strength, compounded by the public repo —
not a committed-secret leak)

### 30. Login rate limiting + timing-safe comparison unchanged

`lib/dashboardAuth.ts:16–18`: both comparisons evaluated into independent
locals via `timingSafeStringEqual` before `&&` — identical logic to the
Phase 6 review, now reached via `/api/login` instead of Basic Auth.
`lib/dashboardGate.ts:22–31`: correct credentials short-circuit before
the limiter; only failed attempts consume budget — unchanged ordering,
now against the Redis-backed limiter. Session cookie is `httpOnly`,
`secure` in production, `sameSite: lax`, no client-readable expiry, with
a server-side Redis TTL as the independent lifetime cap.

**Verdict: PASS**

## G. Auth boundary re-confirmation

### 31. Matcher coverage of every current internal route

Complete enumeration of `app/api/internal/**/route.ts` in the current
tree against `matcher: '/api/internal/:path*'`:

| Route | Added since Phase 6? | Covered? |
|---|---|---|
| `/api/internal/fleet-live` | no | yes |
| `/api/internal/roster` | no | yes |
| `/api/internal/create-link` | no | yes |
| `/api/internal/links` | no | yes |
| `/api/internal/links/[token]` | no | yes (nested; `:path*` = zero or more segments) |
| `/api/internal/geocode` | **yes** (J-series) | yes |
| `/api/internal/trips` | **yes** (I1) | yes |

Routes deliberately outside the matcher: `/api/login`, `/api/logout`
(pre-auth by necessity), `/api/track/*` and `/api/public/trip/*`
(token-gated public surfaces). The temporary `/api/dev/*` capture routes
used during the J/K phases have all been deleted; `app/api/` contains
only `internal`, `login`, `logout`, `public`, `track`.

**Verdict: PASS**

## Prioritized findings (2026-07-18 review)

1. **[HIGH] Item 29 — trivially weak dashboard credentials.** The
   password is with near-certainty the literal string "password" and the
   username a 5-character common string, on a public-internet login whose
   mechanics are documented in the now-public repo. Rotate both to long
   random values now. (Everything else about the auth chain — timing-safe
   compare, failed-only Redis rate limiting, httpOnly session cookies —
   is in good shape and PASSes.)
2. **[MEDIUM] Item 29 observation — SECURITY_REVIEW.md is in the public
   repo.** Decide deliberately: private repo, or stop committing the
   review file.
3. **[LOW] Item 18 — raw Quartix `vehicleId` in public trip/track
   responses.** Random-per-response opaque indices would serve the client
   equally well. Low practical risk; listed because "no raw Quartix
   identifiers" is the stated ambition.
4. **[INFO] Item 21 — browser map key restrictions are a Google Cloud
   Console control.** Confirm referrer + API restrictions now; recheck
   periodically.
5. **[INFO] Item 24 — the "included: false" concept from the review
   brief doesn't exist in code.** The isolation property it implies holds
   anyway (per-token reverse index, no cross-trip data). If a visibility
   flag is intended to exist, it was never built.
