# Cross-Day Capacity-Aware Split + Iterative Rebalance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the optimizer from dropping properties onto an overloaded weekday when another day had spare capacity — via a capacity-aware initial day-split plus a bounded rebalance loop that moves unassigned chunks to days with room and re-solves them.

**Architecture:** All changes are orchestration in `solver/api/index.py`'s `run_optimization` path. New pure helpers compute per-day capacity, choose rebalance targets, and measure assigned labor; `_bucketize_properties` becomes capacity-aware (first-fit-decreasing); `run_optimization` gains a bounded rebalance loop around a new `_solve_days` wrapper. `solve_day`, `_extract_routes`, `_aggregate_result`, `_properties_for_solver`, and `run_evaluation` are untouched.

**Tech Stack:** Python in `solver/api/`. Pure helpers checked via the standalone `solver/api/check_chunking.py` (OR-Tools not required); the loop + routing quality are parse-checked locally and verified post-deploy (OR-Tools isn't installed in this workspace).

---

## Critical constraints

- **OR-Tools is NOT installed here.** `index.py` imports fine (it guards `from solver_logic import solve_day`), so the pure-helper checks run; but anything that calls `solve_day` (`_solve_days`, `run_optimization`) can't run locally — implement, `ast.parse`, commit, verify post-deploy.
- **Optimize-mode only.** Do not touch `run_evaluation` / baseline scoring.
- The solver is a **separate Coolify deploy**; nothing takes effect until it redeploys.
- Runtime budget: a few minutes is acceptable (the loop self-limits via a time cap).

## File Structure

- `solver/api/index.py` — **Modify:** add constants `_DAY_CAPACITY_HEADROOM`, `_MAX_REBALANCE_ROUNDS`, `_REBALANCE_TIME_CAP_SECONDS`; add pure helpers `_day_capacities`, `_assigned_labor`, `_pick_rebalance_day`, `_day_of`; rewrite `_bucketize_properties` (capacity-aware, new `day_caps` param); add `_solve_days`; rewrite `run_optimization`.
- `solver/api/check_chunking.py` — **Modify:** assertions for the new pure helpers + the capacity-aware split.
- No `solver_logic.py` change, no web change, no migration.

---

## Task 1: Pure helpers — capacity, rebalance-target, assigned-labor, day-of

**Files:**
- Modify: `solver/api/index.py`
- Modify: `solver/api/check_chunking.py`

- [ ] **Step 1: Add constants + helpers to `index.py`**

Add near the other helpers (e.g. just above `_bucketize_properties`):

```python
# Cross-day rebalance tunables.
_DAY_CAPACITY_HEADROOM = 0.85  # leave ~15% of a day's labor capacity for drive time
_MAX_REBALANCE_ROUNDS = 3
_REBALANCE_TIME_CAP_SECONDS = 240


def _day_capacities(
    crews: list[dict[str, Any]], branches_by_id: dict[str, dict[str, Any]]
) -> dict[int, float]:
    """Usable person-hours each weekday (1..5) can absorb.

    Sum (crew_size * max_clock_hours_per_day) over crews that work the day AND have
    a geocoded home branch (same eligibility as _crews_for_day), scaled by a
    headroom factor so a day isn't packed to 100% labor before drive time is added.
    """
    caps: dict[int, float] = {}
    for d in (1, 2, 3, 4, 5):
        field = WEEKDAY_FIELDS[d]
        total = 0.0
        for c in crews:
            if not c.get(field):
                continue
            if not branches_by_id.get(c.get("home_branch_id")):
                continue
            total += int(c.get("crew_size") or 2) * float(c.get("max_clock_hours_per_day") or 8)
        caps[d] = total * _DAY_CAPACITY_HEADROOM
    return caps


def _assigned_labor(day_chunks: list[dict[str, Any]], unassigned_ids: set[str]) -> float:
    """Person-hours of a day's chunks that were actually placed (not unassigned)."""
    return sum(float(c["labor_hours"]) for c in day_chunks if c["id"] not in unassigned_ids)


def _pick_rebalance_day(
    labor: float,
    spare: dict[int, float],
    work_days: list[int],
    current_day: int,
    tried_days: set[int],
) -> int | None:
    """The work-day with the most spare that fits `labor`, excluding the chunk's
    current day and any day already tried for it. None if nothing qualifies."""
    candidates = [
        d for d in work_days
        if d != current_day and d not in tried_days and spare.get(d, 0.0) >= labor
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda d: spare[d])


def _day_of(buckets: dict[int, list[dict[str, Any]]], chunk_id: str) -> int | None:
    """Which day's bucket currently holds the chunk (None if not found)."""
    for d, chunks in buckets.items():
        if any(c["id"] == chunk_id for c in chunks):
            return d
    return None
```

- [ ] **Step 2: Append checks to `check_chunking.py`**

Add immediately BEFORE the current final `print("check_chunking: ALL PASS")` line (keep that line last):

```python
from index import _day_capacities, _assigned_labor, _pick_rebalance_day, _day_of

# --- _day_capacities ---
cap_crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10, "home_branch_id": "b1", "works_monday": True, "works_tuesday": True},
    {"crew_size": 3, "max_clock_hours_per_day": 10, "home_branch_id": "b1", "works_monday": True},
    {"crew_size": 3, "max_clock_hours_per_day": 10, "home_branch_id": "bX", "works_monday": True},  # branch not geocoded
]
caps = _day_capacities(cap_crews, {"b1": {"id": "b1", "lat": 40, "lng": -111}})
# Monday: crew1 (2*10) + crew2 (3*10) = 50; crew3 excluded (branch bX missing). *0.85 = 42.5
assert approx(caps[1], 42.5), caps[1]
# Tuesday: only crew1 works = 2*10 = 20; *0.85 = 17.0
assert approx(caps[2], 17.0), caps[2]
assert caps[3] == 0.0 and caps[4] == 0.0 and caps[5] == 0.0, caps

# --- _assigned_labor ---
dc = [{"id": "a", "labor_hours": 10}, {"id": "b", "labor_hours": 5}, {"id": "c", "labor_hours": 3}]
assert approx(_assigned_labor(dc, {"b"}), 13), "10 + 3, b excluded"
assert approx(_assigned_labor(dc, set()), 18)

# --- _pick_rebalance_day ---
spare = {1: 5.0, 2: 30.0, 3: 12.0}
assert _pick_rebalance_day(10, spare, [1, 2, 3], current_day=3, tried_days=set()) == 2  # most spare that fits, != 3
assert _pick_rebalance_day(10, spare, [1, 2, 3], current_day=2, tried_days=set()) == 3  # 2 excluded (current), 1 too small
assert _pick_rebalance_day(10, spare, [1, 2, 3], current_day=3, tried_days={2}) is None  # 2 tried, 1 too small
assert _pick_rebalance_day(100, spare, [1, 2, 3], current_day=1, tried_days=set()) is None  # none fits

# --- _day_of ---
buckets_t = {1: [{"id": "x", "labor_hours": 4}], 2: [{"id": "y", "labor_hours": 4}]}
assert _day_of(buckets_t, "y") == 2
assert _day_of(buckets_t, "missing") is None

print("check_chunking: PASS (rebalance helpers)")
```

(If the script's current last line is `print("check_chunking: ALL PASS")`, insert the block above it so `ALL PASS` remains the final line.)

- [ ] **Step 3: Run checks + parse**

Run: `python3 solver/api/check_chunking.py`
Expected: includes `check_chunking: PASS (rebalance helpers)` then `check_chunking: ALL PASS`.
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): pure helpers for cross-day capacity + rebalance"
```

---

## Task 2: Capacity-aware `_bucketize_properties`

**Files:**
- Modify: `solver/api/index.py` (`_bucketize_properties` + its call in `run_optimization`)
- Modify: `solver/api/check_chunking.py`

- [ ] **Step 1: Append a failing check to `check_chunking.py`**

Add immediately BEFORE the final `print("check_chunking: ALL PASS")`:

```python
# --- capacity-aware _bucketize_properties ---
from index import _bucketize_properties as _buck2

bcrews = [  # both crews Mon-Fri, 2-person 10h => each day cap = 20 *0.85 = 17 person-hrs
    {"crew_size": 2, "max_clock_hours_per_day": 10, "home_branch_id": "b1",
     "works_monday": True, "works_tuesday": True, "works_wednesday": True,
     "works_thursday": True, "works_friday": True},
]
bcaps = _day_capacities(bcrews, {"b1": {"id": "b1", "lat": 40, "lng": -111}})
# Five free chunks of 10 person-hrs each (no assigned day). Day cap 17 => ~1 chunk/day.
free_chunks = [
    {"id": f"f{k}", "property_id": f"f{k}", "labor_hours": 10, "lat": 40.0, "lng": -111.0, "chunk_count": 2}
    for k in range(5)
]
bk = _buck2(free_chunks, bcrews, bcaps)
# Each weekday should hold at most one 10-hr chunk (a second would exceed the 17 cap).
assert all(len(bk[d]) <= 1 for d in bk), {d: len(v) for d, v in bk.items()}
# All five chunks are placed somewhere (none lost from the buckets).
placed = sorted(c["id"] for v in bk.values() for c in v)
assert placed == ["f0", "f1", "f2", "f3", "f4"], placed
# Sticky single-chunk still honored on its assigned day.
sticky = {"id": "s", "property_id": "s", "labor_hours": 4, "lat": 40.0, "lng": -111.0,
          "assigned_day_of_week": 3, "chunk_count": 1}
bk2 = _buck2([sticky], bcrews, bcaps)
assert any(c["id"] == "s" for c in bk2[3]), "sticky honored"

print("check_chunking: PASS (capacity bucketize)")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 solver/api/check_chunking.py`
Expected: FAIL — current `_bucketize_properties` takes `(properties, crews)` (TypeError on the 3rd arg) and balances by least-load (would stack multiple chunks on one day).

- [ ] **Step 3: Rewrite `_bucketize_properties`**

Replace the whole function in `solver/api/index.py` with (sticky unchanged; free chunks placed capacity-aware, first-fit-decreasing):

```python
def _bucketize_properties(
    properties: list[dict[str, Any]],
    crews: list[dict[str, Any]],
    day_caps: dict[int, float],
) -> dict[int, list[dict[str, Any]]]:
    """Distribute work-chunks across the 5 weekdays, respecting per-day capacity.

    - Single-chunk properties honor their assigned day (sticky). Multi-chunk (split)
      properties spread (free pool).
    - Free chunks are placed first-fit-decreasing: largest first, onto the work-day
      with the most remaining spare (capacity minus labor already there) that still
      fits; if none fits, the max-spare day (it'll surface as unassigned / get
      rebalanced). `solve_day` does the real routing within a day.
    """
    work_days = [d for d in (1, 2, 3, 4, 5) if any(c.get(WEEKDAY_FIELDS[d]) for c in crews)]
    if not work_days:
        work_days = [1, 2, 3, 4, 5]

    buckets: dict[int, list[dict[str, Any]]] = {d: [] for d in work_days}

    sticky: list[dict[str, Any]] = []
    free: list[dict[str, Any]] = []
    for p in properties:
        if p.get("chunk_count", 1) == 1 and p.get("assigned_day_of_week") in work_days:
            sticky.append(p)
        else:
            free.append(p)

    for p in sticky:
        buckets[p["assigned_day_of_week"]].append(p)

    # Remaining spare = capacity minus sticky labor already placed.
    spare: dict[int, float] = {
        d: day_caps.get(d, 0.0) - sum(float(x["labor_hours"]) for x in buckets[d]) for d in work_days
    }

    # First-fit-decreasing: largest chunks first, onto the day with most spare that fits.
    free.sort(key=lambda p: float(p["labor_hours"]), reverse=True)
    for p in free:
        labor = float(p["labor_hours"])
        fits = [d for d in work_days if spare[d] >= labor]
        target = max(fits, key=lambda d: spare[d]) if fits else max(work_days, key=lambda d: spare[d])
        buckets[target].append(p)
        spare[target] -= labor

    return buckets
```

- [ ] **Step 4: Update the call site in `run_optimization`**

In `run_optimization` (in `index.py`), it currently reads:

```python
    branches_by_id = {b["id"]: b for b in branches}
    solver_props = _properties_for_solver(properties, crews)
    buckets = _bucketize_properties(solver_props, crews)
```

Change the last two lines to compute capacities and pass them:

```python
    branches_by_id = {b["id"]: b for b in branches}
    solver_props = _properties_for_solver(properties, crews)
    day_caps = _day_capacities(crews, branches_by_id)
    buckets = _bucketize_properties(solver_props, crews, day_caps)
```

(The per-day solve loop below stays as-is for now; the rebalance loop is Task 3.)

- [ ] **Step 5: Run checks + parse**

Run: `python3 solver/api/check_chunking.py`
Expected: ends with `check_chunking: PASS (capacity bucketize)` then `check_chunking: ALL PASS`.
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add solver/api/index.py solver/api/check_chunking.py
git commit -m "feat(solver): capacity-aware initial day split (first-fit-decreasing)"
```

---

## Task 3: `_solve_days` wrapper + rebalance loop in `run_optimization`

**Files:**
- Modify: `solver/api/index.py` (`run_optimization`; add `_solve_days`)

> Calls `solve_day` → cannot run locally. Implement, parse-check, keep `check_chunking.py` green, commit; behavior is verified post-deploy (Task 4).

- [ ] **Step 1: Add `_solve_days` above `run_optimization`**

```python
def _solve_days(
    days: list[int],
    buckets: dict[int, list[dict[str, Any]]],
    crews: list[dict[str, Any]],
    branches_by_id: dict[str, dict[str, Any]],
) -> tuple[dict[int, list[dict[str, Any]]], dict[int, list[str]]]:
    """Solve each given day independently. Returns ({day: routes}, {day: unassigned_chunk_ids}).

    A day with chunks but no eligible crew marks all its chunks unassigned (matches
    the prior per-day behavior)."""
    routes_by_day: dict[int, list[dict[str, Any]]] = {}
    unassigned_by_day: dict[int, list[str]] = {}
    for day in days:
        chunks = buckets.get(day, [])
        if not chunks:
            routes_by_day[day] = []
            unassigned_by_day[day] = []
            continue
        crews_today = _crews_for_day(crews, branches_by_id, day)
        if not crews_today:
            routes_by_day[day] = []
            unassigned_by_day[day] = [c["id"] for c in chunks]
            continue
        result = solve_day(day, chunks, crews_today, time_limit_seconds=8)
        routes_by_day[day] = result["routes"]
        unassigned_by_day[day] = result.get("unassigned", [])
    return routes_by_day, unassigned_by_day
```

- [ ] **Step 2: Rewrite `run_optimization`**

Replace the whole `run_optimization` function with (keeps the Task 2 capacity-aware split; adds the bounded rebalance loop):

```python
def run_optimization(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    crews = payload["crews"]
    branches = payload["branches"]
    properties = payload["properties"]

    branches_by_id = {b["id"]: b for b in branches}
    solver_props = _properties_for_solver(properties, crews)
    day_caps = _day_capacities(crews, branches_by_id)
    buckets = _bucketize_properties(solver_props, crews, day_caps)
    work_days = sorted(buckets.keys())
    chunk_by_id = {c["id"]: c for c in solver_props}

    # Initial solve of every day.
    routes_by_day, unassigned_by_day = _solve_days(work_days, buckets, crews, branches_by_id)

    # Bounded cross-day rebalance: move still-unassigned chunks to days with spare
    # capacity and re-solve only the changed days. A `tried` set prevents cycling;
    # moves are monotonic (a day with spare won't evict its placed chunks), so this
    # never lowers the assigned count vs the initial solve.
    tried: dict[str, set[int]] = {}
    for _round in range(_MAX_REBALANCE_ROUNDS):
        if (time.time() - started) > _REBALANCE_TIME_CAP_SECONDS:
            break
        unassigned_ids = [cid for d in work_days for cid in unassigned_by_day[d]]
        if not unassigned_ids:
            break
        spare = {
            d: day_caps.get(d, 0.0) - _assigned_labor(buckets[d], set(unassigned_by_day[d]))
            for d in work_days
        }
        dirty: set[int] = set()
        for cid in sorted(unassigned_ids, key=lambda c: float(chunk_by_id[c]["labor_hours"]), reverse=True):
            chunk = chunk_by_id[cid]
            cur_day = _day_of(buckets, cid)
            if cur_day is None:
                continue
            target = _pick_rebalance_day(
                float(chunk["labor_hours"]), spare, work_days, cur_day, tried.get(cid, set())
            )
            if target is None:
                continue
            buckets[cur_day].remove(chunk)
            buckets[target].append(chunk)
            spare[target] -= float(chunk["labor_hours"])
            tried.setdefault(cid, set()).add(target)
            dirty.add(cur_day)
            dirty.add(target)
        if not dirty:
            break
        re_routes, re_unassigned = _solve_days(sorted(dirty), buckets, crews, branches_by_id)
        routes_by_day.update(re_routes)
        unassigned_by_day.update(re_unassigned)

    all_routes = [r for d in work_days for r in routes_by_day[d]]
    unassigned = [cid for d in work_days for cid in unassigned_by_day[d]]
    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)
```

- [ ] **Step 3: Parse + pure checks still green**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"`
Expected: `ok`
Run: `python3 solver/api/check_chunking.py`
Expected: `check_chunking: ALL PASS`
Run: `python3 solver/api/check_grouping.py`
Expected: `check_grouping: PASS` (run_evaluation untouched).

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): bounded cross-day rebalance loop in run_optimization"
```

---

## Task 4: Full verification + post-deploy checklist

- [ ] **Step 1: Local checks**

Run: `python3 solver/api/check_chunking.py` → `check_chunking: ALL PASS`
Run: `python3 solver/api/check_grouping.py` → `check_grouping: PASS`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); ast.parse(open('solver/api/solver_logic.py').read()); print('ok')"` → `ok`

