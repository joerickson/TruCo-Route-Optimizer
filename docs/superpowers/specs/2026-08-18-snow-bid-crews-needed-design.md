# Snow Bid — Crews-Needed Analysis

**Date:** 2026-08-18
**Status:** Design — awaiting review
**Scenario driving this:** `TruCo IFS Snow`

## Problem

The tool models recurring maintenance: `service_type` is `weekly | biweekly | monthly`
with fixed annual visit counts ([src/lib/effective-labor.ts](../../../src/lib/effective-labor.ts)),
demand math multiplies labor by visit frequency, and the binding constraint is the
"peak summer week." Snow work is **as-needed** — triggered by storm events, not a
calendar — so none of that applies. The Overview/Properties map even shows
Weekly / Bi-Weekly / Monthly toggles that are meaningless for a snow scenario.

## Goal

Answer, for a snow bid: **how many crews are needed, and where based**, to clear the
bid's property set within the service window after a storm.

## Model decisions (settled with stakeholder)

- **Constraint = design window.** Snow is "before business open," so the usable window
  is variable per storm. For bidding we size crews against a single **design window**
  (hours available for one full clearing pass). Default **4 hr**, editable on the page.
- **Two independent fleets.** Plow trucks and sidewalk crews are separate resources
  (different work, can't substitute). Each is sized independently.
- **Labor is tier-based (plow) + a per-property toggle (sidewalk):**
  - **Plow time = the property's tier time.** Tier 1 = **1.5 hr**, Tier 2 = **1.0 hr**,
    Tier 3 = **1.0 hr**. Every property is a plow stop. Editable per scenario.
  - **Sidewalk = opt-in per property.** A `has_sidewalk` toggle, **default off** (most
    properties have no sidewalks). When on, a **flat 0.5 hr** applies. Only toggled-on
    properties are sidewalk-fleet stops. Sidewalk time is one editable value for all.
- **Crews dispatch from home after hours** — they do NOT drive to a branch first.
  So routes are **open** (start at the first property, no depot round-trip leg).
  Branches remain an **administrative grouping** (which unit owns the contract, and a
  rough proxy for where crews live): each property is assigned to its nearest branch,
  and crews are sized per branch.
- **Fidelity: aggregate now, VRP-ready.** A TypeScript route-slice heuristic (below)
  produces the crew counts, with a real nearest-neighbor travel estimate rather than a
  fudge factor. The compute is isolated so a full OR-Tools VRP snow-mode can replace it
  later without touching the UI or schema.

## Schema changes (migration; paste-ready SQL delivered with the change)

- `scenarios.kind text not null default 'maintenance'` — `'maintenance' | 'snow'`.
- `scenarios.snow_window_hours numeric not null default 4` — editable design window.
- `scenarios.snow_sidewalk_hours numeric not null default 0.5` — flat sidewalk time.
- `properties.tier text` — nullable; the tier level (currently lands in `notes`).
- `properties.has_sidewalk boolean not null default false`.
- New table `snow_tier_rates (scenario_id uuid, tier text, plow_hours numeric, primary key (scenario_id, tier))`
  — editable plow hours per tier. Seeded for the snow scenario: `1 → 1.5`, `2 → 1.0`, `3 → 1.0`.

## Components

### 1. `src/lib/snow-capacity.ts` (pure, fully unit-tested)

Inputs: properties (with `tier`, `has_sidewalk`, `lat`, `lng`), branches (with `lat`,
`lng`), tier plow-hours map, flat sidewalk hours, window hours.

- `assignToNearestBranch(properties, branches)` → each property tagged with a branch id
  (uses [src/lib/distance.ts](../../../src/lib/distance.ts) `driveMinutes`).
- `crewsForFleet(stops, windowHours)` — the route-slice heuristic:
  1. Order `stops` by nearest-neighbor (greedy tour). Open route.
  2. Walk the tour accumulating per-crew load = Σ(stop labor) + Σ(travel between
     consecutive stops **within the same crew**). No incoming travel for a crew's first
     stop; no return leg.
  3. When adding the next stop would exceed `windowHours`, close the crew and start a new
     one at that stop. Crew count = number of segments.
  4. A lone stop whose labor already exceeds the window still counts as 1 crew and is
     flagged `overWindow` (won't happen with current numbers: max 1.5 hr < 4 hr).
- `snowCapacity(...)` — per branch, runs `crewsForFleet` for the **plow** fleet (all
  properties in the branch, labor = tier plow-hours) and the **sidewalk** fleet
  (only `has_sidewalk` properties, labor = flat sidewalk-hours). Returns per-branch
  `{ plowCrews, sidewalkCrews, plowLaborHrs, sidewalkLaborHrs, plowTravelHrs, sidewalkTravelHrs, plowStops, sidewalkStops }`
  plus portfolio totals.

Ungeocoded properties are excluded from routing and surfaced as a count (matches the
existing map convention). Properties with no `tier` are flagged as unrated and excluded
from the plow total (shown in a warning badge) rather than silently defaulted.

### 2. `/snow` page (`src/app/snow/page.tsx`)

Visible only when the active scenario's `kind === 'snow'`.

- **Assumptions panel** (top): editable design-window hours; editable per-tier plow
  hours; editable flat sidewalk hours. Saving writes to `snow_tier_rates` /
  `scenarios.snow_window_hours` / `scenarios.snow_sidewalk_hours` and recomputes.
- **Results table**: one row per branch — plow trucks, sidewalk crews, plow labor-hrs,
  sidewalk labor-hrs, est. travel, stop counts. Footer row = portfolio totals.
- **Map**: reuse the property map, colored by tier (T1/T2/T3), with a sidewalk indicator.
- Warning badges: ungeocoded count, unrated (no tier) count.

Server action returning `{ ok, error }` wrapped in a client component using
`useTransition` (per the CLAUDE.md server-action convention).

### 3. Conditional UI for snow scenarios

- **Nav** ([src/components/top-nav.tsx](../../../src/components/top-nav.tsx)): pass the active
  scenario's `kind`. When `snow`, show a **Snow** item and hide the summer-only
  **Capacity** item (its bands don't apply). Other pages stay.
- **Property map** (Overview + Properties): when `kind === 'snow'`, swap the
  Weekly/Bi-Weekly/Monthly frequency toggles + legend for **tier** coloring.

### 4. Import mapping

The column-mapping step gets two new optional targets: **Tier** (→ `properties.tier`)
and **Sidewalk** (→ `properties.has_sidewalk`, truthy-parsed). Existing
`toDbRow` / mapping logic extends to carry them. For the current snow data, re-import
maps Tier Level → `tier`; `has_sidewalk` defaults off and is set per-property.

### 5. Per-property sidewalk toggle

Add a `has_sidewalk` checkbox to the property edit form
([src/app/properties/[id]/property-edit-form.tsx](../../../src/app/properties/[id]/property-edit-form.tsx))
so buildings with sidewalks can be flagged individually (the common case is leaving it off).

## Testing

- `snow-capacity.test.ts`: `crewsForFleet` window slicing (exact-fit, over-window lone
  stop, empty fleet, single stop, travel pushing a boundary); `assignToNearestBranch`
  ties; sidewalk fleet excludes non-sidewalk properties; portfolio totals = Σ branches.
- Import: Tier + Sidewalk mapping round-trips (extend existing csv-import tests).

## Explicitly out of v1

Full OR-Tools VRP snow-mode; crew home addresses; per-property SLA / deadline tiers;
plow↔sidewalk route interaction; season event-count cost modeling. All reachable later —
the isolated `snow-capacity` compute is the seam where VRP slots in.
