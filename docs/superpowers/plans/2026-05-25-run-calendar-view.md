# Run Calendar / Week View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Calendar tab to a completed run's page showing a crews × Mon–Fri grid with per-day hours/stops, idle vs off cells, weekly totals colored by capacity band, and fully-idle crews flagged.

**Architecture:** Pure, tested grid-builder in `src/lib/calendar-grid.ts`; a presentational **server** component `run-calendar.tsx` (static colored table, no client JS); the run-view toggle gains a third option; `page.tsx` adds a calendar branch that joins the current `crews` table for availability and builds the grid.

**Tech Stack:** Next.js 14 App Router (server components), TypeScript, Supabase, vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-run-calendar-view-design.md`

---

## File Structure

New:
- `src/lib/calendar-grid.ts` — pure: `capacityBand`, `buildCalendarGrid`, types.
- `src/lib/calendar-grid.test.ts` — vitest tests.
- `src/app/runs/[runId]/run-calendar.tsx` — presentational server component (the grid table).

Modified:
- `src/app/runs/[runId]/run-view-toggle.tsx` — add Calendar (List / Map / Calendar).
- `src/app/runs/[runId]/page.tsx` — parse `view='calendar'`; add `RunCalendarView` server component (crews join + `buildCalendarGrid`).

---

## Task 1: Pure grid-builder module — TDD

**Files:**
- Create: `src/lib/calendar-grid.ts`
- Test: `src/lib/calendar-grid.test.ts`

- [ ] **Step 1: Write the failing tests** — `src/lib/calendar-grid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { capacityBand, buildCalendarGrid, type CrewAvailability } from './calendar-grid';
import type { CrewDayRoute, CrewUtilization } from './types';

function route(crew_id: string, day: number, clock_hours: number, nStops: number): CrewDayRoute {
  return {
    crew_id,
    crew_name: crew_id,
    day_of_week: day,
    branch_id: 'b1',
    start_time: '07:00',
    end_time: '15:00',
    clock_hours,
    drive_hours: 1,
    drive_miles: 10,
    stops: Array.from({ length: nStops }, (_, i) => ({
      property_id: `p${i}`,
      property_name: `P${i}`,
      address: 'x',
      lat: 0,
      lng: 0,
      arrival_time: '08:00',
      service_minutes: 30,
      drive_minutes_to: 10,
    })),
  };
}

function util(crew_id: string, clock_hours: number, util_pct: number): CrewUtilization {
  return {
    crew_id,
    crew_name: crew_id,
    clock_hours,
    drive_hours: 0,
    work_hours: clock_hours,
    util_pct,
    props_assigned: 0,
    drive_miles: 0,
  };
}

const worksAll: CrewAvailability = { works: { 1: true, 2: true, 3: true, 4: true, 5: true }, maxHoursPerDay: 8 };

describe('capacityBand', () => {
  it('classifies by weekly clock-hours at the band boundaries', () => {
    expect(capacityBand(39.9)).toBe('over_provisioned');
    expect(capacityBand(40)).toBe('sufficient');
    expect(capacityBand(50)).toBe('sufficient');
    expect(capacityBand(50.1)).toBe('tight');
    expect(capacityBand(55)).toBe('tight');
    expect(capacityBand(55.1)).toBe('add_crew');
    expect(capacityBand(60)).toBe('add_crew');
    expect(capacityBand(60.1)).toBe('unsustainable');
  });
});

