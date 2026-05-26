# Crew-Size-Aware + Splittable-Workload Solver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OR-Tools solver compute each job's time from the actual crew size (`labor ÷ crew_size`) and split large properties into work-chunks the solver spreads across multiple crews and multiple days (including mixed 2- and 3-person crews on one property the same day).

**Architecture:** Properties become **work-chunks** before routing: a property a single crew can do in a day (`≤ max_crew_size × max_day`) stays one node; bigger ones split into one-person-day (`shift`) chunks at the same coordinates (zero inter-chunk travel). `solve_day` gets **per-crew-size service times** via per-vehicle transit callbacks + per-vehicle daily caps, so big chunks fit only on big-enough crews and crew-days pack tightly. Chunks carry their parent `property_id`; aggregation maps chunk results back to properties (distinct-property counts; a property is unassigned if any chunk is).

**Tech Stack:** Python (OR-Tools `pywrapcp`) in `solver/api/`; TypeScript types in `src/lib/types.ts`. Pure helpers checked with standalone `python3` scripts (OR-Tools not required); the VRP wiring is parse-checked locally and behavior-verified after the solver redeploys.

---

## Critical constraints for the implementer

- **OR-Tools is NOT installed in this workspace.** `solver/api/index.py` guards `from solver_logic import solve_day` in a try/except, so it imports fine without OR-Tools — that's why the pure-helper check scripts work. But `solve_day` itself (Task 5) cannot run locally. For Task 5: implement, `ast.parse`-check, commit, and rely on the Task 7 post-deploy manual checks.
- **Verify the OR-Tools API in Task 5 before wiring** (`AddDimensionWithVehicleTransits`, `SetArcCostEvaluatorOfVehicle`, per-vehicle `CumulVar(End(v)).SetMax`). If a call isn't in the pinned `ortools`, use the fallback noted in Task 5.
- The solver is a **separate deploy** (rooted at `solver/`). Nothing here runs in prod until that project redeploys.
- Keep `run_evaluation` (baseline scoring) working — it shares `solve_day` and `_properties_for_solver`.

---

## File Structure

- `solver/api/index.py` — **Modify:** add `_chunk_thresholds`, `chunk_labor`; rewrite `_properties_for_solver` to emit chunks; make `_bucketize_properties` chunk-aware; update `_aggregate_result` (distinct-property counts + property-level unassigned); update `run_optimization`/`run_evaluation` call sites.
- `solver/api/solver_logic.py` — **Modify:** `solve_day` (per-crew-size service + per-vehicle transit/caps) and `_extract_routes` (crew-size service, chunk stops).
- `solver/api/check_chunking.py` — **Create:** standalone assertions for the pure helpers (no OR-Tools).
- `src/lib/types.ts` — **Modify:** add optional `chunk_index?`/`chunk_count?` to `RouteStop`.

No DB/schema change, no migration.

---

## Task 1: `chunk_labor` + `_chunk_thresholds` (pure)

**Files:**
- Modify: `solver/api/index.py`
- Create: `solver/api/check_chunking.py`

- [ ] **Step 1: Add the two pure helpers to `index.py`**

Add near the other helpers (e.g. just above `_properties_for_solver`):

```python
def _chunk_thresholds(crews: list[dict[str, Any]]) -> tuple[float, float]:
    """Return (single_day_max, shift) in person-hours.

      single_day_max = the most a single crew can do in one day
                     = max over crews of (crew_size * max_clock_hours_per_day).
                       A property at/under this stays one stop.
      shift          = one person-day = the smallest crew's max_clock_hours_per_day.
                       Splitting uses this unit so a size-s crew clears ~s chunks/day.
    """
    if not crews:
        return 30.0, 10.0
    per_crew_day = [
        int(c.get("crew_size") or 2) * float(c.get("max_clock_hours_per_day") or 8) for c in crews
    ]
    shift_candidates = [float(c.get("max_clock_hours_per_day") or 8) for c in crews]
    single_day_max = max(per_crew_day)
    shift = min(shift_candidates)
    if shift <= 0:
        shift = single_day_max
    return single_day_max, shift


def chunk_labor(labor_hours: float, single_day_max: float, shift: float) -> list[float]:
    """Split a property's person-hours into work-chunks.

      labor <= single_day_max -> [labor]            (one stop; don't fragment work
                                                      a single crew can do in a day)
      otherwise               -> shift-sized chunks + remainder (so multiple crews
                                                      across multiple days cover it)
    """
    if labor_hours <= single_day_max:
        return [labor_hours]
    chunks: list[float] = []
    remaining = labor_hours
    while remaining > 1e-9:
        take = shift if remaining - shift > 1e-9 else remaining
        chunks.append(round(take, 4))
        remaining -= take
    return chunks
```

