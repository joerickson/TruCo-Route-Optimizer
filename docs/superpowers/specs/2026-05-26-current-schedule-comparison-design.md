# Current-Schedule Comparison — Design Spec

**Date:** 2026-05-26
**Status:** Approved (design)
**Scope:** Upload the current (unoptimized) crew schedule, score it on the exact
same yardstick the optimizer uses, and compare it side-by-side against an
optimized run with fleet-level, per-crew, per-property, and capacity findings.

## 1. Goal & scope

Answer the question: **how much of today's plan is waste, and what should change?**
The user uploads their real-world schedule (which crew services which property, on
which day). The system scores it identically to an optimized run and renders a
`/compare` view with four kinds of finding:

- **Fleet-level savings** — total drive hours/miles, total clock-hours, # crews
  effectively used, average utilization: current vs optimized, with deltas.
- **Per-crew rebalancing** — which crews are over/under-loaded today vs optimized.
- **Per-property reassignments** — the concrete change list a dispatcher executes
  (`Property X: Crew A/Tue → Crew B/Thu`), CSV-exportable.
- **Capacity verdict** — does the current plan need more crews than optimized?
  Capacity band classification on both sides.

The comparison is advisory: it recommends, it does not mutate optimized runs.

### Out of scope

- Auto-applying reassignments / editing the live schedule from the compare view.
- Multi-week or seasonal comparison (a single target week is the unit, consistent
  with the rest of the tool — peak summer week is the binding constraint).
- Honoring an explicit dispatcher visit-order from the upload (we TSP-order each
  crew-day; see §3 assumption). Could be a future toggle.
- Crew-size-aware scoring (inherits the fleet-average 2.0 assumption from the
  existing solver).

## 2. Background / current state

- **Optimized side already exists.** An `optimization_runs` row carries
  `crew_utilization`, `total_clock_hours_per_week`, `total_drive_hours_per_week`,
  `total_drive_miles_per_week`, `total_labor_hours_per_week`,
  `capacity_recommendation`, `recommendation_text`, `routes_jsonb.per_day`
  (`CrewDayRoute[]`, each stop carrying `property_id` + `day_of_week` + crew), and
  `unassigned_property_ids`.
- **The schema already holds the current schedule.** `properties.assigned_crew_id`
  and `properties.assigned_day_of_week` exist but are not populated by the current
  Aspire importer (`src/lib/csv-import.ts`).
- **The metric math lives in the solver.** `solver/api/solver_logic.py::solve_day`
  takes a set of properties + a set of crews, builds a Haversine×1.3 @30mph distance
  matrix, solves the route, and extracts `clock_hours` / `drive_hours` /
  `drive_miles` / stops. `solver/api/index.py::run_optimization` orchestrates this
  across weekdays, aggregates `crew_utilization`, classifies capacity
  (`_classify_capacity`), and `_persist` writes the run row back via Supabase REST.
- **Reusable web patterns:** skipped-row tracking in `csv-import.ts` +
  `properties/imports/[importRunId]`; CSV export in `runs/[runId]/export`; the
  optimize fire-and-forget solver call + polling in `optimize/actions.ts`.

The decision (confirmed during brainstorming): score the current schedule with the
**same Python code** (Option A), not a TypeScript re-implementation, so both sides
are guaranteed comparable.

## 3. Architecture & data flow

```
Upload current schedule ──► properties.assigned_crew_id / assigned_day_of_week
        (Aspire columns OR standalone sheet, shared mapping)
                                   │
                                   ▼
   "Score current schedule" action: insert optimization_runs row
        (run_kind='baseline', status='running') ──► call solver mode='evaluate'
                                   │
                                   ▼
   solver run_evaluation(): group props by (assigned_day, assigned_crew),
   single-vehicle TSP per crew-day (capacity relaxed), same aggregation ──► _persist
                                   │
                                   ▼
   /compare?baseline=<id>&optimized=<id>:
       compareSchedules(baseline, optimized)  (pure) ──► four sections + CSV export
```

**Stop-ordering assumption (confirmed):** evaluate mode TSP-optimizes the visit
*order* within each fixed crew-day and **relaxes the per-crew capacity cap** (set
high) so an overloaded crew is scored at its true hours rather than dropping work.
This isolates the **assignment** decision (which crew, which day) from
stop-sequencing skill — the conservative, fair baseline, since the optimizer also
TSP-orders its routes.

## 4. Data model

One migration. Paste-ready SQL must accompany the implementation response per
CLAUDE.md; `supabase db push` is never auto-applied.

```sql
alter table optimization_runs
  add column if not exists run_kind text not null default 'optimized'
    check (run_kind in ('optimized', 'baseline'));

create index if not exists optimization_runs_kind_idx
  on optimization_runs(run_kind, created_at desc);
```

- `run_kind` discriminates baseline vs optimized runs so they coexist in one table
  and the baseline reuses the existing run-detail tabs (list/map/calendar/Coach).