describe('buildCalendarGrid', () => {
  it('classifies assigned / idle / off cells', () => {
    const routes = [route('c1', 1, 6, 3)];
    const crewUtil = [util('c1', 6, 30)];
    const crewsById: Record<string, CrewAvailability> = {
      c1: { works: { 1: true, 2: true, 3: false, 4: true, 5: true }, maxHoursPerDay: 8 },
    };
    const [row] = buildCalendarGrid(routes, crewUtil, crewsById);
    expect(row.days[1]).toEqual({ kind: 'assigned', clockHours: 6, stops: 3, fillPct: 0.75 });
    expect(row.days[2]).toEqual({ kind: 'idle' }); // works, no route
    expect(row.days[3]).toEqual({ kind: 'off' }); // not scheduled
  });

  it('marks cells unknown when the crew is missing from crewsById', () => {
    const [row] = buildCalendarGrid([], [util('c9', 0, 0)], {});
    expect(row.days[1]).toEqual({ kind: 'unknown' });
    expect(row.fullyIdle).toBe(true);
  });

  it('clamps fillPct when hours exceed max/day', () => {
    const routes = [route('c1', 1, 10, 1)];
    const [row] = buildCalendarGrid(routes, [util('c1', 10, 50)], { c1: worksAll });
    expect(row.days[1].fillPct).toBe(1);
  });

  it('sorts active crews by weekly hours desc, fully-idle last', () => {
    const crewUtil = [util('idle', 0, 0), util('low', 20, 40), util('high', 45, 90)];
    const crewsById = { idle: worksAll, low: worksAll, high: worksAll };
    const rows = buildCalendarGrid([], crewUtil, crewsById);
    expect(rows.map((r) => r.crewId)).toEqual(['high', 'low', 'idle']);
    expect(rows[2].fullyIdle).toBe(true);
  });

  it('produces one row per crewUtil entry with days 1..5 keyed', () => {
    const rows = buildCalendarGrid([], [util('c1', 10, 20)], { c1: worksAll });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].days).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run tests, verify they FAIL**

Run: `npm test`
Expected: FAIL — module/exports do not exist yet.

- [ ] **Step 3: Implement `src/lib/calendar-grid.ts`**

```ts
// Pure grid-builder for the run calendar/week view. No React, no Supabase, no IO.
import type { CrewDayRoute, CrewUtilization } from './types';

export type CapacityBand = 'over_provisioned' | 'sufficient' | 'tight' | 'add_crew' | 'unsustainable';
export type CellKind = 'assigned' | 'idle' | 'off' | 'unknown';

export interface CalendarCell {
  kind: CellKind;
  clockHours?: number; // assigned only
  stops?: number; // assigned only
  fillPct?: number; // assigned only: clockHours / maxHoursPerDay, clamped 0..1
}

export interface CalendarRow {
  crewId: string;
  crewName: string;
  weeklyClockHours: number;
  utilPct: number;
  band: CapacityBand;
  fullyIdle: boolean; // weeklyClockHours === 0
  days: Record<number, CalendarCell>; // keys 1..5
}

export interface CrewAvailability {
  works: Record<number, boolean>; // keys 1..5
  maxHoursPerDay: number;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

// Bands keyed on weekly clock-hours per crew (matches solver _classify_capacity).
export function capacityBand(weeklyClockHours: number): CapacityBand {
  if (weeklyClockHours < 40) return 'over_provisioned';
  if (weeklyClockHours <= 50) return 'sufficient';
  if (weeklyClockHours <= 55) return 'tight';
  if (weeklyClockHours <= 60) return 'add_crew';
  return 'unsustainable';
}

export function buildCalendarGrid(
  routes: CrewDayRoute[],
  crewUtil: CrewUtilization[],
  crewsById: Record<string, CrewAvailability>
): CalendarRow[] {
  const routeByCrewDay = new Map<string, CrewDayRoute>();
  for (const r of routes) {
    routeByCrewDay.set(`${r.crew_id}:${r.day_of_week}`, r);
  }

  const rows: CalendarRow[] = crewUtil.map((cu) => {
    const avail = crewsById[cu.crew_id];
    const days: Record<number, CalendarCell> = {};
    for (const d of WEEKDAYS) {
      const route = routeByCrewDay.get(`${cu.crew_id}:${d}`);
      if (route) {
        const maxPerDay = avail?.maxHoursPerDay ?? 8;
        const fillPct = maxPerDay > 0 ? Math.min(1, route.clock_hours / maxPerDay) : 0;
        days[d] = { kind: 'assigned', clockHours: route.clock_hours, stops: route.stops.length, fillPct };
      } else if (!avail) {
        days[d] = { kind: 'unknown' };
      } else if (avail.works[d]) {
        days[d] = { kind: 'idle' };
      } else {
        days[d] = { kind: 'off' };
      }
    }
    return {
      crewId: cu.crew_id,
      crewName: cu.crew_name,
      weeklyClockHours: cu.clock_hours,
      utilPct: cu.util_pct,
      band: capacityBand(cu.clock_hours),
      fullyIdle: cu.clock_hours === 0,
      days,
    };
  });

  rows.sort((a, b) => {
    if (a.fullyIdle !== b.fullyIdle) return a.fullyIdle ? 1 : -1;
    if (b.weeklyClockHours !== a.weeklyClockHours) return b.weeklyClockHours - a.weeklyClockHours;
    return a.crewName.localeCompare(b.crewName);
  });

  return rows;
}
```

- [ ] **Step 4: Run tests, verify they PASS**

Run: `npm test`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-grid.ts src/lib/calendar-grid.test.ts
git commit -m "feat: pure calendar-grid builder (cell classification, capacity bands)"
```

---

## Task 2: Calendar table component

**Files:**
- Create: `src/app/runs/[runId]/run-calendar.tsx`

- [ ] **Step 1: Create `src/app/runs/[runId]/run-calendar.tsx`**

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { dayName } from '@/lib/utils';
import type { CalendarRow, CalendarCell, CapacityBand } from '@/lib/calendar-grid';

const WEEKDAYS = [1, 2, 3, 4, 5];

const BAND_LABEL: Record<CapacityBand, string> = {
  over_provisioned: 'Over-provisioned',
  sufficient: 'Sustainable',
  tight: 'Tight',
  add_crew: 'Add 1-2 crews',
  unsustainable: 'Unsustainable',
};

const BAND_CLASS: Record<CapacityBand, string> = {
  over_provisioned: 'bg-slate-100 text-slate-700',
  sufficient: 'bg-emerald-100 text-emerald-800',
  tight: 'bg-yellow-100 text-yellow-800',
  add_crew: 'bg-orange-100 text-orange-800',
  unsustainable: 'bg-red-100 text-red-800',
};

export function RunCalendar({ grid }: { grid: CalendarRow[] }) {
  if (grid.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Crew week</CardTitle>
          <CardDescription>No crews in this run.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const idleCount = grid.filter((r) => r.fullyIdle).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crew week</CardTitle>
        <CardDescription>
          {idleCount} of {grid.length} crews idle all week · Availability reflects crews&rsquo; current schedule; may differ
          from when this run was generated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium">Crew</th>
                {WEEKDAYS.map((d) => (
                  <th key={d} className="p-2 text-center font-medium">
                    {dayName(d)}
                  </th>
                ))}
                <th className="p-2 text-right font-medium">Week</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.crewId} className="border-t">
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.crewName}</span>
                      {row.fullyIdle && <Badge variant="warning">idle all week</Badge>}
                    </div>
                  </td>
                  {WEEKDAYS.map((d) => (
                    <DayCell key={d} cell={row.days[d]} />
                  ))}
                  <td className="p-2 text-right">
                    <span className={`inline-block rounded px-2 py-0.5 ${BAND_CLASS[row.band]}`}>
                      {row.weeklyClockHours.toFixed(1)}h · {row.utilPct.toFixed(0)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <LegendSwatch className="bg-emerald-300" label="Assigned (shaded by fill)" />
          <LegendSwatch className="bg-amber-200" label="Idle (available, unused)" />
          <LegendSwatch className="bg-muted" label="Off (not scheduled)" />
          <span className="ml-2">Week band:</span>
          {(Object.keys(BAND_LABEL) as CapacityBand[]).map((b) => (
            <span key={b} className={`rounded px-1.5 py-0.5 ${BAND_CLASS[b]}`}>
              {BAND_LABEL[b]}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DayCell({ cell }: { cell: CalendarCell }) {
  if (cell.kind === 'assigned') {
    const opacity = 0.15 + 0.85 * (cell.fillPct ?? 0);
    return (
      <td className="p-1 text-center">
        <div className="rounded px-1 py-1" style={{ backgroundColor: `rgba(16, 185, 129, ${opacity})` }}>
          <div className="font-medium">{(cell.clockHours ?? 0).toFixed(1)}h</div>
          <div className="text-xs text-slate-700">{cell.stops ?? 0} stops</div>
        </div>
      </td>
    );
  }
  if (cell.kind === 'idle') {
    return (
      <td className="p-1 text-center">
        <div className="rounded bg-amber-200 px-1 py-1 text-xs font-medium text-amber-900">idle</div>
      </td>
    );
  }
  if (cell.kind === 'off') {
    return (
      <td className="p-1 text-center">
        <div className="rounded bg-muted px-1 py-1 text-xs text-muted-foreground">&mdash;</div>
      </td>
    );
  }
  return <td className="p-1 text-center text-xs text-muted-foreground">&middot;</td>;
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded ${className}`} />
      {label}
    </span>
  );
}
```

(Apostrophes/dashes use HTML entities `&rsquo;`, `&mdash;`, `&middot;` to satisfy the no-unescaped-apostrophe rule.)

- [ ] **Step 2: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: pass. (Not imported anywhere yet — wired in Task 3. The `Badge` `warning` variant is already used elsewhere in this folder, so it exists.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/runs/[runId]/run-calendar.tsx"
git commit -m "feat: run calendar week-grid component"
```

