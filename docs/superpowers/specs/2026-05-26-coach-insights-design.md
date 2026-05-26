# Coach — Deterministic Insights Advisor (C1) — Design Spec

**Date:** 2026-05-26
**Status:** Approved (design)
**Scope:** A rule-based "coach" that turns a completed optimization run into a
prioritized list of plain-language findings, rendered on a new Coach tab.

This is **Feature C1** of the coach work. The conversational **LLM chat coach
(C2)** is a separate, later spec → plan → build cycle and is explicitly NOT in
this spec. C1's computed insights are intended to later serve as grounding context
for C2.

## 1. Goal & scope

Add a **Coach** tab to `/runs/[runId]` (completed run) that surfaces actionable,
deterministic findings about the run across four themes:

- **Idle crews & days** — crews unused all week; crew-days available but unassigned.
- **Utilization** — over-band crews (`>60`, `55–60`), under-provisioned (`<40`),
  fleet average, and busiest-vs-idlest spread (rebalancing opportunity).
- **Drive time** — crews spending a high share of clock-time driving; fleet total
  drive hours + miles/week.
- **Unassigned & day balance** — properties the solver could not schedule (count +
  labor-hours), and weekday load imbalance.

Findings read like coaching (plain language, prioritized by severity). The view is
advisory only — it recommends, it does not change assignments.

### Out of scope

- The **LLM chat coach (C2)** — separate cycle (needs AI SDK, an
  `ANTHROPIC_API_KEY` in the Coolify web env, a streaming endpoint + chat UI, cost
  controls, and a data-privacy decision).
- Cross-run / portfolio-level insights (a run is the unit of analysis).
- Applying changes / editing assignments.

## 2. Background / current state

A completed `optimization_runs` row already carries everything the rules need:
`crew_utilization` (per-crew `clock_hours`, `drive_hours`, `util_pct`,
`props_assigned`), the four totals (`total_clock_hours_per_week`,
`total_labor_hours_per_week`, `total_drive_hours_per_week`,
`total_drive_miles_per_week`), `capacity_recommendation`, `recommendation_text`,
`routes_jsonb.per_day` (`CrewDayRoute[]`), and `unassigned_property_ids`
(`string[] | null` — null on runs created before that column shipped).

Reusable pieces:
- `src/lib/calendar-grid.ts` exports `buildCalendarGrid(routes, crewUtil, crewsById)`
  and `CrewAvailability` (`{ works: Record<1..5, boolean>; maxHoursPerDay }`). The
  coach reuses this to count idle crew-days (DRY) and the `CrewAvailability` type
  for the crews join.
- `src/app/runs/[runId]/page.tsx` already does the crews-availability join and the
  unassigned-property lookup pattern (for the calendar and routes map). The coach
  branch follows the same shape.
- Sustainable bands (clock-hrs/crew/week): `<40` over-provisioned · `40–50`
  sustainable · `50–55` tight · `55–60` add 1–2 · `>60` unsustainable.

No AI SDK is installed; C1 adds **no new dependencies or infra**.

## 3. Architecture & data flow

1. Server component `runs/[runId]/page.tsx` gains a `view='coach'` branch (the
   `view` union becomes `'list'|'map'|'calendar'|'coach'`).
2. `RunCoachView({ run })` (async server component) gathers pure inputs:
   - `crewUtil = run.crew_utilization ?? []`, `routes = run.routes_jsonb?.per_day ?? []`.
   - Join `crews` (same query as the calendar) → `crewsById: Record<string, CrewAvailability>`.
   - Resolve unassigned labor-hours: if `run.unassigned_property_ids` is non-empty,
     query `properties` for those ids (`est_labor_hours`) and sum; else `{ count: 0,
     laborHours: 0 }`.
   - Calls `buildInsights(input)` and renders `<RunCoach insights={...}
     headline={run.recommendation_text} />`.
3. `buildInsights` (pure, no IO) computes the findings. `RunCoach` renders them.

## 4. Insight engine (`src/lib/coach-insights.ts`)

Pure (no React/Supabase/IO). Reuses `buildCalendarGrid` + `CrewAvailability` from
`./calendar-grid`; reads `CrewUtilization`/`CrewDayRoute` from `./types`.

```ts
export type Severity = 'critical' | 'warning' | 'info' | 'good';
export type InsightCategory = 'idle' | 'utilization' | 'drive' | 'unassigned' | 'balance' | 'summary';

export interface Insight {
  id: string;          // stable key, e.g. 'crews-idle-all-week'
  severity: Severity;
  category: InsightCategory;
  title: string;       // short headline
  detail: string;      // plain-language explanation + recommended action
}

export interface InsightsInput {
  crewUtilization: CrewUtilization[];
  routes: CrewDayRoute[];
  crewsById: Record<string, CrewAvailability>;
  totals: { clockHours: number; driveHours: number; driveMiles: number; laborHours: number };
  unassigned: { count: number; laborHours: number };
}

export function buildInsights(input: InsightsInput): Insight[];
```