- [ ] **Step 2: Web sanity (no web change expected, but confirm nothing broke the repo)**

Run: `npm run typecheck && npm run test` → typecheck clean; 58 tests pass.

- [ ] **Step 3: Post-deploy behavior verification (after the solver redeploys)**

Run a fresh optimization, then confirm via the run page + the unassigned surfacing:
1. **Fewer unassigned than before** for the same inputs — properties previously dropped while crews sat idle should now route (the banner's under-40h crew count should drop, or unassigned should clear).
2. **Days look balanced** — per-day clock-hours/utilization are spread, not piled on one weekday.
3. **Remaining unassigned (if any) coincide with a genuinely full fleet** — the surfacing banner says "fleet looks fully loaded" rather than "crews under 40h," i.e. spare really is ~0 everywhere. That's a true capacity signal (add crews), not a balancing artifact.
4. **No regression on a run that already fully assigned** — totals/utilization remain sensible; the run still completes well within a few minutes.
5. **Baseline/evaluate still works** — upload a current schedule on `/compare`; it still scores (run reaches `completed`).

- [ ] **Step 4: Record results; tune if needed**

If drops cluster on geographically spread days, lower `_DAY_CAPACITY_HEADROOM` (e.g. 0.8). If solves run long, lower `_MAX_REBALANCE_ROUNDS`. Commit any tuning.

---

## Notes for the executor

- **Separate solver deploy** — redeploy `solver/` after merge; nothing changes until then.
- **Monotonic by design** — the rebalance only adds unassigned chunks to days with computed spare and re-solves; it cannot lower the assigned count vs the initial solve. If post-deploy shows otherwise, that's a bug to investigate (likely the spare estimate vs `solve_day`'s real packing).
- **DRY/YAGNI** — `_solve_days` is the single per-day solve wrapper (used for both the initial solve and re-solves); capacity logic lives only in `_day_capacities`; rebalance target choice only in `_pick_rebalance_day`. No changes outside `run_optimization`'s orchestration.
- **`list.remove(chunk)`** relies on chunk dicts being unique by `id` (they are: `chunk_id` is `property_id` or `property_id#k`), so equality-based removal targets the right chunk.
- **Deferred (not in this plan):** a cross-day "same crew finishes all of a property's chunks" preference. It can't be expressed in the per-day decomposition (crew choice is inside each day's solve); the same-day case is already cost-favored, and the across-day case needs the joint multi-day model (approach C). Decision: ship this rebalance now, revisit C for same-crew later. Do NOT attempt to bolt a cross-day crew preference onto the per-day loop.
