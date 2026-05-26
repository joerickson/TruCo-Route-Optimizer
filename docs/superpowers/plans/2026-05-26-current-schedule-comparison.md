# Current-Schedule Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload the current (unoptimized) crew schedule, score it with the same solver code that scores optimized runs, and show a `/compare` page with fleet, per-crew, per-property, and capacity deltas.

**Architecture:** A `run_kind='baseline'` row in `optimization_runs` holds the scored current schedule. The Python solver gains an `evaluate` mode that takes the fixed `(crew, day)` assignments off `properties` and TSP-orders each crew-day (capacity relaxed) using the *same* aggregation as the optimizer. A pure `schedule-compare.ts` diffs two run rows into the four finding sections; the `/compare` page renders them.

**Tech Stack:** Next.js 14 App Router (RSC + server actions), TypeScript, Tailwind/shadcn primitives, Supabase Postgres, Python (OR-Tools) solver, vitest, `xlsx`/`papaparse`.

---

## File Structure

**Create:**
- `supabase/migrations/20260526000000_run_kind.sql` — `run_kind` discriminator.
- `src/lib/schedule-import.ts` — parse the standalone schedule sheet + crew/day helpers.
- `src/lib/schedule-import.test.ts` — vitest for the parser/helpers.
- `src/lib/schedule-compare.ts` — pure `compareSchedules(baseline, optimized)`.
- `src/lib/schedule-compare.test.ts` — vitest for the comparison.
- `src/app/compare/page.tsx` — the comparison page (server component).
- `src/app/compare/actions.ts` — `uploadAndScoreSchedule` server action.
- `src/app/compare/compare-selectors.tsx` — client run dropdowns (update query string).
- `src/app/compare/upload-schedule.tsx` — client upload form (Path B).
- `src/app/compare/fleet-summary.tsx` — fleet + capacity cards (server component).
- `src/app/compare/crew-deltas.tsx` — per-crew table (server component).
- `src/app/compare/property-changes.tsx` — per-property change list (server component).
- `src/app/compare/export/route.ts` — CSV export of the change list.

**Modify:**
- `solver/api/index.py` — extract `_aggregate_result`, add `_group_by_crew_day` + `run_evaluation`, dispatch on `mode`, add `assigned_crew_id` to solver props.
- `src/app/optimize/page.tsx` — filter the runs list to `run_kind='optimized'`.
- `src/components/top-nav.tsx` — add a `Compare` nav link.
- `src/lib/csv-import.ts` + `src/app/properties/actions.ts` — optional Aspire crew/day columns (Path A, Task 9).

---

## Task 1: Migration — `run_kind` discriminator + filter optimize list

**Files:**
- Create: `supabase/migrations/20260526000000_run_kind.sql`
- Modify: `src/app/optimize/page.tsx:25`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260526000000_run_kind.sql`:

```sql
-- Distinguish baseline (scored current schedule) runs from optimized runs.
-- Both live in optimization_runs so the baseline reuses the run-detail tabs.
alter table optimization_runs
  add column if not exists run_kind text not null default 'optimized'
    check (run_kind in ('optimized', 'baseline'));

create index if not exists optimization_runs_kind_idx
  on optimization_runs(run_kind, created_at desc);
```

- [ ] **Step 2: Filter the optimize page's run list to optimized only**

In `src/app/optimize/page.tsx`, the runs query at line ~25 is:

```ts
    supabase.from('optimization_runs').select('*').order('created_at', { ascending: false }).limit(20),
```

Change it to:

```ts
    supabase.from('optimization_runs').select('*').eq('run_kind', 'optimized').order('created_at', { ascending: false }).limit(20),
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260526000000_run_kind.sql src/app/optimize/page.tsx
git commit -m "feat: run_kind discriminator for baseline runs"
```

**Paste-ready SQL for the user** (per CLAUDE.md — `supabase db push` is never auto-applied; surface this in the response):

```sql
alter table optimization_runs
  add column if not exists run_kind text not null default 'optimized'
    check (run_kind in ('optimized', 'baseline'));
create index if not exists optimization_runs_kind_idx
  on optimization_runs(run_kind, created_at desc);
```

---

## Task 2: Solver — extract shared aggregation helper

This is a pure refactor of `solver/api/index.py` so `run_optimization` and the new
`run_evaluation` cannot drift. No behavior change.

**Files:**
- Modify: `solver/api/index.py` (the `run_optimization` body, lines ~186-280)

- [ ] **Step 1: Add `_aggregate_result` above `run_optimization`**

Insert this function just before `def run_optimization`:

```python
def _aggregate_result(
    crews: list[dict[str, Any]],
    all_routes: list[dict[str, Any]],
    unassigned: list[str],
    properties: list[dict[str, Any]],
    elapsed: float,
) -> dict[str, Any]:
    """Aggregate per-day routes into a persisted run result.

    Shared by run_optimization and run_evaluation so both compute crew
    utilization, totals, and the capacity band identically.
    """
    crew_totals: dict[str, dict[str, Any]] = {
        c["id"]: {
            "crew_id": c["id"],
            "crew_name": c["name"],
            "clock_hours": 0.0,
            "drive_hours": 0.0,
            "drive_miles": 0.0,
            "props_assigned": 0,
            "max_weekly": 0.0,
        }
        for c in crews
    }
    for c in crews:
        days_worked = sum(1 for d in WEEKDAY_FIELDS.values() if c.get(d))
        crew_totals[c["id"]]["max_weekly"] = days_worked * float(c.get("max_clock_hours_per_day") or 8)

    for r in all_routes:
        t = crew_totals.get(r["crew_id"])
        if t is None:
            continue
        t["clock_hours"] += r["clock_hours"]
        t["drive_hours"] += r["drive_hours"]
        t["drive_miles"] += r["drive_miles"]
        t["props_assigned"] += len(r["stops"])

    crew_utilization = []
    for ct in crew_totals.values():
        util_pct = (ct["clock_hours"] / ct["max_weekly"] * 100) if ct["max_weekly"] else 0
        crew_utilization.append(
            {
                "crew_id": ct["crew_id"],
                "crew_name": ct["crew_name"],
                "clock_hours": round(ct["clock_hours"], 2),
                "drive_hours": round(ct["drive_hours"], 2),
                "work_hours": round(ct["clock_hours"] - ct["drive_hours"], 2),
                "drive_miles": round(ct["drive_miles"], 1),
                "props_assigned": ct["props_assigned"],
                "util_pct": round(util_pct, 1),
            }
        )

    total_clock = sum(c["clock_hours"] for c in crew_utilization)
    total_drive = sum(c["drive_hours"] for c in crew_utilization)
    total_miles = sum(c["drive_miles"] for c in crew_utilization)
    total_labor_persons = sum(float(p["est_labor_hours"]) for p in properties)

    n_active_crews = sum(1 for c in crew_utilization if c["clock_hours"] > 0)
    avg_clock_per_crew = total_clock / max(1, n_active_crews)
    rec_code, rec_text = _classify_capacity(avg_clock_per_crew)

    return {
        "status": "completed",
        "solver_runtime_seconds": round(elapsed, 1),
        "total_clock_hours_per_week": round(total_clock, 2),
        "total_labor_hours_per_week": round(total_labor_persons, 2),
        "total_drive_hours_per_week": round(total_drive, 2),
        "total_drive_miles_per_week": round(total_miles, 1),
        "crew_utilization": crew_utilization,
        "capacity_recommendation": rec_code,
        "recommendation_text": rec_text,
        "routes_jsonb": {"per_day": all_routes},
        "unassigned_property_ids": unassigned,
    }
