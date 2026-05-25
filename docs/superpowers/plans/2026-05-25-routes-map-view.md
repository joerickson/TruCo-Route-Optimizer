# Routes Map View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/runs/[runId]?view=map` view for completed runs that draws every crew's route per weekday, steps/plays through Mon–Fri, animates crews moving along their routes across the workday, and surfaces unassigned properties.

**Architecture:** A server component (`runs/[runId]/page.tsx`) loads the run, joins depot coordinates, assigns per-crew colors, and loads unassigned properties, then passes plain props to a lazy-loaded Mapbox client component. Playback math lives in a pure, unit-tested module (`src/lib/route-playback.ts`); the React/Mapbox layer is verified manually. A small data fix persists `unassigned_property_ids` from the solver.

**Tech Stack:** Next.js 14 (App Router, server components), TypeScript, Mapbox GL JS, Supabase, Python stdlib solver, vitest (new, for pure-logic tests).

**Spec:** `docs/superpowers/specs/2026-05-25-routes-map-view-design.md`

---

## File Structure

New files:
- `src/lib/route-playback.ts` — pure timeline/interpolation math (no Mapbox/React).
- `src/lib/route-playback.test.ts` — vitest unit tests.
- `vitest.config.ts` — vitest config.
- `src/app/runs/[runId]/run-view-toggle.tsx` — list/map segmented control.
- `src/app/runs/[runId]/routes-map-loader.tsx` — `dynamic(..., { ssr:false })` wrapper.
- `src/app/runs/[runId]/routes-map.tsx` — Mapbox client component (rendering + controls + animation).
- `supabase/migrations/20260525000000_unassigned_property_ids.sql` — new column.

Modified files:
- `package.json` — add vitest dev dep + `test` script.
- `src/lib/types.ts` — add `unassigned_property_ids` to `OptimizationRun`.
- `solver/api/index.py` — write `unassigned_property_ids` in `_persist`.
- `src/app/runs/[runId]/page.tsx` — view handling + depot/color/unassigned prep.

---

## Task 1: Vitest setup

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install vitest**

Run:
```bash
npm install -D vitest@^2.1.0
```
Expected: vitest added under devDependencies, lockfile updated.

- [ ] **Step 2: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` entry alongside the existing scripts:
```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit",
  "test": "vitest run"
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Verify the runner works (no tests yet)**

Run: `npm test`
Expected: vitest runs and reports "No test files found" (exit non-zero is fine here) — confirms vitest is installed and configured.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest for pure-logic unit tests"
```

---

## Task 2: Pure playback module (`route-playback.ts`) — TDD

**Files:**
- Create: `src/lib/route-playback.ts`
- Test: `src/lib/route-playback.test.ts`

This module is pure: no Mapbox, no React, no I/O. It converts `CrewDayRoute` +
depot into a timeline and answers "where is this crew at clock-time T?".

- [ ] **Step 1: Write the failing tests**

`src/lib/route-playback.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  parseClock,
  formatClock,
  buildCrewTimeline,
  positionAt,
  dayClockRange,
} from './route-playback';
import type { CrewDayRoute } from './types';

const depot = { lat: 40.0, lng: -111.0 };

// One crew, leaves depot 07:00, arrives stop1 (40.1,-111.0) at 07:30,
// services 30 min (ends 08:00), returns to depot by end_time 08:30.
const route: CrewDayRoute = {
  crew_id: 'c1',
  crew_name: 'Crew 1',
  day_of_week: 1,
  branch_id: 'b1',
  start_time: '07:00',
  end_time: '08:30',
  clock_hours: 1.5,
  drive_hours: 1.0,
  drive_miles: 10,
  stops: [
    {
      property_id: 'p1',
      property_name: 'Prop 1',
      address: '123 St',
      lat: 40.1,
      lng: -111.0,
      arrival_time: '07:30',
      service_minutes: 30,
      drive_minutes_to: 30,
    },
  ],
};

describe('parseClock', () => {
  it('parses HH:MM to seconds from midnight', () => {
    expect(parseClock('07:00')).toBe(25200);
    expect(parseClock('08:30')).toBe(30600);
    expect(parseClock('00:00')).toBe(0);
  });
});

describe('formatClock', () => {
  it('formats seconds to 12-hour am/pm', () => {
    expect(formatClock(25200)).toBe('7:00am');
    expect(formatClock(46800)).toBe('12:00pm');
    expect(formatClock(48600)).toBe('1:30pm');
  });
});

describe('buildCrewTimeline', () => {
  it('derives start/end and stop schedule in seconds', () => {
    const tl = buildCrewTimeline(route, depot);
    expect(tl.crewId).toBe('c1');
    expect(tl.startSeconds).toBe(25200);
    expect(tl.endSeconds).toBe(30600);
    expect(tl.stops).toHaveLength(1);
    expect(tl.stops[0].arrivalSeconds).toBe(27000); // 07:30
    expect(tl.stops[0].serviceSeconds).toBe(1800); // 30 min
  });
});