- [ ] **Step 2: Create the check script**

Create `solver/api/check_chunking.py`:

```python
"""Standalone checks for the pure chunking/aggregation helpers.
Run: python3 solver/api/check_chunking.py
Imports without OR-Tools because index.py guards the solver_logic import.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _chunk_thresholds, chunk_labor


def approx(a, b, eps=1e-6):
    return abs(a - b) < eps


# --- _chunk_thresholds ---
crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10},
    {"crew_size": 3, "max_clock_hours_per_day": 10},
]
single_day_max, shift = _chunk_thresholds(crews)
assert single_day_max == 30.0, single_day_max  # 3 * 10
assert shift == 10.0, shift                     # min daily hours
assert _chunk_thresholds([]) == (30.0, 10.0)

# --- chunk_labor ---
assert chunk_labor(12, 30, 10) == [12], "<= single_day_max stays whole"
assert chunk_labor(30, 30, 10) == [30], "exactly single_day_max stays whole"
assert chunk_labor(35, 30, 10) == [10, 10, 10, 5], chunk_labor(35, 30, 10)
c250 = chunk_labor(250, 30, 10)
assert len(c250) == 25 and approx(sum(c250), 250), (len(c250), sum(c250))
c = chunk_labor(132.6, 30, 10)
assert approx(sum(c), 132.6), sum(c)
assert all(x <= 10 + 1e-9 for x in c), c
assert c[-1] > 0, "no zero-padded remainder"

print("check_chunking: PASS (thresholds + chunk_labor)")
```

- [ ] **Step 3: Run the check**

Run: `python3 solver/api/check_chunking.py`
Expected: `check_chunking: PASS (thresholds + chunk_labor)`

- [ ] **Step 4: Parse-check `index.py`**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): chunk_labor + crew-day thresholds (pure)"
```

---

## Task 2: `_properties_for_solver` emits work-chunks

**Files:**
- Modify: `solver/api/index.py` (`_properties_for_solver`)
- Modify: `solver/api/check_chunking.py`

- [ ] **Step 1: Add failing assertions to the check script**

Append to `solver/api/check_chunking.py` (before the final `print`, and add a new print):

```python
from index import _properties_for_solver

_crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10},
    {"crew_size": 3, "max_clock_hours_per_day": 10},
]
# single_day_max = 30, shift = 10
base = {"address": "1 Main", "lat": 40.0, "lng": -111.0,
        "preferred_day_of_week": None, "assigned_day_of_week": 2, "assigned_crew_id": "c1"}
props = [
    {"id": "small", "name": "Small", "est_labor_hours": 12, **base},   # <=30 -> 1 chunk
    {"id": "big", "name": "Big Park", "est_labor_hours": 35, **base},  # ->10,10,10,5 = 4 chunks
    {"id": "nogeo", "name": "NoGeo", "est_labor_hours": 5,
     "address": "x", "lat": None, "lng": None,
     "preferred_day_of_week": None, "assigned_day_of_week": None, "assigned_crew_id": None},
]
chunks = _properties_for_solver(props, _crews)

# ungeocoded dropped
assert all(c["property_id"] != "nogeo" for c in chunks)
# single-chunk property: id == property_id, no "(k/n)" suffix, chunk_count 1
small = [c for c in chunks if c["property_id"] == "small"]
assert len(small) == 1 and small[0]["id"] == "small" and small[0]["chunk_count"] == 1
assert small[0]["name"] == "Small" and approx(small[0]["labor_hours"], 12)
# multi-chunk property: 4 chunks, ids "big#1".."big#4", labelled, labor sums to 35
big = [c for c in chunks if c["property_id"] == "big"]
assert len(big) == 4 and [c["id"] for c in big] == ["big#1", "big#2", "big#3", "big#4"]
assert big[0]["name"] == "Big Park (1/4)" and big[0]["chunk_index"] == 1 and big[0]["chunk_count"] == 4
assert approx(sum(c["labor_hours"] for c in big), 35)
# assigned_* inherited on every chunk (so evaluate mode can group them)
assert all(c["assigned_crew_id"] == "c1" and c["assigned_day_of_week"] == 2 for c in big)