```

- [ ] **Step 2: Rewrite `run_optimization` to use the helper**

Replace the body of `run_optimization` (everything after `buckets = _bucketize_properties(...)`) so the aggregation is delegated:

```python
def run_optimization(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    crews = payload["crews"]
    branches = payload["branches"]
    properties = payload["properties"]

    branches_by_id = {b["id"]: b for b in branches}
    solver_props = _properties_for_solver(properties)
    buckets = _bucketize_properties(solver_props, crews)

    all_routes: list[dict[str, Any]] = []
    unassigned: list[str] = []

    for day, props_for_day in buckets.items():
        if not props_for_day:
            continue
        crews_today = _crews_for_day(crews, branches_by_id, day)
        if not crews_today:
            unassigned.extend(p["id"] for p in props_for_day)
            continue
        result = solve_day(day, props_for_day, crews_today, time_limit_seconds=8)
        all_routes.extend(result["routes"])
        unassigned.extend(result.get("unassigned", []))

    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)
```

- [ ] **Step 3: Verify the file still parses**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py
git commit -m "refactor(solver): extract shared _aggregate_result"
```

---

## Task 3: Solver — `_group_by_crew_day` (testable, no OR-Tools)

**Files:**
- Modify: `solver/api/index.py` — add grouping fn + `assigned_crew_id` to solver props
- Create: `solver/api/check_grouping.py` — standalone check (imports without OR-Tools)

- [ ] **Step 1: Add `assigned_crew_id` to `_properties_for_solver`**

In `_properties_for_solver`, the appended dict currently ends with
`"assigned_day_of_week": p.get("assigned_day_of_week"),`. Add a line:

```python
                "assigned_crew_id": p.get("assigned_crew_id"),
```

- [ ] **Step 2: Add the pure grouping function**

Add to `solver/api/index.py` (above `run_evaluation`, which arrives in Task 4):

```python
def _group_by_crew_day(
    solver_props: list[dict[str, Any]],
) -> tuple[dict[tuple[int, str], list[dict[str, Any]]], list[str]]:
    """Group properties by their fixed (assigned_day_of_week, assigned_crew_id).

    Returns (groups, unassigned_ids). A property with no crew or no day is
    unassigned — it is part of today's schedule on paper but not actually
    routed to anyone.
    """
    groups: dict[tuple[int, str], list[dict[str, Any]]] = {}
    unassigned: list[str] = []
    for p in solver_props:
        day = p.get("assigned_day_of_week")
        crew_id = p.get("assigned_crew_id")
        if not day or not crew_id:
            unassigned.append(p["id"])
            continue
        groups.setdefault((int(day), str(crew_id)), []).append(p)
    return groups, unassigned
```

- [ ] **Step 3: Write the standalone check**

Create `solver/api/check_grouping.py`:

```python
"""Standalone check for _group_by_crew_day. Run: python3 solver/api/check_grouping.py
Importable without OR-Tools because index.py guards the solver_logic import.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _group_by_crew_day

props = [
    {"id": "a", "assigned_day_of_week": 1, "assigned_crew_id": "c1"},
    {"id": "b", "assigned_day_of_week": 1, "assigned_crew_id": "c1"},
    {"id": "c", "assigned_day_of_week": 2, "assigned_crew_id": "c1"},
    {"id": "d", "assigned_day_of_week": 1, "assigned_crew_id": "c2"},
    {"id": "e", "assigned_day_of_week": None, "assigned_crew_id": "c1"},  # no day
    {"id": "f", "assigned_day_of_week": 3, "assigned_crew_id": None},     # no crew
]
groups, unassigned = _group_by_crew_day(props)

assert set(groups.keys()) == {(1, "c1"), (2, "c1"), (1, "c2")}, groups.keys()
assert [p["id"] for p in groups[(1, "c1")]] == ["a", "b"]
assert [p["id"] for p in groups[(2, "c1")]] == ["c"]
assert [p["id"] for p in groups[(1, "c2")]] == ["d"]
assert sorted(unassigned) == ["e", "f"], unassigned
print("check_grouping: PASS")
```

- [ ] **Step 4: Run the check**

Run: `python3 solver/api/check_grouping.py`
Expected: `check_grouping: PASS`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_grouping.py
git commit -m "feat(solver): pure _group_by_crew_day + grouping check"
```

---

## Task 4: Solver — `run_evaluation` + mode dispatch

**Files:**
- Modify: `solver/api/index.py` — add `run_evaluation`, dispatch in `do_POST`

- [ ] **Step 1: Add `run_evaluation`**

Add below `_group_by_crew_day`:

```python
# Sentinel max-clock for evaluate mode: never drop a stop for capacity, so an
# overloaded crew is scored at its true hours instead of shedding work.
_EVAL_MAX_CLOCK_HOURS = 1_000_000.0


def run_evaluation(payload: dict[str, Any]) -> dict[str, Any]:
    """Score a FIXED current schedule (properties carry assigned_crew_id +
    assigned_day_of_week). Each crew-day is TSP-ordered with capacity relaxed;
    aggregation is identical to run_optimization."""
    started = time.time()
    crews = payload["crews"]
    branches = payload["branches"]
    properties = payload["properties"]

    branches_by_id = {b["id"]: b for b in branches}
    crews_by_id = {c["id"]: c for c in crews}
    solver_props = _properties_for_solver(properties)
    groups, unassigned = _group_by_crew_day(solver_props)

    all_routes: list[dict[str, Any]] = []

    for (day, crew_id), props_for_group in groups.items():
        crew = crews_by_id.get(crew_id)
        branch = branches_by_id.get(crew["home_branch_id"]) if crew else None
        if crew is None or branch is None:
            # Assigned to a crew we don't have (deleted / no geocoded branch).
            unassigned.extend(p["id"] for p in props_for_group)
            continue
        crew_for_day = [{
            "id": crew["id"],
            "name": crew["name"],
            "branch_id": branch["id"],
            "branch_lat": branch["lat"],
            "branch_lng": branch["lng"],
            "max_clock_hours": _EVAL_MAX_CLOCK_HOURS,  # relaxed: never drop
            "crew_size": int(crew.get("crew_size") or 2),
        }]
        result = solve_day(day, props_for_group, crew_for_day, time_limit_seconds=8)
        all_routes.extend(result["routes"])
        unassigned.extend(result.get("unassigned", []))

    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)
```

- [ ] **Step 2: Dispatch on `mode` in `do_POST`**

In `handler.do_POST`, the line is:

```python
            run_id = payload.get("run_id")
            result = run_optimization(payload)
```

Replace the second line with:

```python
            mode = payload.get("mode", "optimize")
            result = run_evaluation(payload) if mode == "evaluate" else run_optimization(payload)
```

- [ ] **Step 3: Verify the file parses**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): run_evaluation mode for scoring current schedule"
```

> **Deploy note for executor:** the solver is a separate Vercel/Coolify project rooted at `solver/`. End-to-end evaluate scoring is verified after the solver redeploys (Task 11 manual checks).

---

## Task 5: `parseDayOfWeek` + `resolveCrewId` helpers (TDD)