describe('positionAt', () => {
  const tl = buildCrewTimeline(route, depot);

  it('sits at depot before departure', () => {
    expect(positionAt(tl, parseClock('06:59'))).toEqual([-111.0, 40.0]);
    expect(positionAt(tl, parseClock('07:00'))).toEqual([-111.0, 40.0]);
  });

  it('interpolates depot -> first stop mid-drive (halfway at 07:15)', () => {
    const pos = positionAt(tl, parseClock('07:15'))!;
    expect(pos[0]).toBeCloseTo(-111.0, 6); // lng unchanged
    expect(pos[1]).toBeCloseTo(40.05, 6); // halfway in lat
  });

  it('is parked at the stop during service window', () => {
    expect(positionAt(tl, parseClock('07:30'))).toEqual([-111.0, 40.1]);
    expect(positionAt(tl, parseClock('07:45'))).toEqual([-111.0, 40.1]);
    expect(positionAt(tl, parseClock('08:00'))).toEqual([-111.0, 40.1]);
  });

  it('interpolates last stop -> depot on the return leg (halfway at 08:15)', () => {
    const pos = positionAt(tl, parseClock('08:15'))!;
    expect(pos[1]).toBeCloseTo(40.05, 6);
  });

  it('returns to depot at/after end_time', () => {
    expect(positionAt(tl, parseClock('08:30'))).toEqual([-111.0, 40.0]);
    expect(positionAt(tl, parseClock('09:00'))).toEqual([-111.0, 40.0]);
  });

  it('returns null when there are no stops', () => {
    const empty = buildCrewTimeline({ ...route, stops: [] }, depot);
    expect(positionAt(empty, parseClock('07:30'))).toBeNull();
  });
});