**Named thresholds** (module constants):
`UNSUSTAINABLE_HRS = 60`, `ADD_CREW_HRS = 55`, `OVER_PROVISIONED_HRS = 40`,
`DRIVE_SHARE_WARN = 0.30`, `DAY_IMBALANCE_RATIO = 1.5`, `SPREAD_HRS = 20`
(busiest-minus-idlest-active gap that flags rebalancing).

**Rules** (each yields zero or more insights; `id`s are stable):
- `crews-idle-all-week` (warning) — crews with `clock_hours === 0`; lists names,
  recommends redeploy / treat as spare capacity. Silent if none.
- `idle-crew-days` (info) — count of `idle` cells from `buildCalendarGrid(routes,
  crewUtilization, crewsById)`; names a sample. Silent if zero.
- `crews-unsustainable` (critical) — crews `> 60`h; lists name+hours. Silent if none.
- `crews-tight` (warning) — crews `> 55` and `<= 60`h. Silent if none.
- `crews-over-provisioned` (info) — active crews (`> 0`h) `< 40`h. Silent if none.
- `fleet-utilization` (info|good) — average clock-hrs across active crews + the
  capacity band label; `good` when average is in `40–55`, else `info`.
- `crew-spread` (info) — when (busiest active − idlest active) `>= SPREAD_HRS`,
  flags a rebalancing opportunity with both figures. Silent otherwise.
- `crew-drive-share` (warning) — crews whose `drive_hours / clock_hours >
  DRIVE_SHARE_WARN`; lists name + share. Silent if none.
- `fleet-drive` (info) — total drive hours + miles/week.
- `unassigned-properties` (critical) — when `unassigned.count > 0`: count +
  `~laborHours` person-hours, recommends add capacity / relax constraints. Silent
  if zero.
- `day-imbalance` (info) — per-weekday total clock from `routes`; when
  `max / min >= DAY_IMBALANCE_RATIO` (min over days with any load), names the
  heaviest/lightest day + hours. Silent if fewer than two loaded days.
- `all-clear` (good) — emitted only when no `critical`/`warning` insights fired,
  affirming a healthy run.

Output sorted by severity rank `critical < warning < info < good` (criticals
first), stable within a rank by insertion order.

## 5. Coach view (`src/app/runs/[runId]/run-coach.tsx`)

A presentational **server** component (no `'use client'`):

- Props: `{ insights: Insight[]; headline: string | null }`.
- Top: a "Coach" card title; if `headline` (the solver's `recommendation_text`),
  show it as the lead sentence.
- A list of finding cards, each: a severity badge (critical→`destructive`,
  warning→`warning`, info→`secondary`, good→`success`), the `title` (bold), and the
  `detail` beneath. Ordered as returned by `buildInsights`.
- If `insights` is empty (defensive — `all-clear` normally prevents this), show a
  single neutral "No findings" card.
- A short footer note: findings are heuristic guidance from this run's results.

## 6. Wiring

- `run-view-toggle.tsx`: extend `VIEWS` + the `current` union to include
  `{ value: 'coach', label: 'Coach' }`.
- `page.tsx`: widen `view` parse to include `'coach'`; add the `coach` branch
  (`<RunCoachView run={run} />`) to the completed-run conditional; add the
  `RunCoachView` async server component described in §3.

## 7. Testing

vitest on `src/lib/coach-insights.ts`:
- Each rule fires at/over its threshold and stays silent under it:
  `crews-unsustainable` at 60.1 (not 60), `crews-tight` at 56 (not 55),
  `crews-over-provisioned` at 39 (not 40, and not for 0-hr crews — those are
  `crews-idle-all-week`), `crew-drive-share` at 31% (not 29%), `day-imbalance` at
  ratio 1.6 (not 1.4), `crew-spread` at gap 20 (not 19).
- `unassigned-properties` fires only when count > 0; `all-clear` appears only when
  no critical/warning fired; severity sort order; idle-day count via
  `buildCalendarGrid` reuse.
- Empty/healthy run → exactly the positive findings (`fleet-utilization` good +
  `all-clear`).

The `RunCoach` table/card render and the page wiring are verified manually.

## 8. Risks / notes

- **Current-schedule caveat (inherited):** idle-day detection uses the live `crews`
  availability join, same as the calendar; a deleted/changed crew yields the same
  `unknown`/idle behavior. Acceptable; the idle-days insight phrases counts as
  approximate.
- **Pre-migration runs:** `unassigned_property_ids = null` → `{ count: 0,
  laborHours: 0 }`; the `unassigned-properties` insight simply stays silent.
- **No new dependencies or infra**; purely additive web-app work reading existing
  run fields + a `crews` and a `properties` read.
- Thresholds are deliberately simple and centralized as constants for easy tuning.