- The optimize page (`/optimize`) and any "runs" listing filter to
  `run_kind='optimized'` so baselines don't masquerade as optimizations; the
  `/compare` selectors filter each side to its kind.
- `properties.assigned_crew_id` / `assigned_day_of_week` already exist — no change.

## 5. Upload paths (`src/lib/schedule-import.ts`)

New module mirroring `csv-import.ts` (shared helpers: `getStr`, skipped-row shape).
Both paths resolve to setting `assigned_crew_id` + `assigned_day_of_week` on
existing properties.

**Shared mapping rules:**
- **Crew match:** by crew `name`, case-insensitive + trimmed → `crews.id`. Built
  from a `Map<normalizedName, crewId>`. Duplicate crew names collapse to the first;
  unmatched name → `SkippedRow` (`reason: "Crew \"X\" not found"`).
- **Day parse:** `parseDayOfWeek` accepts `Monday`/`Mon`/`monday`/`1`..`7`
  (1=Mon..7=Sun) → int. Unparseable → skipped row.
- **Property match:** by `external_id` (Aspire Property ID).

**Path A — Aspire export columns.** Extend the existing import flow so that *when a
crew column and a day column are present*, the row also carries
`assigned_crew_name` + `assigned_day_raw`; the server action resolves them to ids
during upsert. Absent columns → behaves exactly as today (assignments untouched).
Column names: `Crew` (fallback `Assigned Crew`) and `Service Day` (fallback `Day`).

**Path B — standalone schedule sheet (CSV/XLSX).** Keyed by `external_id` → crew +
day only. Properties must already exist (from a prior Aspire import); unknown
`external_id` → `SkippedRow` (`reason: "No property with External ID \"X\""`).
Parsed with the same `xlsx`/`papaparse` machinery as `csv-import.ts`.

**Exports:**
```ts
export interface ScheduleAssignmentRow {
  external_id: string;
  assigned_crew_name: string;
  assigned_day_raw: string;
}
export interface ScheduleImportResult {
  rows: ScheduleAssignmentRow[];
  skipped: SkippedRow[];   // reuse SkippedRow shape from csv-import
}
export function parseScheduleFile(filename: string, buffer: ArrayBuffer): ScheduleImportResult;
export function parseDayOfWeek(v: unknown): number | null;       // 1..7 or null
export function resolveCrewId(name: string, crewsByName: Map<string, string>): string | null;
```

The server action (`src/app/compare/actions.ts`) applies resolved rows to
`properties`, returns `{ applied, skipped }`, then triggers scoring (§6).

## 6. Solver evaluate mode (`solver/api/index.py`)

Selected by a `"mode": "evaluate"` field in the POST body (default `"optimize"`
preserves current behavior). The web action sets `mode` and pre-inserts the
baseline run row, identical to `optimize/actions.ts`.

`run_evaluation(payload) -> dict` (same return shape as `run_optimization`):
- Reuse `_properties_for_solver` (labor→clock via crew-size 2.0) and the
  branches-by-id map.
- Group eligible properties by `(assigned_day_of_week, assigned_crew_id)`.
  Properties with a null crew or null day → `unassigned`.
- For each group: build a one-crew list for that crew (via the same crew→branch
  resolution as `_crews_for_day`) and call
  `solve_day(day, props_for_group, [crew], time_limit_seconds=8)` — single vehicle
  ⇒ pure TSP ordering — but with the crew's `max_clock_hours` raised to a large
  sentinel so capacity never drops a stop (faithfully score overloaded crews).
- Aggregate into `crew_utilization` / totals / `_classify_capacity` /
  `routes_jsonb` with the **same code** `run_optimization` uses (extract the shared
  aggregation into a helper both call, to keep them from drifting).
- `_persist` writes it back to the `run_kind='baseline'` row.

`handler.do_POST` dispatches on `payload.get("mode", "optimize")`.

## 7. Comparison module (`src/lib/schedule-compare.ts`)

Pure, no IO. Reads both runs' persisted fields only.

```ts
export interface FleetDelta {
  clockHours: { current: number; optimized: number; delta: number; pct: number };
  driveHours: { current: number; optimized: number; delta: number; pct: number };
  driveMiles: { current: number; optimized: number; delta: number; pct: number };
  activeCrews: { current: number; optimized: number; delta: number };
  avgUtil: { current: number; optimized: number; delta: number };
}
export interface CrewDelta {
  crewId: string; crewName: string;
  currentClock: number; optimizedClock: number; deltaClock: number;
  currentUtil: number; optimizedUtil: number;
  flag: 'overloaded' | 'underused' | 'ok';   // from current-side band vs optimized
}
export interface PropertyChange {
  propertyId: string; propertyName: string;
  from: { crewName: string | null; day: number | null };
  to:   { crewName: string | null; day: number | null };
  changedCrew: boolean; changedDay: boolean;
}
export interface CoverageNote {
  onlyInCurrent: string[];   // property ids scheduled in current but not optimized
  onlyInOptimized: string[]; // and vice-versa (e.g. current-unassigned)
}
export interface ScheduleComparison {
  fleet: FleetDelta;
  capacity: { currentBand: CapacityRecommendation | null;
              optimizedBand: CapacityRecommendation | null;
              verdict: string };               // plain-language sentence
  crews: CrewDelta[];
  changes: PropertyChange[];                    // only properties that actually moved
  coverage: CoverageNote;
}
export function compareSchedules(baseline: OptimizationRun, optimized: OptimizationRun): ScheduleComparison;
```