describe('dayClockRange', () => {
  it('spans min start to max end across timelines', () => {
    const a = buildCrewTimeline(route, depot);
    const b = buildCrewTimeline({ ...route, start_time: '06:30', end_time: '09:15' }, depot);
    expect(dayClockRange([a, b])).toEqual({ start: 23400, end: 33300 });
  });

  it('falls back to 7am-5pm when empty', () => {
    expect(dayClockRange([])).toEqual({ start: 25200, end: 61200 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `route-playback.ts` does not export these functions yet.

- [ ] **Step 3: Implement `route-playback.ts`**

```ts
// Pure playback math for the routes map. No Mapbox, no React, no I/O.
// Converts a solver CrewDayRoute (+ its depot) into a clock-driven timeline so
// the map can show each crew's position at any time of day. Positions are
// linearly interpolated along straight segments, matching the solver's
// straight-line (Haversine x 1.3) cost model.
import type { CrewDayRoute } from './types';

export interface PlaybackStop {
  lat: number;
  lng: number;
  arrivalSeconds: number;
  serviceSeconds: number;
}

export interface CrewTimeline {
  crewId: string;
  depot: { lat: number; lng: number };
  startSeconds: number;
  endSeconds: number;
  stops: PlaybackStop[];
}

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 3600 + m * 60;
}

export function formatClock(seconds: number): string {
  const h24 = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12 = ((h24 + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

export function buildCrewTimeline(
  route: CrewDayRoute,
  depot: { lat: number; lng: number }
): CrewTimeline {
  return {
    crewId: route.crew_id,
    depot,
    startSeconds: parseClock(route.start_time),
    endSeconds: parseClock(route.end_time),
    stops: route.stops.map((s) => ({
      lat: s.lat,
      lng: s.lng,
      arrivalSeconds: parseClock(s.arrival_time),
      serviceSeconds: s.service_minutes * 60,
    })),
  };
}

function frac(a: number, b: number, t: number): number {
  if (b <= a) return 1;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

function lerp(a: [number, number], b: [number, number], f: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// Returns [lng, lat] of the crew at clock-time t (seconds from midnight),
// or null if the timeline has no stops.
export function positionAt(tl: CrewTimeline, t: number): [number, number] | null {
  if (tl.stops.length === 0) return null;
  const depot: [number, number] = [tl.depot.lng, tl.depot.lat];

  if (t <= tl.startSeconds) return depot;
  if (t >= tl.endSeconds) return depot;

  const first = tl.stops[0];
  if (t < first.arrivalSeconds) {
    return lerp(depot, [first.lng, first.lat], frac(tl.startSeconds, first.arrivalSeconds, t));
  }

  for (let i = 0; i < tl.stops.length; i++) {
    const s = tl.stops[i];
    const here: [number, number] = [s.lng, s.lat];
    const serviceEnd = s.arrivalSeconds + s.serviceSeconds;

    if (t >= s.arrivalSeconds && t <= serviceEnd) return here;

    const next = tl.stops[i + 1];
    if (next) {
      if (t > serviceEnd && t < next.arrivalSeconds) {
        return lerp(here, [next.lng, next.lat], frac(serviceEnd, next.arrivalSeconds, t));
      }
    } else if (t > serviceEnd) {
      return lerp(here, depot, frac(serviceEnd, tl.endSeconds, t));
    }
  }
  return depot;
}

export function dayClockRange(timelines: CrewTimeline[]): { start: number; end: number } {
  if (timelines.length === 0) return { start: 7 * 3600, end: 17 * 3600 };
  let start = Infinity;
  let end = -Infinity;
  for (const tl of timelines) {
    start = Math.min(start, tl.startSeconds);
    end = Math.max(end, tl.endSeconds);
  }
  return { start, end };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/route-playback.ts src/lib/route-playback.test.ts
git commit -m "feat: pure route-playback timeline + interpolation module"
```

---

## Task 3: Persist `unassigned_property_ids` (data fix)

**Files:**
- Create: `supabase/migrations/20260525000000_unassigned_property_ids.sql`
- Modify: `solver/api/index.py` (the `_persist` function)
- Modify: `src/lib/types.ts` (the `OptimizationRun` interface)

- [ ] **Step 1: Create the migration**

`supabase/migrations/20260525000000_unassigned_property_ids.sql`:
```sql
-- Persist the solver's unassigned property ids so the UI can surface
-- properties that could not be scheduled.
alter table optimization_runs
  add column if not exists unassigned_property_ids uuid[];
```

- [ ] **Step 2: Write `unassigned_property_ids` in the solver's `_persist`**

In `solver/api/index.py`, the `_persist` function calls `_supabase_patch` with a
dict of fields. Add the `unassigned_property_ids` field to that dict (the value is
already present on `result`). The dict currently ends with `"completed_at": ...`.
Change it to:
```python
    _supabase_patch(run_id, {
        "status": result["status"],
        "solver_runtime_seconds": result["solver_runtime_seconds"],
        "total_clock_hours_per_week": result["total_clock_hours_per_week"],
        "total_labor_hours_per_week": result["total_labor_hours_per_week"],
        "total_drive_hours_per_week": result["total_drive_hours_per_week"],
        "total_drive_miles_per_week": result["total_drive_miles_per_week"],
        "crew_utilization": result["crew_utilization"],
        "capacity_recommendation": result["capacity_recommendation"],
        "recommendation_text": result["recommendation_text"],
        "routes_jsonb": result["routes_jsonb"],
        "unassigned_property_ids": result["unassigned_property_ids"],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    })
```

- [ ] **Step 3: Add the field to the `OptimizationRun` type**

In `src/lib/types.ts`, in the `OptimizationRun` interface, add the field right
after `routes_jsonb`:
```ts
  routes_jsonb: OptimizationRoutes | null;
  unassigned_property_ids: string[] | null;
```

- [ ] **Step 4: Verify types compile**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260525000000_unassigned_property_ids.sql solver/api/index.py src/lib/types.ts
git commit -m "feat: persist unassigned_property_ids from solver"
```

- [ ] **Step 6: Operational note (surface to user at ship time, do not run blindly)**

This column must be applied to the database and the solver redeployed:
- Paste-ready SQL (run via `supabase db push` or the SQL editor):
  ```sql
  alter table optimization_runs
    add column if not exists unassigned_property_ids uuid[];
  ```
- Redeploy the solver service on Coolify so new runs populate the column.
- Existing runs keep `null`; the map omits the unassigned layer for them.

---

## Task 4: Server-side data prep + view toggle

**Files:**
- Create: `src/app/runs/[runId]/run-view-toggle.tsx`
- Modify: `src/app/runs/[runId]/page.tsx` (full replacement below)

- [ ] **Step 1: Create the view toggle**

`src/app/runs/[runId]/run-view-toggle.tsx`:
```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';

export function RunViewToggle({ runId, current }: { runId: string; current: 'list' | 'map' }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      <Link
        href={`/runs/${runId}?view=list`}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'list'
            ? 'bg-secondary font-medium text-secondary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        List
      </Link>
      <Link
        href={`/runs/${runId}?view=map`}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'map'
            ? 'bg-secondary font-medium text-secondary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        Map
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Replace `src/app/runs/[runId]/page.tsx`**

This keeps the existing list view (tables) intact and adds map data prep + the
toggle. Depot coordinates are joined from `branches`; crew colors are assigned via
evenly-spread HSL; unassigned properties are loaded when present.

```tsx
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun, CrewDayRoute } from '@/lib/types';
import { dayName, formatHours, formatMiles } from '@/lib/utils';
import { RunRefresher } from './refresher';
import { ExportCsvButton } from './export-csv';
import { RunViewToggle } from './run-view-toggle';
import { RoutesMapLoader } from './routes-map-loader';
import type { RoutesMapCrew, RoutesMapDepot, RoutesMapUnassigned } from './routes-map';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
  searchParams,
}: {
  params: { runId: string };
  searchParams: { view?: string };
}) {
  const view: 'list' | 'map' = searchParams.view === 'map' ? 'map' : 'list';
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('optimization_runs')
    .select('*')
    .eq('id', params.runId)
    .maybeSingle();

  if (error || !data) notFound();
  const run = data as OptimizationRun;

  const isPolling = run.status === 'pending' || run.status === 'running';

  return (
    <div className="space-y-6">
      {isPolling && <RunRefresher />}

      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{run.name}</h1>
          <p className="text-sm text-muted-foreground">
            Target week: {run.target_week_start_date} · created {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {run.status === 'completed' && <RunViewToggle runId={run.id} current={view} />}
          <RunStatusBadge status={run.status} />
        </div>
      </div>

      {run.status === 'failed' && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Run failed</CardTitle>
            <CardDescription>{run.failure_reason ?? 'Unknown error'}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {(run.status === 'pending' || run.status === 'running') && (
        <Card>
          <CardHeader>
            <CardTitle>Solver running…</CardTitle>
            <CardDescription>
              VRP solves can take 1-5 minutes. This page will refresh automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {run.status === 'completed' &&
        (view === 'map' ? <RunMap run={run} /> : <CompletedRun run={run} />)}
    </div>
  );
}

async function RunMap({ run }: { run: OptimizationRun }) {
  const supabase = getServerClient();
  const routes: CrewDayRoute[] = run.routes_jsonb?.per_day ?? [];
  const days = Array.from(new Set(routes.map((r) => r.day_of_week))).sort((a, b) => a - b);

  // Join depot coordinates for every branch referenced by a route.
  const branchIds = Array.from(new Set(routes.map((r) => r.branch_id)));
  const depotsById: Record<string, RoutesMapDepot> = {};
  if (branchIds.length > 0) {
    const { data: branchRows } = await supabase
      .from('branches')
      .select('id, name, lat, lng')
      .in('id', branchIds);
    for (const b of (branchRows ?? []) as Array<{ id: string; name: string; lat: number | string; lng: number | string }>) {
      if (b.lat == null || b.lng == null) continue;
      depotsById[b.id] = { id: b.id, name: b.name, lat: Number(b.lat), lng: Number(b.lng) };
    }
  }

  // Assign each crew a stable, evenly-spread color.
  const crewSeen = new Map<string, string>();
  for (const r of routes) if (!crewSeen.has(r.crew_id)) crewSeen.set(r.crew_id, r.crew_name);
  const sortedCrews = Array.from(crewSeen.entries()).sort((a, b) =>
    a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])
  );
  const n = Math.max(1, sortedCrews.length);
  const crewColors: Record<string, string> = {};
  const crewOrder: RoutesMapCrew[] = sortedCrews.map(([crewId, name], i) => {
    const color = `hsl(${Math.round((i * 360) / n)}, 65%, 50%)`;
    crewColors[crewId] = color;
    return { crewId, name, color };
  });

  // Load unassigned properties (null on pre-migration runs -> empty).
  const unassignedIds = run.unassigned_property_ids ?? [];
  let unassigned: RoutesMapUnassigned[] = [];
  if (unassignedIds.length > 0) {
    const { data: propRows } = await supabase
      .from('properties')
      .select('id, name, address, lat, lng')
      .in('id', unassignedIds)
      .not('lat', 'is', null)
      .not('lng', 'is', null);
    unassigned = ((propRows ?? []) as Array<{ id: string; name: string; address: string; lat: number | string; lng: number | string }>).map(
      (p) => ({ id: p.id, name: p.name, address: p.address, lat: Number(p.lat), lng: Number(p.lng) })
    );
  }

  return (
    <RoutesMapLoader
      routes={routes}
      depotsById={depotsById}
      crewColors={crewColors}
      crewOrder={crewOrder}
      unassigned={unassigned}
      days={days}
    />
  );
}

function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Badge variant="success">completed</Badge>;
    case 'running':
      return <Badge variant="warning">running</Badge>;
    case 'failed':
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function CompletedRun({ run }: { run: OptimizationRun }) {
  const utilization = run.crew_utilization ?? [];
  const routes = run.routes_jsonb?.per_day ?? [];
  const days = Array.from(new Set(routes.map((r) => r.day_of_week))).sort((a, b) => a - b);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryStat label="Total clock hrs/wk" value={formatHours(run.total_clock_hours_per_week)} />
        <SummaryStat label="Drive hrs/wk" value={formatHours(run.total_drive_hours_per_week)} />
        <SummaryStat label="Drive mi/wk" value={formatMiles(run.total_drive_miles_per_week)} />
        <SummaryStat
          label="Solver runtime"
          value={run.solver_runtime_seconds != null ? `${run.solver_runtime_seconds.toFixed(0)} s` : '—'}
        />
      </div>

      {run.recommendation_text && (
        <Card>
          <CardHeader>
            <CardTitle>Capacity analysis</CardTitle>
            <CardDescription>{run.capacity_recommendation ?? '—'}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{run.recommendation_text}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Day-by-day routes</CardTitle>
            <CardDescription>{routes.length} crew-days planned</CardDescription>
          </div>
          <ExportCsvButton runId={run.id} />
        </CardHeader>
        <CardContent>
          {days.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routes generated.</p>
          ) : (
            <Tabs defaultValue={String(days[0])}>
              <TabsList>
                {days.map((d) => (
                  <TabsTrigger key={d} value={String(d)}>
                    {dayName(d)}
                  </TabsTrigger>
                ))}
              </TabsList>
              {days.map((d) => (
                <TabsContent key={d} value={String(d)} className="space-y-4">
                  {routes
                    .filter((r) => r.day_of_week === d)
                    .map((r) => (
                      <Card key={`${r.crew_id}-${d}`}>
                        <CardHeader className="pb-2">
                          <div className="flex items-center justify-between">
                            <CardTitle className="text-base">{r.crew_name}</CardTitle>
                            <div className="text-xs text-muted-foreground">
                              {r.stops.length} stops · {formatHours(r.clock_hours)} clock · {formatHours(r.drive_hours)} drive ·{' '}
                              {formatMiles(r.drive_miles)}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-0">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16">Arr.</TableHead>
                                <TableHead>Property</TableHead>
                                <TableHead>Address</TableHead>
                                <TableHead className="w-24 text-right">Service</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {r.stops.map((s, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-xs">{s.arrival_time}</TableCell>
                                  <TableCell className="font-medium">{s.property_name}</TableCell>
                                  <TableCell className="text-muted-foreground">{s.address}</TableCell>
                                  <TableCell className="text-right">{(s.service_minutes / 60).toFixed(1)}h</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                    ))}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-crew utilization</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Crew</TableHead>
                <TableHead className="text-right">Clock hrs/wk</TableHead>
                <TableHead className="text-right">Drive hrs/wk</TableHead>
                <TableHead className="text-right">Drive miles</TableHead>
                <TableHead className="text-right">Properties</TableHead>
                <TableHead className="text-right">Util %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {utilization.map((u) => (
                <TableRow key={u.crew_id}>
                  <TableCell className="font-medium">{u.crew_name}</TableCell>
                  <TableCell className="text-right">{formatHours(u.clock_hours)}</TableCell>
                  <TableCell className="text-right">{formatHours(u.drive_hours)}</TableCell>
                  <TableCell className="text-right">{formatMiles(u.drive_miles)}</TableCell>
                  <TableCell className="text-right">{u.props_assigned}</TableCell>
                  <TableCell className="text-right">{u.util_pct.toFixed(0)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
```

- [ ] **Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: FAIL only on the not-yet-created `./routes-map` and `./routes-map-loader`
imports. (These are created in Task 5; this confirms the rest of the page is sound.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/runs/[runId]/run-view-toggle.tsx" "src/app/runs/[runId]/page.tsx"
git commit -m "feat: run page map-view data prep + list/map toggle"
```

---

## Task 5: Mapbox routes map component

**Files:**
- Create: `src/app/runs/[runId]/routes-map-loader.tsx`
- Create: `src/app/runs/[runId]/routes-map.tsx`

This component is verified manually (no unit tests). It mirrors the init/setData
patterns in `src/app/properties/properties-map.tsx`.

- [ ] **Step 1: Create the loader**

`src/app/runs/[runId]/routes-map-loader.tsx`:
```tsx
'use client';
import dynamic from 'next/dynamic';
import type { RoutesMapProps } from './routes-map';

// Lazy-load mapbox-gl only when the map view mounts. ssr:false because
// mapbox-gl references `window`.
const RoutesMap = dynamic(() => import('./routes-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[640px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function RoutesMapLoader(props: RoutesMapProps) {
  return <RoutesMap {...props} />;
}
```

- [ ] **Step 2: Create the map component**

`src/app/runs/[runId]/routes-map.tsx`:
```tsx
'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CrewDayRoute } from '@/lib/types';
import { dayName } from '@/lib/utils';
import {
  buildCrewTimeline,
  dayClockRange,
  formatClock,
  positionAt,
  type CrewTimeline,
} from '@/lib/route-playback';

export interface RoutesMapDepot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface RoutesMapUnassigned {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface RoutesMapCrew {
  crewId: string;
  name: string;
  color: string;
}

export interface RoutesMapProps {
  routes: CrewDayRoute[];
  depotsById: Record<string, RoutesMapDepot>;
  crewColors: Record<string, string>;
  crewOrder: RoutesMapCrew[];
  unassigned: RoutesMapUnassigned[];
  days: number[];
}

const UNASSIGNED_COLOR = '#dc2626'; // red-600
const DEPOT_COLOR = '#111827'; // gray-900
const SPEED = 1800; // sim-seconds advanced per real-second when playing (~1 work-hr ≈ 2s)
const DAY_PLAY_MS = 1500; // dwell per day when playing through the week

export default function RoutesMap(props: RoutesMapProps) {
  const { routes, depotsById, crewColors, crewOrder, unassigned, days } = props;
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  const [selectedDay, setSelectedDay] = useState<number>(days[0] ?? 1);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [playingDays, setPlayingDays] = useState(false);

  // Timelines for the selected day.
  const timelines = useMemo<CrewTimeline[]>(() => {
    const out: CrewTimeline[] = [];
    for (const r of routes) {
      if (r.day_of_week !== selectedDay) continue;
      const depot = depotsById[r.branch_id];
      if (!depot) continue;
      out.push(buildCrewTimeline(r, depot));
    }
    return out;
  }, [routes, selectedDay, depotsById]);

  const range = useMemo(() => dayClockRange(timelines), [timelines]);

  const clockRef = useRef(range.start);
  const [clock, setClock] = useState(range.start);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // Visibility / opacity for a crew given current hidden/solo/hover state.
  const opacityFor = useCallback(
    (crewId: string): number => {
      const visible = solo ? crewId === solo : !hidden.has(crewId);
      if (!visible) return 0;
      if (hover && hover !== crewId) return 0.15;
      return 1;
    },
    [hidden, solo, hover]
  );

  // Reset the clock whenever the day (and thus range) changes.
  useEffect(() => {
    clockRef.current = range.start;
    setClock(range.start);
    setPlaying(false);
    lastTsRef.current = null;
  }, [range.start, range.end]);

  // ---- GeoJSON builders ----
  const routesGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    return {
      type: 'FeatureCollection',
      features: timelines.map((tl) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [tl.depot.lng, tl.depot.lat],
            ...tl.stops.map((s) => [s.lng, s.lat] as [number, number]),
            [tl.depot.lng, tl.depot.lat],
          ],
        },
        properties: {
          crewId: tl.crewId,
          color: crewColors[tl.crewId] ?? '#64748b',
          opacity: opacityFor(tl.crewId),
        },
      })),
    };
  }, [timelines, crewColors, opacityFor]);

  const stopsGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    const features: GeoJSON.Feature[] = [];
    for (const tl of timelines) {
      tl.stops.forEach((s, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: {
            crewId: tl.crewId,
            color: crewColors[tl.crewId] ?? '#64748b',
            opacity: opacityFor(tl.crewId),
            seq: String(i + 1),
          },
        });
      });
    }
    return { type: 'FeatureCollection', features };
  }, [timelines, crewColors, opacityFor]);

  const depotsGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    const seen = new Set<string>();
    const features: GeoJSON.Feature[] = [];
    for (const tl of timelines) {
      const depotId = `${tl.depot.lat},${tl.depot.lng}`;
      if (seen.has(depotId)) continue;
      seen.add(depotId);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [tl.depot.lng, tl.depot.lat] },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features };
  }, [timelines]);

  const unassignedGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    return {
      type: 'FeatureCollection',
      features: unassigned.map((u) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [u.lng, u.lat] },
        properties: { name: u.name, address: u.address },
      })),
    };
  }, [unassigned]);

  const crewPosGeoJSON = useCallback(
    (t: number): GeoJSON.FeatureCollection => {
      const features: GeoJSON.Feature[] = [];
      for (const tl of timelines) {
        const op = opacityFor(tl.crewId);
        if (op === 0) continue;
        const pos = positionAt(tl, t);
        if (!pos) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: { crewId: tl.crewId, color: crewColors[tl.crewId] ?? '#64748b', opacity: op },
        });
      }
      return { type: 'FeatureCollection', features };
    },
    [timelines, crewColors, opacityFor]
  );

  // ---- Map init (once) ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;
    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-111.89, 40.76],
      zoom: 9,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('route-stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('depots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('unassigned', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('crew-pos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': ['get', 'opacity'],
        },
      });

      map.addLayer({
        id: 'stop-points',
        type: 'circle',
        source: 'route-stops',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 9,
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': ['get', 'opacity'],
        },
      });

      map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'route-stops',
        layout: {
          'text-field': ['get', 'seq'],
          'text-size': 11,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#fff', 'text-opacity': ['get', 'opacity'] },
      });

      map.addLayer({
        id: 'depot-points',
        type: 'circle',
        source: 'depots',
        paint: {
          'circle-color': DEPOT_COLOR,
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      });

      map.addLayer({
        id: 'unassigned-points',
        type: 'circle',
        source: 'unassigned',
        paint: {
          'circle-color': UNASSIGNED_COLOR,
          'circle-radius': 6,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
        },
      });

      map.addLayer({
        id: 'crew-pos-points',
        type: 'circle',
        source: 'crew-pos',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 7,
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': ['get', 'opacity'],
        },
      });

      // Stop popup.
      map.on('click', 'stop-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const p = f.properties as Record<string, string>;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(`<div style="font-family:inherit;font-size:12px">Stop #${escapeHtml(p.seq ?? '')}</div>`)
          .addTo(map);
      });

      // Unassigned popup.
      map.on('click', 'unassigned-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const p = f.properties as Record<string, string>;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(
            `<div style="font-family:inherit;min-width:200px;line-height:1.45">
               <div style="font-weight:600">${escapeHtml(p.name ?? '')}</div>
               <div style="font-size:12px;color:#64748b">${escapeHtml(p.address ?? '')}</div>
               <div style="font-size:11px;color:${UNASSIGNED_COLOR};margin-top:4px">Unassigned — could not be scheduled</div>
             </div>`
          )
          .addTo(map);
      });

      const cursorOn = () => (map.getCanvas().style.cursor = 'pointer');
      const cursorOff = () => (map.getCanvas().style.cursor = '');
      for (const layer of ['stop-points', 'unassigned-points']) {
        map.on('mouseenter', layer, cursorOn);
        map.on('mouseleave', layer, cursorOff);
      }

      setStyleReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Init exactly once; data flows through setData effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Push route/stop/depot/unassigned data + fit bounds when the day or visibility changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource('routes') as mapboxgl.GeoJSONSource | undefined)?.setData(routesGeoJSON());
    (map.getSource('route-stops') as mapboxgl.GeoJSONSource | undefined)?.setData(stopsGeoJSON());
    (map.getSource('depots') as mapboxgl.GeoJSONSource | undefined)?.setData(depotsGeoJSON());
    (map.getSource('unassigned') as mapboxgl.GeoJSONSource | undefined)?.setData(unassignedGeoJSON());
  }, [styleReady, routesGeoJSON, stopsGeoJSON, depotsGeoJSON, unassignedGeoJSON]);

  // Fit bounds to the selected day's geometry (once per day change).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const bounds = new mapboxgl.LngLatBounds();
    let any = false;
    for (const tl of timelines) {
      bounds.extend([tl.depot.lng, tl.depot.lat]);
      for (const s of tl.stops) {
        bounds.extend([s.lng, s.lat]);
        any = true;
      }
    }
    for (const u of unassigned) {
      bounds.extend([u.lng, u.lat]);
      any = true;
    }
    if (any) map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 300 });
  }, [styleReady, selectedDay, timelines, unassigned]);

  // Update animated crew positions whenever clock / visibility / day changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource('crew-pos') as mapboxgl.GeoJSONSource | undefined)?.setData(crewPosGeoJSON(clock));
  }, [styleReady, clock, crewPosGeoJSON]);

  // Within-day playback loop.
  useEffect(() => {
    if (!playing) return;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      let next = clockRef.current + dt * SPEED;
      if (next >= range.end) {
        next = range.end;
        setPlaying(false);
      }
      clockRef.current = next;
      setClock(next);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, range.end]);

  // Play-through-the-week loop.
  useEffect(() => {
    if (!playingDays || days.length <= 1) return;
    const t = setInterval(() => {
      setSelectedDay((d) => {
        const idx = days.indexOf(d);
        const nextIdx = (idx + 1) % days.length;
        if (nextIdx === 0) setPlayingDays(false);
        return days[nextIdx];
      });
    }, DAY_PLAY_MS);
    return () => clearInterval(t);
  }, [playingDays, days]);

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Map unavailable</CardTitle>
          <CardDescription>
            <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> is not set in this environment.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const scrub = (v: number) => {
    setPlaying(false);
    clockRef.current = v;
    setClock(v);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Routes map</CardTitle>
            <CardDescription>
              {timelines.length} crews on {dayName(selectedDay)} · straight-line approximation (Haversine ×1.3),
              not turn-by-turn
              {unassigned.length > 0 && (
                <span className="ml-2 font-medium" style={{ color: UNASSIGNED_COLOR }}>
                  · {unassigned.length} unassigned
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {days.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDay(d)}
                className={
                  'rounded-md border px-2.5 py-1 text-sm transition-colors ' +
                  (d === selectedDay
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {dayName(d)}
              </button>
            ))}
            {days.length > 1 && (
              <Button variant="outline" size="sm" onClick={() => setPlayingDays((p) => !p)}>
                {playingDays ? 'Stop days' : 'Play days'}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div ref={containerRef} className="h-[640px] w-full overflow-hidden rounded-md border" />

        {/* Time scrubber */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (clockRef.current >= range.end) scrub(range.start);
              lastTsRef.current = null;
              setPlaying((p) => !p);
            }}
          >
            {playing ? 'Pause' : 'Play day'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => scrub(range.start)}>
            Reset
          </Button>
          <input
            type="range"
            min={range.start}
            max={range.end}
            step={60}
            value={clock}
            onChange={(e) => scrub(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-16 text-right font-mono text-sm">{formatClock(clock)}</span>
        </div>

        {/* Crew legend / filter */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setHidden(new Set());
              setSolo(null);
            }}
            className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            All
          </button>
          <button
            onClick={() => {
              setHidden(new Set(crewOrder.map((c) => c.crewId)));
              setSolo(null);
            }}
            className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            None
          </button>
          {crewOrder.map((c) => {
            const isHidden = solo ? c.crewId !== solo : hidden.has(c.crewId);
            return (
              <button
                key={c.crewId}
                onMouseEnter={() => setHover(c.crewId)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setSolo((cur) => (cur === c.crewId ? null : c.crewId))}
                className={
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-opacity ' +
                  (isHidden ? 'opacity-40' : 'opacity-100')
                }
                title="Click to solo this crew"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
```

- [ ] **Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Verify the production build**

Run: `npm run build`
Expected: Compiles successfully; `/runs/[runId]` still listed as a route.

- [ ] **Step 5: Commit**

```bash
git add "src/app/runs/[runId]/routes-map-loader.tsx" "src/app/runs/[runId]/routes-map.tsx"
git commit -m "feat: routes map view — per-crew routes, day stepper, time playback, unassigned layer"
```

---

## Task 6: Manual verification + final checks

**Files:** none (verification only).

- [ ] **Step 1: Run the app**

Run: `npm run dev`
Open a completed run: `/runs/<an-existing-completed-run-id>` then click **Map**.

- [ ] **Step 2: Verify the checklist**

Confirm:
- Routes render: one colored line per crew, depot→stops→depot, numbered stops.
- Day buttons switch days; **Play days** cycles Mon→Fri and stops after the last.
- **Play day** animates crew dots along their routes; the clock label advances; the
  scrubber tracks; dragging the scrubber scrubs and pauses; **Reset** returns to start.
- Crew chips: **All**/**None** toggle visibility; clicking a chip solos it (click
  again to clear); hovering a chip dims the others.
- If the run predates the migration, no unassigned layer appears (no crash).
- With `NEXT_PUBLIC_MAPBOX_TOKEN` unset, the "Map unavailable" card shows.

- [ ] **Step 3: Run the full check suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: tests pass, no type errors, no lint errors.

- [ ] **Step 4: (If any fixes were needed) commit them**

```bash
git add -A
git commit -m "fix: routes map verification fixes"
```

---

## Self-Review

**Spec coverage:**
- Map view at `?view=map` for completed runs → Task 4 (page view handling, toggle).
- Depot coord join → Task 4 (`RunMap`).
- Per-crew stable HSL color → Task 4 (`crewOrder`/`crewColors`).
- All-crews-at-once + filter/solo/hover → Task 5 (legend buttons + `opacityFor`).
- Day stepper + play-days → Task 5 (day buttons + play-days interval).
- Time scrubber + play/pause/reset animation → Task 5 (rAF loop + scrubber) on the
  pure math from Task 2.
- Straight-line interpolation matching solver model → Task 2 (`positionAt`).
- Numbered stop markers, depot markers, stop popups → Task 5.
- Unassigned layer + count badge → Task 5; persisted via Task 3.
- Straight-line disclosure label → Task 5 (CardDescription).
- Token-missing guard, lazy load → Task 5 (guard card + loader).
- vitest for pure logic → Task 1; tests in Task 2.

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have
expected output.

**Type consistency:** `RoutesMapProps`, `RoutesMapDepot`, `RoutesMapUnassigned`,
`RoutesMapCrew` are defined in `routes-map.tsx` and imported by both the loader and
the page. `CrewTimeline`/`positionAt`/`buildCrewTimeline`/`dayClockRange`/
`formatClock`/`parseClock` signatures match between Task 2's definitions and Task 5's
usage. `unassigned_property_ids` added to the type (Task 3) and read in Task 4.
