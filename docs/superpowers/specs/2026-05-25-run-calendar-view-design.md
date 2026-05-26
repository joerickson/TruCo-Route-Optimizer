# Run Calendar / Week View — Design Spec

**Date:** 2026-05-25
**Status:** Approved (design)
**Scope:** A week-at-a-glance calendar (crews × Mon–Fri) for a completed
optimization run, surfacing idle crews and assigned-vs-unassigned crews.

This is **Feature B** of three (A: property map filters — shipped · B: calendar
view — this spec · C: coach — later). B does not depend on C.

## 1. Goal & scope

Add a **Calendar** tab to `/runs/[runId]` (a completed run) that renders a
crews × weekday grid so the user can see, at a glance:

- each crew's per-day load (clock-hours + stop count) across the week,
- **idle** cells — a crew is available that day but has no assignment (wasted
  capacity),
- **off** cells — the crew is not scheduled that day,
- crews that are **fully idle** all week (unassigned crews),
- a weekly total per crew, colored by the sustainable-workload bands.

The solver assigns Mon–Fri only, so the grid has exactly five day columns.

### Out of scope

- Editing / drag-drop reassignment.
- Multi-week views; weekend columns (the solver never assigns Sat/Sun).
- A historical availability snapshot — the grid uses crews' **current**
  `works_*` schedule (labeled with a caveat), not the schedule as it was when the
  run executed.
- The coach (Feature C).

## 2. Background / current state

- `optimization_runs.routes_jsonb.per_day` is `CrewDayRoute[]`. Each entry has
  `crew_id`, `crew_name`, `day_of_week` (1=Mon..5=Fri), `clock_hours`, and
  `stops[]`. One entry per crew-day that received work.
- `optimization_runs.crew_utilization` is built for **every** crew in the run
  (including zero-hour crews): `{ crew_id, crew_name, clock_hours, drive_hours,
  work_hours, util_pct, props_assigned, drive_miles }`. This is the authoritative
  row source (it already lists fully-idle crews with `clock_hours = 0`).
- The run does **not** store per-crew day-availability. `works_monday..works_sunday`
  and `max_clock_hours_per_day` live only on the `crews` table, so the grid must
  join `crews` by crew id to classify idle-vs-off.
- The run-detail page `src/app/runs/[runId]/page.tsx` already supports
  `?view=list|map` via `RunViewToggle`; the routes map is a server-prepped,
  lazy-loaded component. The calendar follows the same `?view=` pattern but needs
  no Mapbox / lazy loading (it is a static table).
- Sustainable-workload bands (clock-hrs/crew/week), per CLAUDE.md and the solver's
  `_classify_capacity`: `<40` over-provisioned · `40–50` sustainable · `50–55`
  tight · `55–60` add 1–2 crews · `>60` unsustainable.

## 3. Architecture & data flow

Server component `runs/[runId]/page.tsx`:

1. `view` parsing extended to `'list' | 'map' | 'calendar'` (default `'list'`).
2. For `view === 'calendar'` on a completed run:
   - `routes = run.routes_jsonb?.per_day ?? []`
   - `crewUtil = run.crew_utilization ?? []`
   - Join current crews: query `crews` for `id, works_monday, works_tuesday,
     works_wednesday, works_thursday, works_friday, max_clock_hours_per_day`
     where `id in` the crew ids appearing in `crewUtil` → `crewsById`.
   - `grid = buildCalendarGrid(routes, crewUtil, crewsById)`.
   - Render `<RunCalendar grid={grid} />`.
3. The `RunViewToggle` gains a Calendar option (shown only for completed runs, as
   today).

`buildCalendarGrid` and its helpers are pure (no React/Supabase) and unit-tested.
`RunCalendar` is a presentational **server** component (no client JS — a colored
table).

## 4. Pure module (`src/lib/calendar-grid.ts`)