**Files:**
- Create: `src/lib/schedule-import.ts`
- Test: `src/lib/schedule-import.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/schedule-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseDayOfWeek, resolveCrewId } from './schedule-import';

describe('parseDayOfWeek', () => {
  it('parses full names case-insensitively', () => {
    expect(parseDayOfWeek('Monday')).toBe(1);
    expect(parseDayOfWeek('friday')).toBe(5);
    expect(parseDayOfWeek('SUNDAY')).toBe(7);
  });
  it('parses abbreviations', () => {
    expect(parseDayOfWeek('Mon')).toBe(1);
    expect(parseDayOfWeek('wed')).toBe(3);
  });
  it('parses numeric 1..7', () => {
    expect(parseDayOfWeek('1')).toBe(1);
    expect(parseDayOfWeek(4)).toBe(4);
    expect(parseDayOfWeek('7')).toBe(7);
  });
  it('returns null for garbage / out of range', () => {
    expect(parseDayOfWeek('someday')).toBeNull();
    expect(parseDayOfWeek('0')).toBeNull();
    expect(parseDayOfWeek('8')).toBeNull();
    expect(parseDayOfWeek('')).toBeNull();
    expect(parseDayOfWeek(null)).toBeNull();
  });
});

describe('resolveCrewId', () => {
  const map = new Map<string, string>([['crew a', 'id-a'], ['north crew', 'id-n']]);
  it('matches case- and space-insensitively', () => {
    expect(resolveCrewId('Crew A', map)).toBe('id-a');
    expect(resolveCrewId('  north crew ', map)).toBe('id-n');
  });
  it('returns null when unmatched', () => {
    expect(resolveCrewId('Crew Z', map)).toBeNull();
    expect(resolveCrewId('', map)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/schedule-import.test.ts`
Expected: FAIL — cannot find module `./schedule-import`.

- [ ] **Step 3: Write the helpers**

Create `src/lib/schedule-import.ts`:

```ts
// Standalone current-schedule import — maps a schedule sheet (external_id -> crew, day)
// onto existing properties' assigned_crew_id / assigned_day_of_week.
// Shares the skipped-row shape with csv-import.ts.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { SkippedRow } from './csv-import';

const DAY_NAMES: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

export function parseDayOfWeek(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s in DAY_NAMES) return DAY_NAMES[s];
  if (/^[1-7]$/.test(s)) return Number(s);
  return null;
}

export function resolveCrewId(name: string, crewsByName: Map<string, string>): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return crewsByName.get(key) ?? null;
}

export interface ScheduleAssignmentRow {
  external_id: string;
  assigned_crew_name: string;
  assigned_day_raw: string;
}

export interface ScheduleImportResult {
  rows: ScheduleAssignmentRow[];
  skipped: SkippedRow[];
}
```

> Note: `SkippedRow` is already exported from `src/lib/csv-import.ts` (no change needed there). `parseScheduleFile` is added in Task 6.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/schedule-import.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-import.ts src/lib/schedule-import.test.ts
git commit -m "feat: parseDayOfWeek + resolveCrewId helpers"
```

---

## Task 6: `parseScheduleFile` — standalone sheet parser (TDD)

**Files:**
- Modify: `src/lib/schedule-import.ts`
- Test: `src/lib/schedule-import.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/lib/schedule-import.test.ts`:

```ts
import { parseScheduleFile } from './schedule-import';

function csvBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('parseScheduleFile (CSV)', () => {
  it('parses external_id, crew, day rows', () => {
    const csv =
      'External ID,Crew,Day\n' +
      'P-1,Crew A,Monday\n' +
      'P-2,North Crew,3\n';
    const { rows, skipped } = parseScheduleFile('sched.csv', csvBuffer(csv));
    expect(skipped).toHaveLength(0);
    expect(rows).toEqual([
      { external_id: 'P-1', assigned_crew_name: 'Crew A', assigned_day_raw: 'Monday' },
      { external_id: 'P-2', assigned_crew_name: 'North Crew', assigned_day_raw: '3' },
    ]);
  });

  it('skips rows missing external_id, crew, or day', () => {
    const csv =
      'External ID,Crew,Day\n' +
      ',Crew A,Monday\n' +       // no external id
      'P-3,,Monday\n' +          // no crew
      'P-4,Crew A,\n';           // no day
    const { rows, skipped } = parseScheduleFile('sched.csv', csvBuffer(csv));
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(3);
    expect(skipped[0].reason).toMatch(/External ID/i);
    expect(skipped[1].reason).toMatch(/Crew/i);
    expect(skipped[2].reason).toMatch(/Day/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/schedule-import.test.ts`
Expected: FAIL — `parseScheduleFile` is not exported.

- [ ] **Step 3: Implement `parseScheduleFile`**

Append to `src/lib/schedule-import.ts`:

```ts
function getStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function mapScheduleRow(
  raw: Record<string, unknown>,
  rowNumber: number,
): ScheduleAssignmentRow | SkippedRow {
  const externalId = getStr(raw, 'External ID') || getStr(raw, 'Property ID');
  const crew = getStr(raw, 'Crew') || getStr(raw, 'Assigned Crew');
  const day = getStr(raw, 'Day') || getStr(raw, 'Service Day');

  const skip = (reason: string): SkippedRow => ({
    row_number: rowNumber,
    property_name: externalId || null,
    city: null,
    reason,
    raw,
  });

  if (!externalId) return skip("Missing External ID (column 'External ID' or 'Property ID')");
  if (!crew) return skip("Missing Crew (column 'Crew' or 'Assigned Crew')");
  if (!day) return skip("Missing Day (column 'Day' or 'Service Day')");

  return { external_id: externalId, assigned_crew_name: crew, assigned_day_raw: day };
}

function isSkipped(r: ScheduleAssignmentRow | SkippedRow): r is SkippedRow {
  return 'reason' in r;
}

function mapAll(rawRows: Array<Record<string, unknown>>): ScheduleImportResult {
  const rows: ScheduleAssignmentRow[] = [];
  const skipped: SkippedRow[] = [];
  rawRows.forEach((raw, idx) => {
    const result = mapScheduleRow(raw, idx + 2); // header is row 1
    if (isSkipped(result)) skipped.push(result);
    else rows.push(result);
  });
  return { rows, skipped };
}

export function parseScheduleFile(filename: string, buffer: ArrayBuffer): ScheduleImportResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { rows: [], skipped: [{ row_number: -1, property_name: null, city: null, reason: 'Workbook contains no sheets', raw: {} }] };
    }
    const sheet = workbook.Sheets[firstSheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
    const trimmed = json.map((row) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(row)) out[k.trim()] = row[k];
      return out;
    });
    return mapAll(trimmed);
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return mapAll(parsed.data);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/schedule-import.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-import.ts src/lib/schedule-import.test.ts
git commit -m "feat: parseScheduleFile standalone schedule sheet parser"
```

---

## Task 7: `schedule-compare.ts` — pure comparison (TDD)

**Files:**
- Create: `src/lib/schedule-compare.ts`
- Test: `src/lib/schedule-compare.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/schedule-compare.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { compareSchedules } from './schedule-compare';
import type { OptimizationRun, CrewDayRoute, CrewUtilization } from './types';

function stop(property_id: string, property_name: string) {
  return { property_id, property_name, address: 'x', lat: 0, lng: 0, arrival_time: '08:00', service_minutes: 30, drive_minutes_to: 5 };
}
function route(crew_id: string, crew_name: string, day: number, props: Array<[string, string]>): CrewDayRoute {
  return {
    crew_id, crew_name, day_of_week: day, branch_id: 'b1',
    start_time: '07:00', end_time: '15:00', clock_hours: 8, drive_hours: 1, drive_miles: 10,
    stops: props.map(([id, name]) => stop(id, name)),
  };
}
function util(crew_id: string, clock: number, drive: number, util_pct: number): CrewUtilization {
  return { crew_id, crew_name: crew_id, clock_hours: clock, drive_hours: drive, work_hours: clock - drive, util_pct, props_assigned: 0, drive_miles: drive * 10 };
}
function run(over: Partial<OptimizationRun>): OptimizationRun {
  return {
    id: 'r', name: 'r', target_week_start_date: '2026-06-01', active_branch_ids: null,
    active_crew_ids: null, active_property_ids: null, config_snapshot: null, status: 'completed',
    solver_runtime_seconds: 1, total_clock_hours_per_week: 0, total_labor_hours_per_week: 0,
    total_drive_hours_per_week: 0, total_drive_miles_per_week: 0, crew_utilization: [],
    capacity_recommendation: null, recommendation_text: null, routes_jsonb: { per_day: [] },
    unassigned_property_ids: null, failure_reason: null, started_at: null, completed_at: null,
    created_by: null, created_at: '2026-05-26', ...over,
  } as OptimizationRun;
}

describe('compareSchedules', () => {
  const baseline = run({
    total_clock_hours_per_week: 120, total_drive_hours_per_week: 30, total_drive_miles_per_week: 900,
    crew_utilization: [util('c1', 64, 16, 80), util('c2', 36, 8, 45)],
    capacity_recommendation: 'add_crew_recommended',
    routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['p2', 'P2']]), route('c2', 'Crew 2', 2, [['p3', 'P3']])] },
  });
  const optimized = run({
    total_clock_hours_per_week: 100, total_drive_hours_per_week: 18, total_drive_miles_per_week: 600,
    crew_utilization: [util('c1', 50, 9, 62), util('c2', 50, 9, 62)],
    capacity_recommendation: 'sufficient',
    routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1']]), route('c2', 'Crew 2', 4, [['p2', 'P2'], ['p3', 'P3']])] },
  });

  it('computes fleet deltas and percentages', () => {
    const c = compareSchedules(baseline, optimized);
    expect(c.fleet.driveHours.current).toBe(30);
    expect(c.fleet.driveHours.optimized).toBe(18);
    expect(c.fleet.driveHours.delta).toBe(-12);
    expect(c.fleet.driveHours.pct).toBeCloseTo(-0.4, 5);
    expect(c.fleet.activeCrews.current).toBe(2);
  });

  it('flags overloaded and underused crews from the current side', () => {
    const c = compareSchedules(baseline, optimized);
    const c1 = c.crews.find((x) => x.crewId === 'c1')!;
    const c2 = c.crews.find((x) => x.crewId === 'c2')!;
    expect(c1.flag).toBe('overloaded'); // 64h current
    expect(c2.flag).toBe('underused');  // 36h current
    expect(c1.deltaClock).toBe(50 - 64);
  });

  it('lists only properties that moved crew or day', () => {
    const c = compareSchedules(baseline, optimized);
    // p1: c1/day2 -> c1/day2 (unchanged, excluded)
    // p2: c1/day2 -> c2/day4 (moved)
    // p3: c2/day2 -> c2/day4 (moved day)
    const ids = c.changes.map((ch) => ch.propertyId).sort();
    expect(ids).toEqual(['p2', 'p3']);
    const p2 = c.changes.find((ch) => ch.propertyId === 'p2')!;
    expect(p2.from).toEqual({ crewName: 'Crew 1', day: 2 });
    expect(p2.to).toEqual({ crewName: 'Crew 2', day: 4 });
    expect(p2.changedCrew).toBe(true);
  });

  it('reports coverage differences', () => {
    const b = run({ routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['only-cur', 'X']])] } });
    const o = run({ routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['only-opt', 'Y']])] } });
    const c = compareSchedules(b, o);
    expect(c.coverage.onlyInCurrent).toEqual(['only-cur']);
    expect(c.coverage.onlyInOptimized).toEqual(['only-opt']);
  });

  it('returns no changes for identical runs', () => {
    const c = compareSchedules(optimized, optimized);
    expect(c.changes).toHaveLength(0);
    expect(c.fleet.driveHours.delta).toBe(0);
    expect(c.fleet.driveHours.pct).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/schedule-compare.test.ts`
Expected: FAIL — cannot find module `./schedule-compare`.

- [ ] **Step 3: Implement `compareSchedules`**

Create `src/lib/schedule-compare.ts`:

```ts
// Pure comparison of two optimization_runs rows (a baseline 'current' schedule
// vs an optimized run). No IO — reads persisted run fields only.
import type { OptimizationRun, CrewUtilization, CapacityRecommendation } from './types';

const OVERLOADED_HRS = 55; // current-side clock-hrs/wk above this = overloaded
const UNDERUSED_HRS = 40;  // active crew below this = underused

export interface FleetMetric {
  current: number;
  optimized: number;
  delta: number;
  pct: number; // delta / current (0 when current is 0)
}
export interface FleetDelta {
  clockHours: FleetMetric;
  driveHours: FleetMetric;
  driveMiles: FleetMetric;
  activeCrews: { current: number; optimized: number; delta: number };
  avgUtil: { current: number; optimized: number; delta: number };
}
export interface CrewDelta {
  crewId: string;
  crewName: string;
  currentClock: number;
  optimizedClock: number;
  deltaClock: number;
  currentUtil: number;
  optimizedUtil: number;
  flag: 'overloaded' | 'underused' | 'ok';
}
export interface PropertyChange {
  propertyId: string;
  propertyName: string;
  from: { crewName: string | null; day: number | null };
  to: { crewName: string | null; day: number | null };
  changedCrew: boolean;
  changedDay: boolean;
}
export interface CoverageNote {
  onlyInCurrent: string[];
  onlyInOptimized: string[];
}
export interface ScheduleComparison {
  fleet: FleetDelta;
  capacity: {
    currentBand: CapacityRecommendation | null;
    optimizedBand: CapacityRecommendation | null;
    verdict: string;
  };
  crews: CrewDelta[];
  changes: PropertyChange[];
  coverage: CoverageNote;
}

interface PlacedProp {
  propertyName: string;
  crewName: string;
  day: number;
}

function placement(run: OptimizationRun): Map<string, PlacedProp> {
  const map = new Map<string, PlacedProp>();
  for (const r of run.routes_jsonb?.per_day ?? []) {
    for (const s of r.stops) {
      map.set(s.property_id, { propertyName: s.property_name, crewName: r.crew_name, day: r.day_of_week });
    }
  }
  return map;
}

function metric(current: number, optimized: number): FleetMetric {
  const delta = optimized - current;
  return { current, optimized, delta, pct: current === 0 ? 0 : delta / current };
}

function activeCount(util: CrewUtilization[]): number {
  return util.filter((u) => u.clock_hours > 0).length;
}
function avgUtil(util: CrewUtilization[]): number {
  const active = util.filter((u) => u.clock_hours > 0);
  if (active.length === 0) return 0;
  return active.reduce((s, u) => s + u.util_pct, 0) / active.length;
}

export function compareSchedules(baseline: OptimizationRun, optimized: OptimizationRun): ScheduleComparison {
  const curUtil = baseline.crew_utilization ?? [];
  const optUtil = optimized.crew_utilization ?? [];

  const fleet: FleetDelta = {
    clockHours: metric(baseline.total_clock_hours_per_week ?? 0, optimized.total_clock_hours_per_week ?? 0),
    driveHours: metric(baseline.total_drive_hours_per_week ?? 0, optimized.total_drive_hours_per_week ?? 0),
    driveMiles: metric(baseline.total_drive_miles_per_week ?? 0, optimized.total_drive_miles_per_week ?? 0),
    activeCrews: {
      current: activeCount(curUtil),
      optimized: activeCount(optUtil),
      delta: activeCount(optUtil) - activeCount(curUtil),
    },
    avgUtil: {
      current: avgUtil(curUtil),
      optimized: avgUtil(optUtil),
      delta: avgUtil(optUtil) - avgUtil(curUtil),
    },
  };

  // Per-crew join by crew_id (union of both sides).
  const optByCrew = new Map(optUtil.map((u) => [u.crew_id, u]));
  const curByCrew = new Map(curUtil.map((u) => [u.crew_id, u]));
  const crewIds = Array.from(new Set([...curByCrew.keys(), ...optByCrew.keys()]));
  const crews: CrewDelta[] = crewIds.map((id) => {
    const cur = curByCrew.get(id);
    const opt = optByCrew.get(id);
    const currentClock = cur?.clock_hours ?? 0;
    const optimizedClock = opt?.clock_hours ?? 0;
    let flag: CrewDelta['flag'] = 'ok';
    if (currentClock > OVERLOADED_HRS) flag = 'overloaded';
    else if (currentClock > 0 && currentClock < UNDERUSED_HRS) flag = 'underused';
    return {
      crewId: id,
      crewName: cur?.crew_name ?? opt?.crew_name ?? id,
      currentClock,
      optimizedClock,
      deltaClock: optimizedClock - currentClock,
      currentUtil: cur?.util_pct ?? 0,
      optimizedUtil: opt?.util_pct ?? 0,
      flag,
    };
  });

  // Per-property diff from placements.
  const curPlace = placement(baseline);
  const optPlace = placement(optimized);
  const changes: PropertyChange[] = [];
  for (const [propertyId, cur] of curPlace) {
    const opt = optPlace.get(propertyId);
    if (!opt) continue; // coverage handles props absent from optimized
    const changedCrew = cur.crewName !== opt.crewName;
    const changedDay = cur.day !== opt.day;
    if (!changedCrew && !changedDay) continue;
    changes.push({
      propertyId,
      propertyName: opt.propertyName ?? cur.propertyName,
      from: { crewName: cur.crewName, day: cur.day },
      to: { crewName: opt.crewName, day: opt.day },
      changedCrew,
      changedDay,
    });
  }

  const coverage: CoverageNote = {
    onlyInCurrent: Array.from(curPlace.keys()).filter((id) => !optPlace.has(id)),
    onlyInOptimized: Array.from(optPlace.keys()).filter((id) => !curPlace.has(id)),
  };

  const verdict = buildVerdict(fleet, baseline.capacity_recommendation, optimized.capacity_recommendation);

  return {
    fleet,
    capacity: {
      currentBand: baseline.capacity_recommendation,
      optimizedBand: optimized.capacity_recommendation,
      verdict,
    },
    crews,
    changes,
    coverage,
  };
}

function buildVerdict(
  fleet: FleetDelta,
  currentBand: CapacityRecommendation | null,
  optimizedBand: CapacityRecommendation | null,
): string {
  const driveSaved = -fleet.driveHours.delta;
  const crewSlack = fleet.activeCrews.current - fleet.activeCrews.optimized;
  const parts: string[] = [];
  if (crewSlack > 0) {
    parts.push(`Optimizing covers the same work with ${crewSlack} fewer active crew${crewSlack === 1 ? '' : 's'}.`);
  } else if (crewSlack < 0) {
    parts.push(`The optimizer spreads work across ${-crewSlack} more crew${-crewSlack === 1 ? '' : 's'} to stay in band.`);
  } else {
    parts.push('Both plans use the same number of active crews.');
  }
  if (driveSaved > 0.5) parts.push(`Drive time drops ${driveSaved.toFixed(1)} hr/week.`);
  if (currentBand && optimizedBand && currentBand !== optimizedBand) {
    parts.push(`Capacity outlook improves from "${currentBand}" to "${optimizedBand}".`);
  }
  return parts.join(' ');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/schedule-compare.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/schedule-compare.ts src/lib/schedule-compare.test.ts
git commit -m "feat: compareSchedules pure comparison module"
```

---

## Task 8: `compare/actions.ts` — apply assignments + score baseline

**Files:**
- Create: `src/app/compare/actions.ts`

- [ ] **Step 1: Write the server action**

Create `src/app/compare/actions.ts`:

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseScheduleFile, parseDayOfWeek, resolveCrewId } from '@/lib/schedule-import';
import type { Branch, Crew, Property } from '@/lib/types';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export interface ScheduleScoreResult {
  ok: true;
  run_id: string;
  applied: number;
  skipped: number;
}
export type ScheduleActionResult = ScheduleScoreResult | { ok: false; error: string };

export async function uploadAndScoreSchedule(formData: FormData): Promise<ScheduleActionResult> {
  try {
    const file = formData.get('file');
    const name = String(formData.get('name') ?? '').trim() || `Current schedule ${new Date().toISOString().slice(0, 16)}`;
    const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'No file uploaded' };
    if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };

    const buffer = await file.arrayBuffer();
    const { rows, skipped } = parseScheduleFile(file.name, buffer);
    if (rows.length === 0) return { ok: false, error: 'No usable schedule rows found in file' };

    const supabase = getServiceClient();

    // Build crew-name -> id map (case/space-insensitive).
    const { data: crewRows } = await supabase.from('crews').select('id, name').eq('is_active', true);
    const crewsByName = new Map<string, string>();
    for (const c of (crewRows ?? []) as Array<{ id: string; name: string }>) {
      crewsByName.set(c.name.trim().toLowerCase(), c.id);
    }

    // Resolve each row to (crew_id, day). Bucket external_ids by (crew_id, day)
    // so we issue ONE update per distinct assignment (≈ crews × days, ~150 max)
    // instead of one per row — the per-row loop is what timed out a 564-row
    // re-import historically (see properties/actions.ts).
    let unresolved = skipped.length;
    const buckets = new Map<string, { crewId: string; day: number; externalIds: string[] }>();
    for (const r of rows) {
      const crewId = resolveCrewId(r.assigned_crew_name, crewsByName);
      const day = parseDayOfWeek(r.assigned_day_raw);
      if (!crewId || !day) {
        unresolved += 1;
        continue;
      }
      const key = `${crewId}::${day}`;
      const bucket = buckets.get(key) ?? { crewId, day, externalIds: [] };
      bucket.externalIds.push(r.external_id);
      buckets.set(key, bucket);
    }

    let applied = 0;
    for (const { crewId, day, externalIds } of buckets.values()) {
      const { data: updated, error } = await supabase
        .from('properties')
        .update({ assigned_crew_id: crewId, assigned_day_of_week: day })
        .in('external_id', externalIds)
        .select('id');
      if (error) throw new Error(error.message);
      applied += (updated ?? []).length; // counts only external_ids that matched a property
    }

    if (applied === 0) {
      return { ok: false, error: 'No schedule rows matched an existing property (check External IDs and crew names)' };
    }

    // Gather the same inputs the optimizer uses.
    const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
      supabase.from('crews').select('*').eq('is_active', true),
      supabase.from('branches').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('properties').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
    ]);
    const crews = (crewsData ?? []) as Crew[];
    const branches = (branchesData ?? []) as Branch[];
    const properties = (propsData ?? []) as Property[];

    const { data: run, error: runErr } = await supabase
      .from('optimization_runs')
      .insert({
        name,
        run_kind: 'baseline',
        target_week_start_date: targetWeek,
        active_branch_ids: branches.map((b) => b.id),
        active_crew_ids: crews.map((c) => c.id),
        active_property_ids: properties.map((p) => p.id),
        config_snapshot: { kind: 'baseline', applied, skipped: unresolved },
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (runErr || !run) return { ok: false, error: runErr?.message ?? 'Could not create baseline run' };

    // Fire-and-forget solver call in evaluate mode (same pattern as optimize).
    void invokeEvaluate(run.id, { crews, branches, properties }).catch(async (e) => {
      await supabase
        .from('optimization_runs')
        .update({ status: 'failed', failure_reason: e instanceof Error ? e.message : String(e), completed_at: new Date().toISOString() })
        .eq('id', run.id);
    });

    revalidatePath('/compare');
    return { ok: true, run_id: run.id, applied, skipped: unresolved };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function invokeEvaluate(runId: string, payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }) {
  if (!PYTHON_SOLVER_URL) {
    throw new Error('PYTHON_SOLVER_URL is not configured.');
  }
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, mode: 'evaluate', ...payload }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/compare/actions.ts
git commit -m "feat: uploadAndScoreSchedule action (apply assignments + evaluate)"
```

---

## Task 9: `/compare` page + components

**Files:**
- Create: `src/app/compare/page.tsx`, `compare-selectors.tsx`, `upload-schedule.tsx`, `fleet-summary.tsx`, `crew-deltas.tsx`, `property-changes.tsx`

- [ ] **Step 1: Fleet + capacity cards**

Create `src/app/compare/fleet-summary.tsx`:

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScheduleComparison } from '@/lib/schedule-compare';

function Stat({ label, current, optimized, delta, unit, lowerIsBetter = true }: {
  label: string; current: number; optimized: number; delta: number; unit: string; lowerIsBetter?: boolean;
}) {
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">
          {optimized.toFixed(0)}<span className="text-sm font-normal text-muted-foreground"> {unit}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        current {current.toFixed(0)} {unit} ·{' '}
        <span className={improved ? 'text-emerald-600' : delta === 0 ? '' : 'text-amber-700'}>
          {delta > 0 ? '+' : ''}{delta.toFixed(0)} {unit}
        </span>
      </CardContent>
    </Card>
  );
}

export function FleetSummary({ comparison }: { comparison: ScheduleComparison }) {
  const f = comparison.fleet;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Drive hrs/wk" current={f.driveHours.current} optimized={f.driveHours.optimized} delta={f.driveHours.delta} unit="hr" />
        <Stat label="Drive miles/wk" current={f.driveMiles.current} optimized={f.driveMiles.optimized} delta={f.driveMiles.delta} unit="mi" />
        <Stat label="Clock hrs/wk" current={f.clockHours.current} optimized={f.clockHours.optimized} delta={f.clockHours.delta} unit="hr" />
        <Stat label="Active crews" current={f.activeCrews.current} optimized={f.activeCrews.optimized} delta={f.activeCrews.delta} unit="" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Capacity verdict</CardTitle>
          <CardDescription>
            current: {comparison.capacity.currentBand ?? '—'} · optimized: {comparison.capacity.optimizedBand ?? '—'}
          </CardDescription>
        </CardHeader>
        <CardContent><p className="text-sm">{comparison.capacity.verdict}</p></CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Per-crew table**

Create `src/app/compare/crew-deltas.tsx`:

```tsx
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatHours } from '@/lib/utils';
import type { CrewDelta } from '@/lib/schedule-compare';

function flagBadge(flag: CrewDelta['flag']) {
  if (flag === 'overloaded') return <Badge variant="destructive">overloaded</Badge>;
  if (flag === 'underused') return <Badge variant="secondary">underused</Badge>;
  return <Badge variant="success">ok</Badge>;
}

export function CrewDeltas({ crews }: { crews: CrewDelta[] }) {
  const sorted = [...crews].sort((a, b) => a.currentClock - b.currentClock).reverse();
  return (
    <Card>
      <CardHeader><CardTitle>Per-crew rebalancing</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Crew</TableHead>
              <TableHead className="text-right">Current</TableHead>
              <TableHead className="text-right">Optimized</TableHead>
              <TableHead className="text-right">Δ clock</TableHead>
              <TableHead className="text-right">Status (today)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c) => (
              <TableRow key={c.crewId}>
                <TableCell className="font-medium">{c.crewName}</TableCell>
                <TableCell className="text-right">{formatHours(c.currentClock)}</TableCell>
                <TableCell className="text-right">{formatHours(c.optimizedClock)}</TableCell>
                <TableCell className="text-right">{c.deltaClock > 0 ? '+' : ''}{c.deltaClock.toFixed(1)}</TableCell>
                <TableCell className="text-right">{flagBadge(c.flag)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Per-property change list**

Create `src/app/compare/property-changes.tsx`:

```tsx
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayName } from '@/lib/utils';
import type { PropertyChange, CoverageNote } from '@/lib/schedule-compare';

export function PropertyChanges({
  changes, coverage, baselineId, optimizedId,
}: {
  changes: PropertyChange[]; coverage: CoverageNote; baselineId: string; optimizedId: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Per-property reassignments</CardTitle>
          <CardDescription>{changes.length} properties move crew or day</CardDescription>
        </div>
        <Link
          href={`/compare/export?baseline=${baselineId}&optimized=${optimizedId}`}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          Export CSV →
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {changes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No reassignments — the current schedule already matches the optimized plan.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>From (current)</TableHead>
                <TableHead>To (optimized)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((c) => (
                <TableRow key={c.propertyId}>
                  <TableCell className="font-medium">{c.propertyName}</TableCell>
                  <TableCell className="text-muted-foreground">{c.from.crewName ?? '—'} · {dayName(c.from.day)}</TableCell>
                  <TableCell>{c.to.crewName ?? '—'} · {dayName(c.to.day)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(coverage.onlyInCurrent.length > 0 || coverage.onlyInOptimized.length > 0) && (
          <p className="border-t p-3 text-xs text-muted-foreground">
            Coverage note: {coverage.onlyInCurrent.length} propert{coverage.onlyInCurrent.length === 1 ? 'y' : 'ies'} scheduled
            only in the current plan, {coverage.onlyInOptimized.length} only in the optimized plan. Deltas cover the overlap.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run selectors (client)**

Create `src/app/compare/compare-selectors.tsx`:

```tsx
'use client';
import { useRouter, useSearchParams } from 'next/navigation';

interface RunOption { id: string; name: string; created_at: string; }

export function CompareSelectors({
  baselines, optimized, baselineId, optimizedId,
}: {
  baselines: RunOption[]; optimized: RunOption[]; baselineId: string | null; optimizedId: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function set(key: 'baseline' | 'optimized', value: string) {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.push(`/compare?${next.toString()}`);
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Current (baseline)</span>
        <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={baselineId ?? ''} onChange={(e) => set('baseline', e.target.value)}>
          <option value="" disabled>Select a baseline…</option>
          {baselines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Optimized run</span>
        <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={optimizedId ?? ''} onChange={(e) => set('optimized', e.target.value)}>
          <option value="" disabled>Select an optimized run…</option>
          {optimized.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
    </div>
  );
}
```

- [ ] **Step 5: Upload form (client)**

Create `src/app/compare/upload-schedule.tsx`:

```tsx
'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { uploadAndScoreSchedule } from './actions';

export function UploadSchedule({ defaultWeek }: { defaultWeek: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload current schedule</CardTitle>
        <CardDescription>
          A CSV/XLSX keyed by <code>External ID</code> with <code>Crew</code> and <code>Day</code> columns. Properties must
          already exist (from an Aspire import). Scoring runs the same solver in evaluate mode and creates a baseline run.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={(fd) => {
            setError(null);
            startTransition(async () => {
              try {
                const r = await uploadAndScoreSchedule(fd);
                if (r.ok) router.push(`/compare?baseline=${r.run_id}`);
                else setError(r.error);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Upload failed');
              }
            });
          }}
          className="grid gap-4 md:grid-cols-3"
        >
          <div className="md:col-span-2">
            <Label htmlFor="name">Baseline name</Label>
            <Input id="name" name="name" placeholder="Current schedule — June 2026" />
          </div>
          <div>
            <Label htmlFor="target_week_start_date">Week starting (Monday)</Label>
            <Input id="target_week_start_date" name="target_week_start_date" type="date" defaultValue={defaultWeek} required />
          </div>
          <div className="md:col-span-3 flex items-center gap-3">
            <input
              type="file" name="file" required
              accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
            />
            <Button type="submit" disabled={pending}>{pending ? 'Scoring…' : 'Upload & score'}</Button>
          </div>
          {error && <p className="md:col-span-3 text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6: The page**

Create `src/app/compare/page.tsx`:

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { compareSchedules } from '@/lib/schedule-compare';
import { CompareSelectors } from './compare-selectors';
import { UploadSchedule } from './upload-schedule';
import { FleetSummary } from './fleet-summary';
import { CrewDeltas } from './crew-deltas';
import { PropertyChanges } from './property-changes';

export const dynamic = 'force-dynamic';

function nextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

export default async function ComparePage({ searchParams }: { searchParams: { baseline?: string; optimized?: string } }) {
  const supabase = getServerClient();

  const [{ data: baselineRows }, { data: optimizedRows }] = await Promise.all([
    supabase.from('optimization_runs').select('id, name, created_at, status').eq('run_kind', 'baseline').eq('status', 'completed').order('created_at', { ascending: false }).limit(20),
    supabase.from('optimization_runs').select('id, name, created_at, status').eq('run_kind', 'optimized').eq('status', 'completed').order('created_at', { ascending: false }).limit(20),
  ]);
  const baselines = (baselineRows ?? []) as Array<{ id: string; name: string; created_at: string }>;
  const optimized = (optimizedRows ?? []) as Array<{ id: string; name: string; created_at: string }>;

  const baselineId = searchParams.baseline ?? baselines[0]?.id ?? null;
  const optimizedId = searchParams.optimized ?? optimized[0]?.id ?? null;

  let baselineRun: OptimizationRun | null = null;
  let optimizedRun: OptimizationRun | null = null;
  if (baselineId && optimizedId) {
    const [{ data: b }, { data: o }] = await Promise.all([
      supabase.from('optimization_runs').select('*').eq('id', baselineId).maybeSingle(),
      supabase.from('optimization_runs').select('*').eq('id', optimizedId).maybeSingle(),
    ]);
    baselineRun = (b as OptimizationRun) ?? null;
    optimizedRun = (o as OptimizationRun) ?? null;
  }

  const comparison = baselineRun && optimizedRun ? compareSchedules(baselineRun, optimizedRun) : null;
  const weekMismatch =
    baselineRun && optimizedRun && baselineRun.target_week_start_date !== optimizedRun.target_week_start_date;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Current vs optimized</h1>
        <p className="text-sm text-muted-foreground">
          Score your real-world schedule on the same yardstick as the optimizer and see what to change.
        </p>
      </div>

      <UploadSchedule defaultWeek={nextMonday()} />

      {baselines.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No baseline yet</CardTitle>
            <CardDescription>Upload a current schedule above to create one.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <CompareSelectors baselines={baselines} optimized={optimized} baselineId={baselineId} optimizedId={optimizedId} />

          {weekMismatch && (
            <Card className="border-amber-300">
              <CardContent className="pt-4 text-sm text-amber-800">
                These runs target different weeks ({baselineRun!.target_week_start_date} vs {optimizedRun!.target_week_start_date}).
                Deltas are approximate.
              </CardContent>
            </Card>
          )}

          {comparison ? (
            <>
              <FleetSummary comparison={comparison} />
              <CrewDeltas crews={comparison.crews} />
              <PropertyChanges changes={comparison.changes} coverage={comparison.coverage} baselineId={baselineId!} optimizedId={optimizedId!} />
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardDescription>Pick a baseline and an optimized run to compare.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Verify typecheck + build**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/compare/page.tsx src/app/compare/compare-selectors.tsx src/app/compare/upload-schedule.tsx src/app/compare/fleet-summary.tsx src/app/compare/crew-deltas.tsx src/app/compare/property-changes.tsx
git commit -m "feat: /compare page with fleet, crew, and property deltas"
```

---

## Task 10: CSV export of the change list + nav link

**Files:**
- Create: `src/app/compare/export/route.ts`
- Modify: `src/components/top-nav.tsx`

- [ ] **Step 1: Write the export route**

Create `src/app/compare/export/route.ts`:

```ts
import { getServiceClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { compareSchedules } from '@/lib/schedule-compare';
import { dayName } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const baselineId = url.searchParams.get('baseline');
  const optimizedId = url.searchParams.get('optimized');
  if (!baselineId || !optimizedId) return new Response('baseline and optimized query params required', { status: 400 });

  const supabase = getServiceClient();
  const [{ data: b }, { data: o }] = await Promise.all([
    supabase.from('optimization_runs').select('*').eq('id', baselineId).maybeSingle(),
    supabase.from('optimization_runs').select('*').eq('id', optimizedId).maybeSingle(),
  ]);
  if (!b || !o) return new Response('run not found', { status: 404 });

  const comparison = compareSchedules(b as OptimizationRun, o as OptimizationRun);
  const header = ['property', 'from_crew', 'from_day', 'to_crew', 'to_day', 'changed_crew', 'changed_day'];
  const lines = [header.join(',')];
  for (const c of comparison.changes) {
    const cells = [
      c.propertyName,
      c.from.crewName ?? '', dayName(c.from.day),
      c.to.crewName ?? '', dayName(c.to.day),
      String(c.changedCrew), String(c.changedDay),
    ].map((v) => `"${(v ?? '').replace(/"/g, '""')}"`);
    lines.push(cells.join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="reassignments-${baselineId.slice(0, 8)}.csv"`,
    },
  });
}
```

- [ ] **Step 2: Add the nav link**

In `src/components/top-nav.tsx`, the `NAV` array ends with `{ href: '/capacity', label: 'Capacity' }`. Add after it:

```ts
  { href: '/compare', label: 'Compare' },
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/compare/export/route.ts src/components/top-nav.tsx
git commit -m "feat: reassignment CSV export + Compare nav link"
```

---

## Task 11: Optional Aspire crew/day columns (Path A)

Extend the existing Aspire importer so an export that *includes* crew/day columns
also sets the assignments. Absent columns → unchanged behavior.

**Files:**
- Modify: `src/lib/csv-import.ts`
- Modify: `src/app/properties/actions.ts`
- Test: `src/lib/csv-import.test.ts` (create)

- [ ] **Step 1: Write a failing test for the new optional fields**

Create `src/lib/csv-import.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseAspireCsv } from './csv-import';

describe('parseAspireCsv crew/day columns', () => {
  it('captures Crew and Service Day when present', () => {
    const csv =
      'Property,Property Address 1,Property City,Service Abr,Est Hrs,Crew,Service Day\n' +
      'Acme HQ,1 Main St,SLC,Weekly,2,Crew A,Tuesday\n';
    const { rows } = parseAspireCsv(csv);
    expect(rows[0].assigned_crew_name).toBe('Crew A');
    expect(rows[0].assigned_day_raw).toBe('Tuesday');
  });
  it('leaves them null when columns are absent', () => {
    const csv =
      'Property,Property Address 1,Property City,Service Abr,Est Hrs\n' +
      'Acme HQ,1 Main St,SLC,Weekly,2\n';
    const { rows } = parseAspireCsv(csv);
    expect(rows[0].assigned_crew_name).toBeNull();
    expect(rows[0].assigned_day_raw).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/csv-import.test.ts`
Expected: FAIL — `assigned_crew_name` not on the row type.

- [ ] **Step 3: Add the optional fields to `AspireImportRow` + `mapRow`**

In `src/lib/csv-import.ts`, add to the `AspireImportRow` interface:

```ts
  assigned_crew_name: string | null;
  assigned_day_raw: string | null;
```

In `mapRow`, just before the final `return {`, add:

```ts
  const assignedCrew = getStr(raw, 'Crew') || getStr(raw, 'Assigned Crew') || null;
  const assignedDay = getStr(raw, 'Service Day') || getStr(raw, 'Day') || null;
```

And add these two keys to the returned object:

```ts
    assigned_crew_name: assignedCrew,
    assigned_day_raw: assignedDay,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/csv-import.test.ts`
Expected: PASS.

- [ ] **Step 5: Resolve + apply assignments in the import action**

In `src/app/properties/actions.ts`, the `applyRows` function currently writes
property fields only. The new `assigned_crew_name`/`assigned_day_raw` are *not* DB
columns, so they must be stripped before upsert and resolved separately. After the
existing `applyRows(rows)` call in `importAspireCsv` (just before the
`import_runs` update), add a resolution pass:

```ts
    // Path A: if the export carried crew/day columns, resolve + apply assignments.
    const withAssignment = rows.filter((r) => r.assigned_crew_name && r.assigned_day_raw && r.external_id);
    if (withAssignment.length > 0) {
      const { resolveCrewId, parseDayOfWeek } = await import('@/lib/schedule-import');
      const { data: crewRows } = await supabase.from('crews').select('id, name').eq('is_active', true);
      const crewsByName = new Map<string, string>();
      for (const c of (crewRows ?? []) as Array<{ id: string; name: string }>) crewsByName.set(c.name.trim().toLowerCase(), c.id);
      // Bucket by (crew_id, day) → one update per distinct assignment, not per row.
      const buckets = new Map<string, { crewId: string; day: number; externalIds: string[] }>();
      for (const r of withAssignment) {
        const crewId = resolveCrewId(r.assigned_crew_name!, crewsByName);
        const day = parseDayOfWeek(r.assigned_day_raw);
        if (!crewId || !day) continue;
        const key = `${crewId}::${day}`;
        const bucket = buckets.get(key) ?? { crewId, day, externalIds: [] };
        bucket.externalIds.push(r.external_id!);
        buckets.set(key, bucket);
      }
      for (const { crewId, day, externalIds } of buckets.values()) {
        await supabase.from('properties').update({ assigned_crew_id: crewId, assigned_day_of_week: day }).in('external_id', externalIds);
      }
    }
```

Then ensure `applyRows`' upsert payloads never include the two non-column fields.
The `withExt` branch upserts `withExt` directly; strip there:

```ts
    const { error } = await supabase.from('properties').upsert(
      withExt.map(({ assigned_crew_name, assigned_day_raw, ...rest }) => rest),
      { onConflict: 'external_id' },
    );
```

The `toInsert` branch likewise:

```ts
      const { error } = await supabase.from('properties').insert(
        toInsert.map(({ assigned_crew_name, assigned_day_raw, ...rest }) => rest),
      );
```

(The `toUpdate` branch already builds an explicit payload, so it is unaffected.)

- [ ] **Step 6: Verify typecheck + tests**

Run: `npm run typecheck && npm run test`
Expected: typecheck clean; all vitest suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/csv-import.ts src/lib/csv-import.test.ts src/app/properties/actions.ts
git commit -m "feat: optional Aspire crew/day columns set current-schedule assignments"
```

---

## Task 12: Full verification pass

- [ ] **Step 1: Run the whole test suite**

Run: `npm run test`
Expected: PASS — `schedule-import`, `schedule-compare`, `csv-import`, plus the pre-existing suites.

- [ ] **Step 2: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 3: Python grouping check**

Run: `python3 solver/api/check_grouping.py`
Expected: `check_grouping: PASS`

- [ ] **Step 4: Manual end-to-end (after running the migration + redeploying the solver)**

1. Apply the Task 1 SQL via `supabase db push` (or paste into the SQL editor).
2. Redeploy the solver project (it has the new `evaluate` mode).
3. On `/compare`, upload a small schedule sheet (`External ID,Crew,Day`) for
   properties that exist; confirm it redirects with `?baseline=<id>` and the
   baseline run reaches `completed`.
4. Pick an optimized run; confirm fleet stats, the per-crew table (over/under
   flags), and the reassignment list render, and that "Export CSV" downloads.

- [ ] **Step 5: Commit any fixes from the manual pass, then the plan is complete.**

---

## Notes for the executor

- **Migration is never auto-applied.** Surface the Task 1 SQL to the user in the
  PR/response so they can `supabase db push` before deploy.
- **Solver is a separate project** rooted at `solver/`. Evaluate mode only works
  once that project redeploys; the web side fails the baseline run gracefully
  (status `failed`, `failure_reason`) if `PYTHON_SOLVER_URL` is unset.
- **Fairness assumption (from the spec):** evaluate mode TSP-orders each crew-day
  and relaxes capacity, so the comparison isolates the assignment decision, not
  stop-sequencing. Don't "fix" the relaxed capacity — it's intentional.
- **DRY:** `parseDayOfWeek`/`resolveCrewId` live only in `schedule-import.ts`; both
  the standalone upload and the Aspire path import them. The solver's aggregation
  lives only in `_aggregate_result`.
```