---

## Task 3: Toggle + page wiring

**Files:**
- Modify: `src/app/runs/[runId]/run-view-toggle.tsx` (full replacement)
- Modify: `src/app/runs/[runId]/page.tsx`

- [ ] **Step 1: Replace `src/app/runs/[runId]/run-view-toggle.tsx` entirely**

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';

const VIEWS: Array<{ value: 'list' | 'map' | 'calendar'; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'map', label: 'Map' },
  { value: 'calendar', label: 'Calendar' },
];

export function RunViewToggle({
  runId,
  current,
}: {
  runId: string;
  current: 'list' | 'map' | 'calendar';
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {VIEWS.map((v) => (
        <Link
          key={v.value}
          href={`/runs/${runId}?view=${v.value}`}
          aria-current={current === v.value ? 'page' : undefined}
          className={cn(
            'rounded px-3 py-1.5 transition-colors',
            current === v.value
              ? 'bg-secondary font-medium text-secondary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: `page.tsx` — add imports**

After the existing line `import { RoutesMapLoader } from './routes-map-loader';` add:
```tsx
import { RunCalendar } from './run-calendar';
import { buildCalendarGrid, type CrewAvailability } from '@/lib/calendar-grid';
```

- [ ] **Step 3: `page.tsx` — widen the `view` parse**

Find:
```tsx
  const view: 'list' | 'map' = searchParams.view === 'map' ? 'map' : 'list';
```
Replace with:
```tsx
  const view: 'list' | 'map' | 'calendar' =
    searchParams.view === 'map' ? 'map' : searchParams.view === 'calendar' ? 'calendar' : 'list';
```

- [ ] **Step 4: `page.tsx` — add the calendar branch in the completed-run render**

Find:
```tsx
      {run.status === 'completed' &&
        (view === 'map' ? <RunMap run={run} /> : <CompletedRun run={run} />)}
```
Replace with:
```tsx
      {run.status === 'completed' &&
        (view === 'map' ? (
          <RunMap run={run} />
        ) : view === 'calendar' ? (
          <RunCalendarView run={run} />
        ) : (
          <CompletedRun run={run} />
        ))}
```

- [ ] **Step 5: `page.tsx` — add the `RunCalendarView` server component**

Add this function right after the existing `async function RunMap({ run }: { run: OptimizationRun }) { ... }` function (i.e., as a sibling async component):
```tsx
async function RunCalendarView({ run }: { run: OptimizationRun }) {
  const supabase = getServerClient();
  const routes: CrewDayRoute[] = run.routes_jsonb?.per_day ?? [];
  const crewUtil = run.crew_utilization ?? [];
  const crewIds = crewUtil.map((c) => c.crew_id);

  const crewsById: Record<string, CrewAvailability> = {};
  if (crewIds.length > 0) {
    const { data: crewRows } = await supabase
      .from('crews')
      .select(
        'id, works_monday, works_tuesday, works_wednesday, works_thursday, works_friday, max_clock_hours_per_day'
      )
      .in('id', crewIds);
    for (const c of (crewRows ?? []) as Array<{
      id: string;
      works_monday: boolean;
      works_tuesday: boolean;
      works_wednesday: boolean;
      works_thursday: boolean;
      works_friday: boolean;
      max_clock_hours_per_day: number | string | null;
    }>) {
      crewsById[c.id] = {
        works: {
          1: !!c.works_monday,
          2: !!c.works_tuesday,
          3: !!c.works_wednesday,
          4: !!c.works_thursday,
          5: !!c.works_friday,
        },
        maxHoursPerDay: Number(c.max_clock_hours_per_day ?? 8) || 8,
      };
    }
  }

  const grid = buildCalendarGrid(routes, crewUtil, crewsById);
  return <RunCalendar grid={grid} />;
}
```

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass; `/runs/[runId]` still listed. `CrewDayRoute` is already imported in `page.tsx`; `getServerClient` and `OptimizationRun` are already imported (used by `RunMap`).

- [ ] **Step 7: Commit**

```bash
git add "src/app/runs/[runId]/run-view-toggle.tsx" "src/app/runs/[runId]/page.tsx"
git commit -m "feat: Calendar tab on run page (toggle + crews-join grid build)"
```

---

## Task 4: Verification + final review

**Files:** none (verification only).

- [ ] **Step 1: Full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: tests pass (calendar-grid suite green), no type/lint errors, build compiles with `/runs/[runId]` listed.

- [ ] **Step 2: Manual verification** — `npm run dev`, open a completed run `/runs/<id>`:
  - The toggle shows List / Map / Calendar; clicking Calendar (or `?view=calendar`) renders the grid.
  - Assigned days show `H.h` + `N stops`, shaded darker as the day fills toward the crew's max hours.
  - A crew that works a weekday but has no route that day shows an amber "idle" cell; a non-working day shows "—".
  - Crews with zero weekly hours appear at the bottom with an "idle all week" badge; the summary line reads "N of M crews idle all week".
  - The Week column is colored by band; the caveat + legend render.
  - Non-completed runs show no toggle (unchanged).

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: run calendar verification fixes"
```

---

## Self-Review

**Spec coverage:**
- Calendar tab on run page → Task 3 (toggle + `view==='calendar'` branch).
- Crews × Mon–Fri grid, per-day hours + stops → Task 1 (`buildCalendarGrid` assigned cells) + Task 2 (DayCell).
- Idle vs off via current-crews join → Task 3 (`RunCalendarView` crews query → `CrewAvailability`) + Task 1 (classification).
- Unknown fallback for deleted crews → Task 1 (`!avail` → unknown).
- Utilization color (per-day fill + weekly band) → Task 1 (`fillPct`, `capacityBand`) + Task 2 (rgba shading, `BAND_CLASS`).
- Weekly total column + fully-idle flag/summary → Task 1 (`weeklyClockHours`, `fullyIdle`) + Task 2 (Week column, badge, summary).
- Caveat + legend + empty state → Task 2.
- vitest on pure module → Task 1.

**Placeholder scan:** none — every step has complete code and exact commands.

**Type consistency:** `CalendarRow`/`CalendarCell`/`CrewAvailability`/`CapacityBand` defined in Task 1 are imported and used identically in Task 2 (component) and Task 3 (`RunCalendarView` builds `CrewAvailability` with `works` keyed 1..5 + `maxHoursPerDay`, matching the module). `buildCalendarGrid(routes, crewUtil, crewsById)` signature matches the Task 3 call. `RunViewToggle`'s `current` type widened to include `'calendar'` (Task 3) matches the `view` union in `page.tsx`. `dayName` and `Badge variant="warning"` are existing, confirmed in-repo.
