# Scenarios — isolated property/crew/branch sets for bid analysis

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation

## Problem

Today all properties, crews, and branches live in one global pool, and every
optimize run sweeps across the entire active set. There is no way to model a
prospective contract or a "what-if" fleet separately from the live 30-crew
TruCo portfolio. The user wants to:

1. Create a separate, self-contained set of properties/crews/branches (a
   **Scenario**) and optimize it independently of the live portfolio.
2. Within a scenario, optimize only a **geographic subset** of properties —
   e.g. "only properties within 25 miles of our SLC office" — without deleting
   the out-of-range properties.

This is **bid/scenario analysis for a single internal login** — not
multi-tenant SaaS. No auth, no per-customer data-isolation boundary. Scoping is
a UX/organization concern enforced in application queries, consistent with the
existing service-role-client + disabled-RLS pattern.

## Terminology

The top-level grouping is called a **Scenario** throughout the UI
(e.g. "Scenario: Park City Bid"). The pre-existing live data is the **default
scenario**, named "TruCo Portfolio".

## Approach

Chosen: a `scenarios` table plus a `scenario_id` foreign key on `properties`,
`crews`, `branches`, and `optimization_runs`. The active scenario is held in a
cookie and applied as a filter on every relevant query. Existing rows migrate
into the default scenario.

Rejected alternatives:
- **Property-only tag/group column** — cannot model scenario-owned crews and
  branches, which is a hard requirement.
- **Full multi-tenant auth + RLS** — out of scope; single internal login, and
  CLAUDE.md explicitly warns against the customer-facing direction.

## Data model

New table:

```sql
create table scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamp with time zone default now()
);
```

Add `scenario_id uuid references scenarios(id)` to `properties`, `crews`,
`branches`, and `optimization_runs`. Migration sequence:

1. Create `scenarios`.
2. Insert the default scenario "TruCo Portfolio" (`is_default = true`).
3. Add `scenario_id` columns as nullable.
4. Backfill all existing rows in the four tables to the default scenario id.
5. Set each `scenario_id` `not null`.
6. Add an index on `scenario_id` for each of the four tables.
7. Partial unique index to enforce a single default:
   `create unique index scenarios_one_default on scenarios (is_default) where is_default;`

`on delete` behavior: deleting a scenario cascades to its properties, crews,
branches, and runs. The default scenario cannot be deleted (enforced in the
app action, not the DB).

Per CLAUDE.md, the paste-ready SQL migration will be included in the
implementation response so the user can run `supabase db push` before deploy.

## Scenario switching & scoping

- **Cookie:** `active_scenario_id` holds the selected scenario.
- **Resolver:** `getActiveScenarioId(cookieValue, scenarios)` — pure function
  that returns the cookie's scenario id when it matches an existing scenario,
  otherwise the default scenario's id. A thin server wrapper reads the cookie
  and the scenario list and calls it.
- **Switcher:** a dropdown in the app header/nav listing scenarios, plus "New
  scenario" and "Manage scenarios" entries. Selecting a scenario sets the
  cookie and refreshes.
- **Management page** `/scenarios`: create, rename, delete scenarios. Delete is
  blocked for the default scenario. Creating a scenario starts it empty (no
  properties/crews/branches) — the user imports/adds into it.