print("check_chunking: PASS (properties_for_solver)")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 solver/api/check_chunking.py`
Expected: FAIL — current `_properties_for_solver` takes `(props, crew_size_default=2)` and emits `est_clock_hours`, not chunks (TypeError on the `_crews` arg, or AssertionError).

- [ ] **Step 3: Rewrite `_properties_for_solver`**

Replace the whole function in `solver/api/index.py` with:

```python
def _properties_for_solver(
    props: list[dict[str, Any]], crews: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Convert properties into routable work-chunks (person-hours per chunk).

    A property a single crew can do in a day stays one chunk; bigger ones split
    into one-person-day chunks at the same coordinates. Service time is NOT
    pre-divided here — solve_day applies labor ÷ crew_size per assigned crew.
    Ungeocoded properties are skipped (the map/optimizer can't place them).
    """
    single_day_max, shift = _chunk_thresholds(crews)
    out: list[dict[str, Any]] = []
    for p in props:
        if p.get("lat") is None or p.get("lng") is None:
            continue
        pieces = chunk_labor(float(p["est_labor_hours"]), single_day_max, shift)
        n = len(pieces)
        for k, piece in enumerate(pieces, start=1):
            chunk_id = p["id"] if n == 1 else f'{p["id"]}#{k}'
            name = p["name"] if n == 1 else f'{p["name"]} ({k}/{n})'
            out.append(
                {
                    "id": chunk_id,
                    "property_id": p["id"],
                    "name": name,
                    "address": p["address"],
                    "lat": p["lat"],
                    "lng": p["lng"],
                    "labor_hours": piece,
                    "preferred_day_of_week": p.get("preferred_day_of_week"),
                    "assigned_day_of_week": p.get("assigned_day_of_week"),
                    "assigned_crew_id": p.get("assigned_crew_id"),
                    "chunk_index": k,
                    "chunk_count": n,
                }
            )
    return out
```

- [ ] **Step 4: Update the two call sites**

In `run_optimization` and `run_evaluation` (both in `index.py`), change:

```python
    solver_props = _properties_for_solver(properties)
```
to:
```python
    solver_props = _properties_for_solver(properties, crews)
```

(Both functions already bind `crews = payload["crews"]` above that line.)

- [ ] **Step 5: Run the check + parse-check**

Run: `python3 solver/api/check_chunking.py`
Expected: ends with `check_chunking: PASS (properties_for_solver)`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): emit work-chunks from _properties_for_solver"
```

---

## Task 3: chunk-aware `_bucketize_properties`

**Files:**
- Modify: `solver/api/index.py` (`_bucketize_properties`)
- Modify: `solver/api/check_chunking.py`

- [ ] **Step 1: Add failing assertions**

Append to `solver/api/check_chunking.py` (before the existing final print, then add a print):

```python
from index import _bucketize_properties

# Two crews working Mon-Fri so all 5 weekdays are work_days.
bucket_crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10,
     "works_monday": True, "works_tuesday": True, "works_wednesday": True,
     "works_thursday": True, "works_friday": True},
]
# single-chunk property assigned to Tuesday(2) must stay sticky on day 2;
# a multi-chunk (split) property must spread across days (not all on its assigned day).
sticky_chunk = {"id": "s", "property_id": "s", "labor_hours": 8, "lat": 40.0, "lng": -111.0,
                "assigned_day_of_week": 2, "chunk_count": 1}
split_chunks = [
    {"id": f"b#{k}", "property_id": "b", "labor_hours": 10, "lat": 40.1, "lng": -111.1,
     "assigned_day_of_week": 2, "chunk_count": 4}
    for k in range(1, 5)
]
buckets = _bucketize_properties([sticky_chunk, *split_chunks], bucket_crews)
# sticky single-chunk honored on day 2
assert any(c["id"] == "s" for c in buckets[2]), "single-chunk sticky to assigned day"
# split chunks did NOT all land on day 2 (they spread)
split_days = [d for d, items in buckets.items() for c in items if c["property_id"] == "b"]
assert len(set(split_days)) > 1, f"split property should spread across days, got {split_days}"

print("check_chunking: PASS (bucketize)")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 solver/api/check_chunking.py`
Expected: FAIL — current bucketize keys load on `est_clock_hours` (KeyError) and makes any `assigned_day_of_week` sticky regardless of `chunk_count`.

- [ ] **Step 3: Update `_bucketize_properties`**

In `solver/api/index.py`, replace the sticky/free split and the load-balancing field. Find:

```python
    sticky: list[dict[str, Any]] = []
    free: list[dict[str, Any]] = []
    for p in properties:
        if p.get("assigned_day_of_week") in work_days:
            sticky.append(p)
        else:
            free.append(p)

    for p in sticky:
        buckets[p["assigned_day_of_week"]].append(p)

    # Sort free properties by lat (rough geographic banding) then balance by load.
    free.sort(key=lambda p: (float(p["lat"] or 0), float(p["lng"] or 0)))
    day_loads: dict[int, float] = {d: sum(float(x["est_clock_hours"]) for x in buckets[d]) for d in work_days}

    for p in free:
        target = min(work_days, key=lambda d: day_loads[d])
        buckets[target].append(p)
        day_loads[target] += float(p["est_clock_hours"])
```

Replace with (only a property whose chunk_count == 1 is sticky; split properties spread; load balanced on person-hours):

```python
    sticky: list[dict[str, Any]] = []
    free: list[dict[str, Any]] = []
    for p in properties:
        # Single-chunk properties honor their assigned day. Multi-chunk (split)
        # properties must span days, so they go into the free pool to spread.
        if p.get("chunk_count", 1) == 1 and p.get("assigned_day_of_week") in work_days:
            sticky.append(p)
        else:
            free.append(p)

    for p in sticky:
        buckets[p["assigned_day_of_week"]].append(p)

    # Sort free chunks by lat (rough geographic banding) then balance by labor-hours.
    free.sort(key=lambda p: (float(p["lat"] or 0), float(p["lng"] or 0)))
    day_loads: dict[int, float] = {d: sum(float(x["labor_hours"]) for x in buckets[d]) for d in work_days}

    for p in free:
        target = min(work_days, key=lambda d: day_loads[d])
        buckets[target].append(p)
        day_loads[target] += float(p["labor_hours"])
```

- [ ] **Step 4: Run the check + parse-check**

Run: `python3 solver/api/check_chunking.py`
Expected: ends with `check_chunking: PASS (bucketize)`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): chunk-aware bucketize (split props spread across days)"
```

---

## Task 4: chunk-aware `_aggregate_result` (distinct props + property-level unassigned)

**Files:**
- Modify: `solver/api/index.py` (`_aggregate_result`)
- Modify: `solver/api/check_chunking.py`

- [ ] **Step 1: Add failing assertions**

Append to `solver/api/check_chunking.py` (before the final print, then add a print):

```python
from index import _aggregate_result

agg_crews = [
    {"id": "c1", "name": "Crew 1", "crew_size": 3, "max_clock_hours_per_day": 10,
     "works_monday": True, "works_tuesday": True, "works_wednesday": True,
     "works_thursday": True, "works_friday": True},
]

def stop(pid):
    return {"property_id": pid, "property_name": pid, "address": "x", "lat": 0, "lng": 0,
            "arrival_time": "08:00", "service_minutes": 60, "drive_minutes_to": 5}

# Crew 1 routed two chunks of property "big" + one whole "small" => 2 distinct props.
routes = [{
    "crew_id": "c1", "crew_name": "Crew 1", "day_of_week": 1, "branch_id": "b1",
    "start_time": "07:00", "end_time": "15:00", "clock_hours": 9.0, "drive_hours": 1.0,
    "drive_miles": 12.0, "stops": [stop("big"), stop("big"), stop("small")],
}]
# Chunk-level unassigned: one chunk of "big" (id big#9) and a whole "huge".
unassigned_chunks = ["big#9", "huge"]
properties = [
    {"id": "big", "est_labor_hours": 35}, {"id": "small", "est_labor_hours": 8},
    {"id": "huge", "est_labor_hours": 200},
]
res = _aggregate_result(agg_crews, routes, unassigned_chunks, properties, 1.0)

util = res["crew_utilization"][0]
assert util["props_assigned"] == 2, util["props_assigned"]   # distinct property_ids, not 3 stops
# property-level unassigned: "big" (one chunk unrouted) and "huge"; deduped, no "#"
assert sorted(res["unassigned_property_ids"]) == ["big", "huge"], res["unassigned_property_ids"]
assert "_prop_ids" not in util  # internal accumulator stripped from output

print("check_chunking: PASS (aggregate)")
print("check_chunking: ALL PASS")
```

(Remove any earlier `check_chunking: PASS (...)` final-print duplicates so the script runs top-to-bottom; the per-section prints above are fine.)

- [ ] **Step 2: Run to verify it fails**

Run: `python3 solver/api/check_chunking.py`
Expected: FAIL — `props_assigned` is currently `len(stops)` (3, not 2) and `unassigned_property_ids` currently echoes the raw chunk ids (`["big#9","huge"]`).

- [ ] **Step 3: Update `_aggregate_result`**

In `solver/api/index.py`, make three changes inside `_aggregate_result`:

(a) In the `crew_totals` init dict, add a per-crew set for distinct property ids:

```python
    crew_totals: dict[str, dict[str, Any]] = {
        c["id"]: {
            "crew_id": c["id"],
            "crew_name": c["name"],
            "clock_hours": 0.0,
            "drive_hours": 0.0,
            "drive_miles": 0.0,
            "props_assigned": 0,
            "max_weekly": 0.0,
            "_prop_ids": set(),
        }
        for c in crews
    }
```

(b) In the route-accumulation loop, replace `t["props_assigned"] += len(r["stops"])` with distinct-property tracking:

```python
    for r in all_routes:
        t = crew_totals.get(r["crew_id"])
        if t is None:
            continue
        t["clock_hours"] += r["clock_hours"]
        t["drive_hours"] += r["drive_hours"]
        t["drive_miles"] += r["drive_miles"]
        t["_prop_ids"].update(s["property_id"] for s in r["stops"])
```

(c) In the `crew_utilization` build, source `props_assigned` from the set (and don't emit `_prop_ids`):

```python
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
                "props_assigned": len(ct["_prop_ids"]),
                "util_pct": round(util_pct, 1),
            }
        )
```

(d) Map chunk-level `unassigned` to distinct **property** ids for the result. Replace the
`"unassigned_property_ids": unassigned,` line in the returned dict with a computed value
defined just before the `return`:

```python
    # `unassigned` holds chunk ids ("propId" or "propId#k"); a property is unassigned
    # if ANY of its chunks is. Map back to distinct property ids.
    unassigned_property_ids = sorted({str(cid).rsplit("#", 1)[0] for cid in unassigned})
```
and in the returned dict:
```python
        "unassigned_property_ids": unassigned_property_ids,
```

- [ ] **Step 4: Run the check + parse-check**

Run: `python3 solver/api/check_chunking.py`
Expected: ends with `check_chunking: ALL PASS`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): aggregate by distinct property + property-level unassigned"
```

---

## Task 5: crew-size-aware `solve_day` + chunk stops (OR-Tools — verify + post-deploy)

**Files:**
- Modify: `solver/api/solver_logic.py` (`solve_day`, `_extract_routes`)

> **Cannot be unit-tested locally (no OR-Tools).** Implement, `ast.parse`-check, commit; behavior is verified in Task 7 after the solver redeploys.

- [ ] **Step 1: Verify the OR-Tools API you'll use**

Confirm against the pinned `ortools` (see `solver/requirements.txt`) that these exist on `pywrapcp.RoutingModel`: `RegisterTransitCallback`, `SetArcCostEvaluatorOfVehicle(idx, vehicle)`, `AddDimensionWithVehicleTransits(list_of_callback_idx, slack, capacity, fix_start, name)`, and `GetDimensionOrDie(name).CumulVar(End(v)).SetMax(int)`. Check the OR-Tools routing reference (use Context7 for `or-tools` if unsure). The Step 2 code uses exactly these.
**Fallback only if `AddDimensionWithVehicleTransits` is genuinely absent in the pinned version:** keep a single shared transit callback for the `"Time"` dimension via the existing `AddDimensionWithVehicleCapacity` (per-vehicle caps), but compute that shared callback's service using a *reference* crew size, and instead express the crew-size effect through `SetArcCostEvaluatorOfVehicle` with per-size callbacks. This is strictly worse (capacity wouldn't be perfectly size-accurate), so only use it if the primary call is unavailable, and flag it in the commit message and to the controller.

- [ ] **Step 2: Rewrite `solve_day`**

Replace `solve_day` in `solver/api/solver_logic.py` with (note: nodes now carry `labor_hours`, not `est_clock_hours`; service is `labor ÷ crew_size`, per vehicle):

```python
def solve_day(
    day_of_week: int,
    properties_for_day: list[dict[str, Any]],
    crews_for_day: list[dict[str, Any]],
    time_limit_seconds: int = 25,
) -> dict[str, Any]:
    """Return {"routes": [...], "unassigned": [chunk_id...]}.

    Service time is crew-size-aware: a chunk of `labor_hours` person-hours served by
    a size-s crew takes labor_hours/s clock-hours. Each vehicle uses the transit
    callback for its crew size, and is capped at its own max_clock_hours/day.
    """
    if not properties_for_day or not crews_for_day:
        return {"routes": [], "unassigned": [p["id"] for p in properties_for_day]}

    coords: list[tuple[float, float]] = []
    for c in crews_for_day:
        coords.append((float(c["branch_lat"]), float(c["branch_lng"])))
    for p in properties_for_day:
        coords.append((float(p["lat"]), float(p["lng"])))

    n_crews = len(crews_for_day)
    distance_matrix = build_matrix(coords)

    starts = list(range(n_crews))
    ends = list(range(n_crews))
    manager = pywrapcp.RoutingIndexManager(len(coords), n_crews, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    # Person-seconds of work at each node (0 for depots). A size-s crew divides by s.
    person_seconds: list[int] = [0] * n_crews + [
        int(round(float(p["labor_hours"]) * 3600)) for p in properties_for_day
    ]

    # One transit callback per distinct crew size present today.
    sizes = sorted({int(c.get("crew_size") or 2) for c in crews_for_day})
    transit_idx_by_size: dict[int, int] = {}
    for s in sizes:
        def make_cb(size: int):
            def cb(from_index: int, to_index: int) -> int:
                fn = manager.IndexToNode(from_index)
                tn = manager.IndexToNode(to_index)
                return person_seconds[fn] // size + distance_matrix[fn][tn]
            return cb
        transit_idx_by_size[s] = routing.RegisterTransitCallback(make_cb(s))

    transit_idx_by_vehicle = [
        transit_idx_by_size[int(c.get("crew_size") or 2)] for c in crews_for_day
    ]
    for v in range(n_crews):
        routing.SetArcCostEvaluatorOfVehicle(transit_idx_by_vehicle[v], v)

    caps = [int(round(float(c["max_clock_hours"]) * 3600)) for c in crews_for_day]
    dim_capacity = max(caps)  # per-vehicle real caps applied below via SetMax
    routing.AddDimensionWithVehicleTransits(
        transit_idx_by_vehicle, 0, dim_capacity, True, "Time"
    )
    time_dim = routing.GetDimensionOrDie("Time")
    for v in range(n_crews):
        time_dim.CumulVar(routing.End(v)).SetMax(caps[v])

    # Each chunk may be dropped (= unassigned) at a high cost — only if infeasible.
    drop_penalty = 10_000_000
    for prop_idx in range(n_crews, len(coords)):
        node = manager.NodeToIndex(prop_idx)
        routing.AddDisjunction([node], drop_penalty)

    search = pywrapcp.DefaultRoutingSearchParameters()
    search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search.time_limit.seconds = max(5, int(time_limit_seconds))

    solution = routing.SolveWithParameters(search)
    if solution is None:
        return {
            "routes": [],
            "unassigned": [p["id"] for p in properties_for_day],
            "error": "no solution found",
        }

    return _extract_routes(
        solution=solution,
        manager=manager,
        routing=routing,
        n_crews=n_crews,
        crews_for_day=crews_for_day,
        properties_for_day=properties_for_day,
        distance_matrix=distance_matrix,
        coords=coords,
        day_of_week=day_of_week,
    )
```

- [ ] **Step 3: Rewrite `_extract_routes`**

Replace `_extract_routes` in `solver/api/solver_logic.py` with (service per stop = `labor ÷ that crew's size`; stops carry parent `property_id` + chunk labels; note the signature drops `service_seconds`):

```python
def _extract_routes(
    *,
    solution,
    manager,
    routing,
    n_crews: int,
    crews_for_day: list[dict[str, Any]],
    properties_for_day: list[dict[str, Any]],
    distance_matrix: list[list[int]],
    coords: list[tuple[float, float]],
    day_of_week: int,
) -> dict[str, Any]:
    routes: list[dict[str, Any]] = []
    assigned: set[str] = set()
    DAY_START_HOUR = 7

    for v in range(n_crews):
        crew = crews_for_day[v]
        size = int(crew.get("crew_size") or 2)
        index = routing.Start(v)
        node = manager.IndexToNode(index)
        path: list[int] = [node]
        clock_seconds = 0
        drive_seconds = 0
        stops: list[dict[str, Any]] = []

        cursor_seconds = DAY_START_HOUR * 3600
        prev_node = node

        index = solution.Value(routing.NextVar(index))
        while not routing.IsEnd(index):
            this_node = manager.IndexToNode(index)
            travel = distance_matrix[prev_node][this_node]
            cursor_seconds += travel
            drive_seconds += travel

            if this_node >= n_crews:  # chunk node
                prop = properties_for_day[this_node - n_crews]
                service_seconds = int(round(float(prop["labor_hours"]) / size * 3600))
                arrival_h = cursor_seconds // 3600
                arrival_m = (cursor_seconds % 3600) // 60
                stops.append(
                    {
                        "property_id": prop.get("property_id", prop["id"]),
                        "property_name": prop["name"],
                        "address": prop["address"],
                        "lat": float(prop["lat"]),
                        "lng": float(prop["lng"]),
                        "arrival_time": f"{arrival_h:02d}:{arrival_m:02d}",
                        "service_minutes": int(round(float(prop["labor_hours"]) / size * 60)),
                        "drive_minutes_to": int(round(travel / 60)),
                        "chunk_index": prop.get("chunk_index", 1),
                        "chunk_count": prop.get("chunk_count", 1),
                    }
                )
                assigned.add(prop["id"])
                cursor_seconds += service_seconds
                clock_seconds += service_seconds

            path.append(this_node)
            prev_node = this_node
            index = solution.Value(routing.NextVar(index))

        end_node = manager.IndexToNode(routing.End(v))
        travel_home = distance_matrix[prev_node][end_node]
        cursor_seconds += travel_home
        drive_seconds += travel_home
        path.append(end_node)

        clock_total_seconds = clock_seconds + drive_seconds
        end_h = cursor_seconds // 3600
        end_m = (cursor_seconds % 3600) // 60

        routes.append(
            {
                "crew_id": crew["id"],
                "crew_name": crew["name"],
                "day_of_week": day_of_week,
                "branch_id": crew["branch_id"],
                "start_time": f"{DAY_START_HOUR:02d}:00",
                "end_time": f"{end_h:02d}:{end_m:02d}",
                "clock_hours": clock_total_seconds / 3600,
                "drive_hours": drive_seconds / 3600,
                "drive_miles": drive_miles(coords, path),
                "stops": stops,
            }
        )

    unassigned = [p["id"] for p in properties_for_day if p["id"] not in assigned]
    return {"routes": routes, "unassigned": unassigned}
```

- [ ] **Step 4: Parse-check both solver files**

Run: `python3 -c "import ast; ast.parse(open('solver/api/solver_logic.py').read()); ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`
Run: `python3 solver/api/check_chunking.py` (ensure the pure checks still pass after the file edits)
Expected: `check_chunking: ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add solver/api/solver_logic.py
git commit -m "feat(solver): crew-size-aware per-vehicle service times + chunk stops"
```

---

## Task 6: `RouteStop` chunk fields (TypeScript)

**Files:**
- Modify: `src/lib/types.ts` (`RouteStop`)

- [ ] **Step 1: Add the optional fields**

In `src/lib/types.ts`, the `RouteStop` interface ends with `drive_minutes_to: number;`. Add two optional fields:

```ts
  // Set when a large property was split into multiple work-chunks; 1/1 otherwise.
  chunk_index?: number;
  chunk_count?: number;
```

- [ ] **Step 2: Typecheck + build + tests**

Run: `npm run typecheck`
Expected: clean (optional fields are backward-compatible; existing `RouteStop` literals in tests still satisfy the type).
Run: `npm run test`
Expected: all suites pass (no behavior change).
Run: `npm run build`
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: optional chunk_index/chunk_count on RouteStop"
```

---

## Task 7: Full verification + post-deploy behavior check

- [ ] **Step 1: Local checks (no OR-Tools)**

Run: `python3 solver/api/check_chunking.py`
Expected: `check_chunking: ALL PASS`
Run: `python3 solver/api/check_grouping.py` (the pre-existing evaluate-mode check still passes)
Expected: `check_grouping: PASS`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); ast.parse(open('solver/api/solver_logic.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 2: Web checks**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean.

- [ ] **Step 3: Post-deploy behavior verification (after the solver project redeploys)**

These require OR-Tools (prod solver). Run a fresh optimization, then confirm via the run page + a Supabase query:
1. **Splitting:** a property with labor between `single_day_max` and several crew-days (e.g. 50 person-hrs) appears as multiple `(k/n)` stops across **more than one crew and/or day**; its chunks' clock-hours sum sensibly.
2. **Mixed crews same day:** for a big property, confirm chunks land on crews of different sizes (and possibly the same day) — inspect `routes_jsonb` stops grouped by `property_id`.
3. **Crew-size effect:** a ~25 person-hr single-stop property is routed to a 3-person crew (it can't fit a 2-person 10 h day) — check which crew got it.
4. **No regression for normal properties:** small properties (≤ `single_day_max`) still appear as single stops; total counts look right.
5. **Unassigned is property-level:** Canyon Park (132.6 h) still appears in `unassigned_property_ids` once (not as chunk ids), because even chunked it exceeds available crew-day capacity — confirm the array holds `"<uuid>"`, not `"<uuid>#k"`.
6. **Evaluate mode:** upload a current schedule on `/compare` and confirm the baseline still scores (run reaches `completed`).

- [ ] **Step 4: Record results + commit any fixes**

If a post-deploy check fails, debug against the prod solver logs (the GET health endpoint reports import errors), fix, redeploy, re-verify.

---

## Notes for the executor

- **The solver is a separate deploy.** After merging, the `solver/` project must redeploy before any of this takes effect; the web app is unchanged behaviorally except for the optional `RouteStop` fields.
- **Behavior change is intentional:** re-running optimization will shift clock-hours/utilization (now crew-size-real) and may move assignments. Expected.
- **Deferred (follow-up, not this plan):** partial-coverage hours (`covered/total` per property) — needs storage (a column or `config_snapshot` merge) and feeds the parked unassigned-surfacing UI; grouping split-property stops into one "N visits this week" line in the run views (the `(k/n)` labels are enough to ship).
- **DRY/YAGNI:** `chunk_labor`/`_chunk_thresholds` are the single source of chunking; `solve_day` is the single place crew-size math lives; both `run_optimization` and `run_evaluation` flow through the same `_properties_for_solver` + `_aggregate_result`.
- **Tuning lever (watch in Task 7 post-deploy):** Step 2 uses each vehicle's per-size transit (service + drive) as its **arc cost**, a faithful port of today's `SetArcCostEvaluatorOfAllVehicles(transit)`. Because a 3-person crew has lower service cost for the same chunk, the cost mildly **prefers 3-person crews**, which is the desired "big jobs to big crews" — but if post-deploy shows 3-person crews hogging work while 2-person crews sit idle (the very thing we're fixing), switch the arc cost to **distance-only** (register a separate distance-only callback and `SetArcCostEvaluatorOfAllVehicles` on it) while keeping the per-size **`"Time"` dimension** for capacity. That removes the size bias from cost and lets capacity drive assignment, typically balancing utilization better. Don't pre-emptively switch — verify behavior first.
```
