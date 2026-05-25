# Routes Map View — Design Spec

**Date:** 2026-05-25
**Status:** Approved (design)
**Scope:** A map visualization for completed optimization runs, plus a small data fix
to surface properties the solver couldn't schedule.

## 1. Goal & scope

Add a map view at `/runs/[runId]?view=map` for **completed** runs that:

- Draws every crew's route for a selected weekday (depot → stops → depot).
- Lets the user step through Mon–Fri and auto-play through the days.
- Animates each crew's marker progressing along its route across the workday
  (a within-day time scrubber, ~7:00 AM → the day's latest end time).
- Shows all crews at once by default, with filter / solo / hover-highlight.
- Surfaces properties the solver could not assign as a distinct map layer.

The existing tables on the run-detail page remain the default `?view=list` view.
Nothing about the current page regresses.

### Out of scope — Phase 2 (after this ships)

These are valuable (see the codebase audit) and planned for the next phase once
this ships, but explicitly NOT in this change:

- Road-snapped polylines via Mapbox Directions (we draw straight-line segments,
  matching the solver's cost model).
- Run A/B comparison.
- Demand (labor-hour) heatmap layer.
- "Suggest new branch location" sweep.
- Route editing / drag-to-reassign.
- Crew-size-aware solving (separate accuracy fix, not map work).

## 2. Background / current state

- Solver output lives in `optimization_runs.routes_jsonb` as
  `{ per_day: CrewDayRoute[] }`. Each `CrewDayRoute` has `crew_id`, `crew_name`,
  `day_of_week` (1=Mon..7=Sun), `branch_id`, `start_time`, `end_time`,
  `clock_hours`, `drive_hours`, `drive_miles`, and `stops[]`.
- Each `RouteStop` has `property_id`, `property_name`, `address`, `lat`, `lng`,
  `arrival_time` ("HH:MM"), `service_minutes`, `drive_minutes_to`. Types in
  `src/lib/types.ts`.
- The run-detail page `src/app/runs/[runId]/page.tsx` already groups routes by
  `day_of_week` into tabs and renders per-crew stop tables + a utilization table.
  There is no map today.
- An existing Mapbox component `src/app/properties/properties-map.tsx` establishes
  the patterns to reuse: GeoJSON sources, single map init keyed on the token with
  data updates via `source.setData`, fit-bounds, Nav/Fullscreen controls, popups
  built with an `escapeHtml` helper, a token-missing guard, and lazy-loading via
  `properties-map-loader.tsx` (`dynamic(import, { ssr: false })`) gated on a
  `?view=` query param (`view-toggle.tsx`).
- Travel time is straight-line Haversine × 1.3 at 30 mph
  (`solver/api/distance_matrix.py`); this is documented in the UI as approximate.

### Two facts that shape the design

1. **Depot coordinates are not in the route output** — routes carry `branch_id`
   only. To draw the depot legs (and depot markers) the page must join
   `branch_id → branches.lat/lng`.
2. **Unassigned properties are computed then dropped.** `run_optimization` in
   `solver/api/index.py` returns `unassigned_property_ids`, but `_persist` never
   writes it and there is no column for it. This spec fixes that.

## 3. Architecture & data flow

Server component `runs/[runId]/page.tsx`:

1. Reads `searchParams.view` (`'map' | 'list'`, default `'list'`).
2. Always loads the run (unchanged).
3. **When `view === 'map'` and the run is completed**, additionally:
   - Collects the distinct `branch_id`s referenced in `routes_jsonb.per_day` and
     queries `branches` for `id, name, lat, lng` → `depotsById`.
   - Queries `properties` (`id, name, address, lat, lng`) for
     `run.unassigned_property_ids` (skip if null/empty).
   - Assigns each crew a stable color via evenly-spread HSL:
     `hsl(round(i * 360 / n), 65%, 50%)`, where `i` is the crew's index in a
     stable sort (by `crew_name`, then `crew_id`) over the crews appearing in the
     routes. Computed server-side so legend and map agree; 30 crews never collide.
4. Passes plain serializable props into `RoutesMapLoader`.

Only completed runs get the toggle + map. Pending/running/failed states render as
they do today.

### Serializable prop shape (informative)

```ts
interface RoutesMapProps {
  routes: CrewDayRoute[];              // run.routes_jsonb.per_day
  depotsById: Record<string, { id: string; name: string; lat: number; lng: number }>;
  crewColors: Record<string, string>; // crew_id -> hex/hsl
  crewOrder: { crewId: string; name: string; color: string }[]; // legend order
  unassigned: { id: string; name: string; address: string; lat: number; lng: number }[];
  days: number[];                      // sorted distinct day_of_week present
}
```

## 4. Files

New:

- `src/lib/route-playback.ts` — pure timeline math (no Mapbox/React).
- `src/app/runs/[runId]/routes-map.tsx` — Mapbox client component.
- `src/app/runs/[runId]/routes-map-loader.tsx` — `dynamic(..., { ssr:false })` wrapper.
- `src/app/runs/[runId]/run-view-toggle.tsx` — list/map segmented control (run-scoped).
- `supabase/migrations/20260525000000_unassigned_property_ids.sql` — new column.
- `src/lib/route-playback.test.ts` — vitest unit tests for the pure math.

Edited:

- `src/app/runs/[runId]/page.tsx` — view handling + depot/unassigned queries + color assignment.
- `src/lib/types.ts` — add `unassigned_property_ids: string[] | null` to `OptimizationRun`.
- `solver/api/index.py` — add `unassigned_property_ids` to the `_persist` PATCH body.
- `package.json` — add `vitest` dev dependency + `test` script.

## 5. Map rendering

Single map init keyed on the Mapbox token (same as `properties-map.tsx`); the
selected day is applied by rebuilding GeoJSON and calling `source.setData`.

Sources / layers:

- `route-lines` — one `LineString` per crew for the selected day, ordered
  depot → stop₁ → … → stopₙ → depot. `line-color` from a per-feature `color`
  property; width ~3. Dimming for non-highlighted/non-selected crews via an
  opacity expression driven by feature-state.
- `route-stops` — `Point` per stop, crew-colored circle with a `symbol`
  sequence-number label (1..n in visit order).
- `depots` — branch `Point` markers; reuse the existing red branch style and a
  popup.
- `unassigned` — distinct red `Point` layer; rendered only when `unassigned`
  is non-empty. A count badge appears in the card header.
- `crew-position` — animated `Point`(s); one per visible crew, position set each
  animation frame (see §6).

Controls / interaction:

- **Day stepper**: segmented Mon–Fri (only days present) + a "Play days" button
  that auto-advances days.
- **Crew filter**: chips per crew with All / None and click-to-solo. Hovering a
  crew highlights it and fades others to ~15% opacity.
- **Stop popup**: property name, arrival time, service minutes, drive-in minutes.
- Reuses Nav + Fullscreen controls, fit-bounds to the day's geometry,
  `escapeHtml` for popup HTML, and the token-missing guard card.
- A visible disclosure: routes are straight-line approximations (Haversine ×1.3),
  not turn-by-turn — consistent with existing UI honesty.

## 6. Playback engine

`src/lib/route-playback.ts` — pure and unit-tested. No Mapbox, no React.

- `parseClock(hhmm: string): number` — "HH:MM" → seconds from midnight.
- `buildCrewTimeline(route, depot)` → ordered segments covering the crew's day.
  Because each stop's `arrival_time` already encodes the full schedule, the crew's
  state at clock-time *T* is:
  - `[start_time, arrival₁]`: interpolating depot → stop₁.
  - `[arrivalᵢ, arrivalᵢ + serviceᵢ]`: stationary at stopᵢ.
  - `[arrivalᵢ + serviceᵢ, arrivalᵢ₊₁]`: interpolating stopᵢ → stopᵢ₊₁.
  - `[lastServiceEnd, end_time]`: interpolating last stop → depot.
  - after `end_time`: at depot (route complete).
- `positionAt(timeline, clockSeconds): [lng, lat] | null` — linear interpolation
  along straight segments (matches the solver's straight-line model). Returns the
  depot position before `start_time` and after `end_time`; `null` only if the
  timeline is empty (no stops).

Driver (in `routes-map.tsx`):

- `clockSeconds` state runs from 7:00 AM (25200s) to the day's latest `end_time`.
- **Play** advances `clockSeconds` on `requestAnimationFrame` at a fixed
  compression of ~1 work-hour ≈ 2 seconds wall-time, recomputing every visible
  crew's position and pushing a single `setData` to `crew-position` per frame
  (~30 points — cheap).
- Scrubber is draggable; Play / Pause / Reset provided. Switching day resets the
  clock to day start.

## 7. Unassigned-properties fix

- Migration `supabase/migrations/20260525000000_unassigned_property_ids.sql`:

  ```sql
  alter table optimization_runs
    add column if not exists unassigned_property_ids uuid[];
  ```

  Paste-ready SQL is surfaced in the chat response per the repo's migration
  convention; run via `supabase db push` (never auto-applied).

- `solver/api/index.py` `_persist`: add
  `"unassigned_property_ids": result["unassigned_property_ids"]` to the PATCH body.
  The value is already computed by `run_optimization`.

- `src/lib/types.ts`: add `unassigned_property_ids: string[] | null` to
  `OptimizationRun`.

- **Deploy note:** populating this requires redeploying the solver on Coolify.
  Existing runs keep `null`; the map simply omits the unassigned layer for them.

## 8. Testing

- Add **vitest** (dev dependency) + a `test` npm script. Scoped to pure `src/lib`
  logic; the project currently has no test runner.
- TDD `src/lib/route-playback.ts`: assert positions at boundary times — before
  `start_time` (at depot), mid first drive, exactly at an arrival, mid service,
  between two stops, mid return leg, and after `end_time` (at depot). Cover the
  single-stop and zero-stop edge cases.
- The Mapbox/React layer is verified manually in the running app (animation plays,
  day switch resets, filter/solo/hover behave, unassigned layer shows when present,
  token-missing guard renders).

## 9. Risks / honesty notes

- Straight-line geometry: the map must not imply turn-by-turn accuracy. Mitigated
  by the disclosure label and by interpolating along the same straight segments the
  solver costed.
- Color collisions beyond ~30 crews: HSL spread keeps colors distinct at current
  fleet size; the filter/solo + labels make any future collision tolerable.
- `end_time` is assumed within a single day (≤ 24:00); solver capacity caps the
  workday well under this, so no multi-day handling is needed.
