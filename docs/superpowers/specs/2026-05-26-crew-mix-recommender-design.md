# Crew-Mix Recommender (analytical, v1) — Design Spec

**Date:** 2026-05-26
**Status:** Approved (design)
**Scope:** Given the property portfolio and branches, recommend **how many crews per
branch and the 2-/3-person mix** that covers all the work at sustainable utilization
for the lowest cost — by analytical capacity bin-packing, no routing-solver runs.

Inverts the current model: today crews are fixed inputs the solver routes against;
this recommends the fleet to run.

## 1. Goal

Answer "what fleet should we run?" Per branch, output **N two-person + M
three-person crews** such that:
- every property's weekly labor is covered, and
- every crew sits in the sustainable band (≤ ~50 clock-hrs/wk),
- at the **lowest cost** (fewest people / least wasted crew capacity).

The 2-vs-3 mix is meaningful because of a **weekly capacity ceiling**: a 2-person
crew delivers ~100 person-hrs/wk sustainably, a 3-person ~150. A property whose
weekly labor exceeds a 2-person crew's weekly capacity (e.g. Canyon Park at 132.6
ph/wk) **cannot be finished by a 2-person crew** and forces a 3-person crew. So the
mix is driven by the **property-size distribution**, which is analytically
computable — no solver sweep, no drive-time modeling required for the recommendation.

### Out of scope (v1)
- Routing-solver validation/sweep of the recommended fleet (the deferred "~50×
  runs" problem). The recommendation is analytical; a user can manually run the
  existing optimizer with the recommended crews to sanity-check. Auto-validation is
  a possible later iteration.
- Drive-time-optimal mix refinement (would need the solver). v1's mix is driven by
  capacity feasibility + packing, not routing cost.
- "Suggest new branch location" (separate deferred item).
- Changing the solver, schema, or any existing behavior. This is purely additive.

## 2. Background / current state

- `branches` (lat/lng, is_active), `crews` (crew_size, max_clock_hours_per_day,
  works_* days, home_branch_id), `properties` (est_labor_hours = per-visit
  person-hours, service_type weekly/biweekly/monthly, lat/lng, preferred_branch_id).
- Sustainable band (CLAUDE.md): `40–50` sustainable, `50–55` tight, `>55` add crews.
- `src/lib/distance.ts` has `haversineMiles` for nearest-branch attribution.
- The solver routes a **representative peak week** visiting all active properties
  once (it does not down-weight biweekly/monthly today). v1 matches this (see §3.2).

## 3. Model & assumptions

All constants are **named and tunable** (this is a "test and iterate" feature).

### 3.1 Property → branch attribution
Each active, geocoded property is attributed to one branch:
- its `preferred_branch_id` if that branch is active; else
- the **nearest active geocoded branch** by Haversine.
Active properties with no coordinates and no preferred branch are reported as
**unattributable** (count surfaced, excluded from sizing) — a data-quality signal.

### 3.2 Weekly labor per property
v1: `weekly_labor = est_labor_hours` for every active property (treated as a weekly
visit), **matching the solver's representative-week model** (so a recommendation is
consistent with what the optimizer would be asked to route). This is conservative
for biweekly/monthly.
- **Iterate option (documented, not v1):** frequency-weight via
  `{weekly:1.0, biweekly:0.5, monthly:0.23}` for true average demand. Deferred to
  keep v1 consistent with the solver and simple.