Implementation notes:
- Build `property → {crewId, crewName, day}` maps from each run's
  `routes_jsonb.per_day[].stops`. Diff to produce `changes` (only moved
  properties) and `coverage` (set difference of keys).
- `fleet` from the four `total_*` fields + `crew_utilization` (active-crew count =
  crews with `clock_hours > 0`; avgUtil over active crews). `pct` is `delta /
  current` (guard divide-by-zero → 0).
- `crews` keyed by `crew_id`, joining both `crew_utilization` arrays; `flag` from
  the current-side hours against the sustainable bands (`>55` overloaded, `<40`
  underused, else ok).
- `capacity.verdict` compares active-crew counts and bands into one sentence
  (e.g. "Current plan effectively uses 31 crews to cover what the optimizer fits in
  27 — 4 crews of slack.").

## 8. `/compare` page (`src/app/compare/`)

`page.tsx` (server component):
- Reads `?baseline=<id>&optimized=<id>` (defaults: most recent completed run of each
  kind). Fetches both runs; if either missing, render the selectors + an empty
  state.
- Joins crew names as needed (runs already store `crew_name` in utilization +
  routes, so minimal extra IO).
- Calls `compareSchedules` and renders sections:
  1. **Fleet summary** card — side-by-side totals + deltas + % saved.
  2. **Capacity verdict** card — both bands + the verdict sentence.
  3. **Per-crew** table — current vs optimized hours/util, delta, over/under flag.
  4. **Per-property change list** — `From → To`, sortable, with **CSV export**
     (new `src/app/compare/export/route.ts`, mirroring `runs/[runId]/export`).
  5. **Coverage note** — small banner if either set has properties the other lacks.
- A **"Run mismatch" warning** if the two runs' `target_week_start_date` or active
  property sets differ materially (deltas still render, flagged as approximate).

Components: `compare-selectors.tsx` (client; two run dropdowns that update the query
string), `fleet-summary.tsx`, `crew-deltas.tsx`, `property-changes.tsx` (all
presentational server components).

**Upload + score entry point:** a `compare/upload-schedule.tsx` client form (Path B
standalone sheet) posting to `compare/actions.ts::uploadAndScoreSchedule`, which
applies assignments, inserts the `run_kind='baseline'` run, fires the solver in
evaluate mode (fire-and-forget + poll, same as optimize), and redirects to
`/compare?baseline=<newId>`. The Aspire-column path (A) rides the existing
properties import; a short note on the compare page links there.

## 9. Testing

vitest:
- `schedule-import.ts`: crew-name match (case/space-insensitive), `parseDayOfWeek`
  variants (`Monday`/`Mon`/`3`/garbage→null), unmatched-crew skip, unknown
  `external_id` skip, mixed valid+skipped file.
- `schedule-compare.ts`: fleet deltas + pct (incl. divide-by-zero guard), per-crew
  over/under/ok flags at band edges, per-property diff (moved-crew, moved-day,
  unchanged excluded, only-in-one → coverage), capacity verdict sentence, empty/
  identical runs → zero deltas + no changes.

Python check (script-level, matching repo style): `run_evaluation` groups by
crew+day, an overloaded crew keeps all its stops (capacity relaxed, none dropped),
properties missing crew/day land in `unassigned`, aggregation matches
`run_optimization`'s shared helper.

Page wiring, selectors, and CSV export verified manually.

## 10. Risks / notes

- **Pairing fairness:** a meaningful comparison needs both runs over the same
  property set + week. The page warns on mismatch and the `coverage` note surfaces
  set differences; deltas are labeled approximate when sets differ.
- **Stale assignments:** the current schedule lives on `properties` globally (one
  real-world schedule at a time). Re-uploading overwrites it; scoring captures a
  point-in-time baseline run, so old baselines remain valid snapshots.
- **Crew matching by name** is the only join key (the `crews` table has no external
  id). Renamed/duplicate crews surface as skipped rows rather than silent
  mis-assignment.
- **No new dependencies or infra** beyond the one migration: a solver code path, two
  `src/lib` modules, a page, two server actions, and a CSV export route.
- **Shared aggregation:** extracting the `crew_utilization`/totals aggregation into a
  helper used by both `run_optimization` and `run_evaluation` is load-bearing for
  comparability — do it as part of this work rather than copy-pasting.