- **Query scoping:** every query against `properties`, `crews`, `branches`, and
  `optimization_runs` gains `.eq('scenario_id', activeScenarioId)`. Every insert
  into those tables stamps the active scenario id. This spans the known query
  sites:
  - properties: `capacity/page.tsx`, `compare/actions.ts`,
    `compare/schedule-template/route.ts`, `optimize/actions.ts`,
    `optimize/page.tsx`, `page.tsx`, `properties/[id]/actions.ts`,
    `properties/[id]/page.tsx`, `properties/actions.ts`,
    `properties/actual-hours-actions.ts`,
    `properties/actual-hours-template/route.ts`, `properties/map-data.ts`,
    `properties/page.tsx`, `recommend/actions.ts`,
    `runs/[runId]/fix-actions.ts`, `runs/[runId]/page.tsx`
  - branches: `branches/actions.ts`, `branches/page.tsx`, `compare/actions.ts`,
    `crews/page.tsx`, `optimize/actions.ts`, `optimize/page.tsx`, `page.tsx`,
    `properties/[id]/page.tsx`, `properties/map-data.ts`,
    `recommend/actions.ts`, `runs/[runId]/fix-actions.ts`,
    `runs/[runId]/page.tsx`
  - crews: `branches/actions.ts`, `branches/page.tsx`, `capacity/page.tsx`,
    `compare/actions.ts`, `compare/schedule-template/route.ts`,
    `crews/actions.ts`, `crews/page.tsx`, `optimize/actions.ts`,
    `optimize/page.tsx`, `page.tsx`, `properties/actions.ts`,
    `recommend/actions.ts`, `runs/[runId]/fix-actions.ts`,
    `runs/[runId]/page.tsx`
- **`optimization_runs` reads** are likewise scoped to the active scenario:
  the runs list, run-detail page, the dashboard's recent-runs, and `compare`
  only show runs belonging to the active scenario.
- **Imports** (Aspire xlsx/CSV, schedule, actual-hours) write into the active
  scenario.

Net effect: select a scenario in the nav → every page (properties, crews,
branches, capacity, runs, optimize) shows only that scenario's data.

## Per-run geographic property selection

In the optimize form, add an optional property-filter block:

- **Anchor**: dropdown of the active scenario's branches (offices).
- **Radius**: miles input.
- **Behavior**: when anchor + radius are set, the run includes only the
  scenario's active, geocoded properties within that road-adjusted distance of
  the anchor branch. When blank, all active geocoded properties in the scenario
  are used (current behavior).

Implementation:
- New pure module `src/lib/property-radius.ts`:
  `filterPropertiesWithinRadius(properties, anchor, radiusMiles)` built on the
  existing haversine helper in `src/lib/distance.ts`. Ungeocoded properties are
  excluded; a blank/undefined radius passes all through.
- `optimize/actions.ts` resolves anchor + radius → filtered property list →
  writes their ids to `optimization_runs.active_property_ids` (column already
  exists). The selected anchor id and radius are stored in the run's
  `config_snapshot` so the run is self-documenting.
- The run-detail page surfaces the applied filter (anchor branch name, radius,
  resulting property count).

No solver changes — the solver already accepts `active_property_ids`.

## Testing

Following the existing pattern (pure logic in `src/lib/*` with co-located
`.test.ts`):

- `src/lib/property-radius.test.ts`: property inside radius included, outside
  excluded, ungeocoded excluded, blank radius = pass-through, distance uses the
  shared road-factor logic.
- Scenario resolver test: cookie matches existing scenario → that id; missing
  or invalid cookie → default scenario id; no default present → safe behavior.
- All existing tests continue to pass; the backfill migration ensures no row is
  left without a `scenario_id`.

Manual verification checklist:
1. After migration, the live portfolio appears under "TruCo Portfolio" with all
   existing properties/crews/branches intact.
2. Create a second scenario; it starts empty.
3. Import properties into the second scenario; confirm the default scenario is
   untouched.
4. Run a radius-filtered optimize in the second scenario; confirm the run's
   property set contains only in-radius properties and the run detail shows the
   applied anchor + radius.
5. Switch back to the default scenario; confirm its data and prior runs are
   unchanged.

## Out of scope

- Authentication, per-customer login, RLS-based isolation.
- Cross-scenario comparison views (each scenario is analyzed on its own).
- Copying/cloning properties or fleets between scenarios.
- Saved named property subsets, attribute-based or manual property selection
  (only branch-radius selection is in scope for this iteration).