```ts
export type CapacityBand =
  | 'over_provisioned' | 'sufficient' | 'tight' | 'add_crew' | 'unsustainable';
export type CellKind = 'assigned' | 'idle' | 'off' | 'unknown';

export interface CalendarCell {
  kind: CellKind;
  clockHours?: number; // assigned only
  stops?: number;      // assigned only
  fillPct?: number;    // assigned only: clockHours / maxHoursPerDay, clamped 0..1
}

export interface CalendarRow {
  crewId: string;
  crewName: string;
  weeklyClockHours: number;
  utilPct: number;
  band: CapacityBand;
  fullyIdle: boolean;        // weeklyClockHours === 0
  days: Record<number, CalendarCell>; // keys 1..5
}

export interface CrewAvailability {
  works: Record<number, boolean>;     // keys 1..5
  maxHoursPerDay: number;
}

// Bands keyed on weekly clock-hours per crew (matches solver _classify_capacity).
export function capacityBand(weeklyClockHours: number): CapacityBand;

// Build one row per crew in crewUtil. Cell classification per weekday 1..5:
//  - assigned: a route exists for (crewId, day) -> clockHours, stops, fillPct
//  - idle:     no route but crew works that day (availability known & true)
//  - off:      availability known & false
//  - unknown:  crew not in crewsById (deleted since the run)
// Rows sorted: active crews by weeklyClockHours desc, then fully-idle crews last.
export function buildCalendarGrid(
  routes: CrewDayRoute[],
  crewUtil: CrewUtilization[],
  crewsById: Record<string, CrewAvailability>
): CalendarRow[];
```

`CrewDayRoute` and `CrewUtilization` come from `@/lib/types`.

**Band thresholds** (inclusive upper bounds, matching the solver):
`<40 → over_provisioned`; `>=40 && <=50 → sufficient`; `>50 && <=55 → tight`;
`>55 && <=60 → add_crew`; `>60 → unsustainable`.

## 5. Calendar component (`src/app/runs/[runId]/run-calendar.tsx`)

A server component taking `{ grid: CalendarRow[] }`:

- A table: first column crew name (with an "idle all week" badge when
  `fullyIdle`), then Mon–Fri, then a **Week** column.
- **Assigned cell:** `H.h` on top, `N stops` beneath; background shaded by
  `fillPct` (a single hue ramp). 
- **Idle cell:** amber background, label "idle".
- **Off cell:** muted/empty.
- **Unknown cell:** empty (no styling).
- **Week column:** `H.h` + `util%`, background = band color
  (over_provisioned/sufficient/tight/add_crew/unsustainable → distinct colors).
- Above the table: a one-line summary — "`N` of `M` crews idle all week" — and the
  caveat: *"Availability reflects crews' current schedule; may differ from when
  this run was generated."*
- Below: a legend (Assigned / Idle / Off swatches + the five band colors).
- Empty state: if `grid` is empty, "No crews in this run."

No interactivity, so no `'use client'`.

## 6. Toggle + page wiring

- `run-view-toggle.tsx`: extend to three links — List / Map / Calendar — each to
  `?view=list|map|calendar`, preserving the existing active-state styling and
  `aria-current`.
- `runs/[runId]/page.tsx`: parse the third view; add a `RunCalendar` branch
  parallel to the existing `RunMap`/`CompletedRun` branches; perform the crews
  join only in the calendar branch.

## 7. Testing

vitest on `src/lib/calendar-grid.ts`:
- `capacityBand` at boundaries: 39.9→over, 40 & 50→sufficient, 50.1 & 55→tight,
  55.1 & 60→add_crew, 60.1→unsustainable.
- Cell classification: assigned (route present → hours/stops/fillPct, fillPct
  clamped when hours > maxHoursPerDay), idle (no route + works true), off (no
  route + works false), unknown (crew absent from crewsById).
- `fullyIdle` true when weeklyClockHours 0; row sort order (active desc, idle
  last).
- `buildCalendarGrid` produces one row per crewUtil entry with days 1..5 keyed.

The table render is verified manually (assigned/idle/off shading, band colors,
idle-all-week badge + summary, caveat, empty state).

## 8. Risks / notes

- **Current-schedule caveat:** availability comes from the live `crews` table.
  A crew whose schedule changed since the run, or was deleted, yields
  off/idle/unknown that may not reflect run-time reality. Surfaced via the caveat
  label and the `unknown` fallback; acceptable for a planning tool.
- **No solver/DB changes**; purely additive web-app work reading existing run
  fields plus a `crews` read.
- Per-day fill uses `max_clock_hours_per_day` (default 8 when absent); the weekly
  band uses raw weekly clock-hours, independent of per-day max.