### 3.3 Crew weekly capacity (usable labor person-hours)
- `SUSTAINABLE_CLOCK_PER_WEEK = 50` — top of the "sufficient" band (tunable).
- `USABLE_FRACTION = 0.85` — share of clock-time that is service vs drive (matches
  the solver's `_DAY_CAPACITY_HEADROOM`; tunable).
- `cap2 = USABLE_FRACTION × SUSTAINABLE_CLOCK_PER_WEEK × 2` ≈ **85 ph/wk**
- `cap3 = USABLE_FRACTION × SUSTAINABLE_CLOCK_PER_WEEK × 3` ≈ **127.5 ph/wk**

(With these defaults Canyon Park's 132.6 ph slightly exceeds one 3-person crew —
realistic: it nearly maxes a 3-person crew and tips into needing a split. Tuning
`USABLE_FRACTION`/`SUSTAINABLE_CLOCK_PER_WEEK` shifts these thresholds; expected
during iteration.)

### 3.4 Bin-packing (per branch) — first-fit-decreasing heuristic
Treat each property as a unit of work preferably handled by **one crew** (the
operational preference: a crew finishes a property where it fits a crew's week).
Crews are bins of capacity `cap2` (2-person) or `cap3` (3-person). Goal: cover all
labor, minimize people.

1. **Oversize (`labor > cap3`):** the property can't fit any single crew — allocate
   `ceil(labor / cap3)` dedicated 3-person crews for it (it will be split across
   them by the router later). Record it as "split across N crews."
2. **Needs-3 (`cap2 < labor ≤ cap3`):** must go on a 3-person crew (a 2-person can't
   finish it). Open a 3-person bin seeded with this property.
3. **Flexible (`labor ≤ cap2`):** pack first-fit-decreasing — largest first — into
   any open bin with remaining room (prefer filling already-open 3-person bins to
   reduce waste, then open 2-person bins). Open a new 2-person bin when nothing fits.
4. Each crew's recommended size is set by its bin type; report per-crew projected
   load (Σ packed labor) and utilization (`load / (cap × ... )` → clock-hrs/wk).

This is a heuristic (exact two-bin-size min-cost packing is NP-hard); good enough for
a strategic recommendation and easy to iterate. It yields a genuine 2/3 mix: 3-person
crews only where big properties require them, 2-person for the rest.

### 3.5 Output (per branch + portfolio)
Per branch: `{ branchId, branchName, twoPersonCrews, threePersonCrews, totalCrews,
totalPeople, demandHours, capacityHours, avgUtilPct, driversThreePerson: [property
names/hours that forced 3-person crews], splitProperties: [names needing >1 crew] }`.
Portfolio: totals + the unattributable-properties count.

## 4. Architecture

- **`src/lib/crew-recommender.ts`** (pure, no IO, unit-tested): the model.
  - `attributeToBranches(properties, branches) → Record<branchId, Property[]>` + unattributable list (uses `haversineMiles` from `./distance`).
  - `recommendCrews(propsForBranch, caps) → BranchRecommendation` (the bin-packing).
  - `buildFleetRecommendation(properties, branches, config) → FleetRecommendation` (orchestrates attribution + per-branch packing + portfolio totals). `config` carries the tunable constants with the §3.3 defaults.
- **`src/app/recommend/page.tsx`** (server component): loads active branches +
  active geocoded properties via `getServerClient`, calls `buildFleetRecommendation`,
  renders. Add a `Recommend` (or "Fleet plan") link to `top-nav.tsx`.
- Presentational components for the per-branch table + portfolio summary
  (`recommend-table.tsx`), mirroring existing Card/Table usage.

No solver, no Python, no DB/schema change, no migration.

## 5. UI

A `/recommend` page:
- Headline: "Recommended fleet: X crews (Y two-person, Z three-person) across N
  branches to cover ~D person-hours/week sustainably."
- Per-branch table: Branch · demand (ph/wk) · 2-person · 3-person · total people ·
  avg util · what drove the 3-person crews.
- A note listing properties that must split across crews, and any unattributable
  properties (data fix needed).
- A short "how this is computed" footnote (capacity assumptions + that it's
  analytical, validate by running the optimizer with these crews).

## 6. Testing

vitest on `crew-recommender.ts` (pure):
- **attribution:** preferred_branch_id honored when active; else nearest by
  Haversine; unattributable (no coords, no preferred) collected.
- **capacity math:** cap2/cap3 from the constants.
- **bin-packing:**
  - all small properties (≤ cap2) → only 2-person crews; count = ceil(total/cap2)-ish
    (FFD), all labor covered.
  - a `cap2 < labor ≤ cap3` property → exactly one 3-person crew opened for it,
    small props fill its remaining room.
  - an oversize property (`> cap3`, e.g. Canyon Park 132.6) → flagged split across
    `ceil(132.6/cap3)` 3-person crews.
  - mixed set → sensible 2/3 mix; `driversThreePerson` lists the big properties;
    total covered labor == input labor (within rounding).
- **portfolio totals** sum per-branch; unattributable surfaced.

Page render + nav verified manually.

## 7. Risks / iterate points (expected to tune)

- **Capacity constants** (`SUSTAINABLE_CLOCK_PER_WEEK`, `USABLE_FRACTION`) set the
  thresholds; the right values come from comparing the recommendation against real
  runs. Centralized as config for easy tuning.
- **Weekly-vs-frequency demand (§3.2):** v1 counts every property weekly (matches
  solver, conservative). Frequency-weighting is the most likely first iteration.
- **Analytical vs routed:** ignores drive geography, so it can under-count crews for
  very spread branches (drive eats more than the 0.85 factor). The `USABLE_FRACTION`
  is the safety margin; validate against an optimizer run for a branch that looks
  tight.
- **FFD heuristic** isn't provably min-cost; acceptable for a recommendation. If a
  branch's mix looks off, that's the place to refine.
- **Indivisible-property assumption (§3.4):** packs as if one crew finishes a
  property (the operational preference). Properties > cap3 are the only ones split.
  This is what makes the mix meaningful; if ops actually splits freely, mix matters
  less and the model would over-recommend 3-person crews.
