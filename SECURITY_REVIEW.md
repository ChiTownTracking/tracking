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
