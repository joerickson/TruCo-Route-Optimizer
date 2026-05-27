# Crew-Mix Recommender (solver-in-the-loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recommend crews-per-branch + 2/3-person mix to cover the portfolio sustainably, via an analytical seed validated and adjusted by the real routing solver in a bounded loop.

**Architecture:** New Python `recommend` solver mode: bin-pack a seed fleet, validate with `run_optimization` (real drive), add/trim crews per branch over ≤5 rounds, write the result to a new `crew_recommendations` table. Web `/recommend` page triggers it (fire-and-forget) and polls, like optimization runs.

**Tech Stack:** Python (solver, reuses OR-Tools `run_optimization`), Supabase Postgres (new table), Next.js App Router (trigger + poll + render). Pure helpers checked via a standalone script (no OR-Tools); the loop is parse-checked + post-deploy.

---

## Critical constraints

- **OR-Tools is NOT installed locally.** `run_recommendation`/`run_optimization` can't run here. Gates: pure-helper check scripts + `ast.parse` + post-deploy. Pure functions (attribution, seed bin-pack, adjust decision, result build) ARE locally checkable (index.py guards the solve_day import).
- **Three deploy steps when shipping:** run the migration, redeploy `solver/`, deploy web. Surface the SQL.
- **Don't change `optimize`/`evaluate` behavior** — the only touch to existing solver code is an *optional, default-preserving* `time_limit_seconds` param and a *parameterized* `_supabase_patch`.

## File Structure

- `solver/api/index.py` — parameterize `_supabase_patch`; add `time_limit_seconds` to `run_optimization`/`_solve_days`; add recommender constants + `_attribute_to_branches`, `_seed_fleet`, `_bin_pack_branch`, `_make_rec_crew`, `_recommend_adjustments`, `_build_recommendation`, `run_recommendation`; dispatch `recommend` in `do_POST`.
- `solver/api/check_recommend.py` — **Create:** pure checks (no OR-Tools).
- `supabase/migrations/20260526000100_crew_recommendations.sql` — **Create.**
- `src/lib/types.ts` — add `CrewRecommendation` + `RecommendationResult` types.
- `src/app/recommend/{actions.ts,page.tsx,recommend-form.tsx,recommend-table.tsx}` — **Create.**
- `src/components/top-nav.tsx` — add `Recommend` link.

---

## Task 1: Parameterize `_supabase_patch` for any table

**Files:** Modify `solver/api/index.py`.

- [ ] **Step 1: Add a `table` parameter**

Change the signature and the URL line of `_supabase_patch`. It currently is `def _supabase_patch(run_id: str, fields: dict[str, Any]) -> None:` with URL `f"{url}/rest/v1/optimization_runs?id=eq.{run_id}"`. Replace with:

```python
def _supabase_patch(table: str, row_id: str, fields: dict[str, Any]) -> None:
    """PATCH a single row in `table` via Supabase REST.

    Uses urllib.request rather than supabase-py because supabase-py 2.10.0 rejects
    the new sb_secret_* service-role key format; the REST API accepts it fine.
    """
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(f"Missing supabase env: url_set={bool(url)}, key_set={bool(key)}")

    req = urllib.request.Request(
        f"{url}/rest/v1/{table}?id=eq.{row_id}",
        method="PATCH",
        data=json.dumps(fields).encode("utf-8"),
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    try:
        resp_body = urllib.request.urlopen(req, timeout=10).read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Supabase PATCH {e.code}: {e.read().decode()[:300]}") from None
    rows = json.loads(resp_body) if resp_body else []
    if not rows:
        raise RuntimeError(f"Update returned no rows for {table} id={row_id}")
```

- [ ] **Step 2: Update existing callers to pass the table**

In `_persist`, change `_supabase_patch(run_id, {...})` to `_supabase_patch("optimization_runs", run_id, {...})`. In `handler.do_POST`'s `except` block, change `_supabase_patch(run_id, {...})` to `_supabase_patch("optimization_runs", run_id, {...})`.

- [ ] **Step 3: Verify**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`
Run: `python3 solver/api/check_chunking.py` → `check_chunking: ALL PASS`; `python3 solver/api/check_grouping.py` → `check_grouping: PASS`
Run: `grep -n "_supabase_patch(" solver/api/index.py` → confirm every call passes a table string first.

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py
git commit -m "refactor(solver): parameterize _supabase_patch by table"
```

---

## Task 2: Optional `time_limit_seconds` on `run_optimization`

**Files:** Modify `solver/api/index.py` (`run_optimization`, `_solve_days`).

- [ ] **Step 1: Thread the param**

In `_solve_days`, add a `time_limit_seconds: int = 8` parameter and use it in the `solve_day` call. The signature becomes:
```python
def _solve_days(
    days: list[int],
    buckets: dict[int, list[dict[str, Any]]],
    crews: list[dict[str, Any]],
    branches_by_id: dict[str, dict[str, Any]],
    time_limit_seconds: int = 8,
) -> tuple[dict[int, list[dict[str, Any]]], dict[int, list[str]]]:
```
and change its `solve_day(day, chunks, crews_today, time_limit_seconds=8)` call to `solve_day(day, chunks, crews_today, time_limit_seconds=time_limit_seconds)`.

In `run_optimization`, add `time_limit_seconds: int = 8` to the signature:
```python
def run_optimization(payload: dict[str, Any], time_limit_seconds: int = 8) -> dict[str, Any]:
```
and pass it to BOTH `_solve_days(...)` calls (the initial solve and the re-solve in the rebalance loop): add `, time_limit_seconds=time_limit_seconds` to each.

- [ ] **Step 2: Verify (default preserved → optimize/evaluate unchanged)**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`
Run: `python3 solver/api/check_chunking.py` (ALL PASS) and `python3 solver/api/check_grouping.py` (PASS).
Run: `grep -n "time_limit_seconds" solver/api/index.py` — confirm `run_optimization` + `_solve_days` default to 8 and the `solve_day` call uses the threaded value.

- [ ] **Step 3: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): optional time_limit_seconds on run_optimization (default 8)"
```

---

## Task 3: Analytical seed — attribution + bin-pack (pure)

**Files:** Modify `solver/api/index.py`; Create `solver/api/check_recommend.py`.

- [ ] **Step 1: Add recommender constants + import haversine**

At the top of `index.py`, near the other imports, add `from distance_matrix import haversine_miles` IF not already imported (check; `solver_logic.py` imports it from `distance_matrix`, and `index.py` may not — add it inside the try-guarded block is unnecessary since distance_matrix has no OR-Tools dep, so a plain top-level `from distance_matrix import haversine_miles` is safe). Add constants near the other tunables:

```python
# Crew-mix recommender tunables.
_REC_SUSTAINABLE_CLOCK_PER_WEEK = 50.0
_REC_USABLE_FRACTION = 0.85
_REC_MAX_HOURS_PER_DAY = 10.0
_REC_CAP2 = _REC_USABLE_FRACTION * _REC_SUSTAINABLE_CLOCK_PER_WEEK * 2  # ~85 person-hrs/wk
_REC_CAP3 = _REC_USABLE_FRACTION * _REC_SUSTAINABLE_CLOCK_PER_WEEK * 3  # ~127.5
_REC_OVER_PROVISIONED_CLOCK = 40.0  # a crew under this weekly clock is under-used
_REC_MAX_RUNS = 5
_REC_TIME_CAP_SECONDS = 600
_REC_VALIDATE_SECONDS = 5
```

- [ ] **Step 2: Add `_attribute_to_branches`, `_make_rec_crew`, `_bin_pack_branch`, `_seed_fleet`**

```python
def _attribute_to_branches(
    properties: list[dict[str, Any]], branches: list[dict[str, Any]]
) -> tuple[dict[str, list[dict[str, Any]]], list[str]]:
    """Group active properties under a branch: preferred_branch_id if that branch is
    active, else the nearest active geocoded branch by Haversine. Properties with no
    coordinates and no usable preferred branch are returned as unattributable ids."""
    active = [b for b in branches if b.get("lat") is not None and b.get("lng") is not None]
    active_ids = {b["id"] for b in active}
    by_branch: dict[str, list[dict[str, Any]]] = {b["id"]: [] for b in active}
    unattributable: list[str] = []
    for p in properties:
        pref = p.get("preferred_branch_id")
        if pref in active_ids:
            by_branch[pref].append(p)
            continue
        if p.get("lat") is None or p.get("lng") is None or not active:
            unattributable.append(p["id"])
            continue
        nearest = min(
            active,
            key=lambda b: haversine_miles(float(p["lat"]), float(p["lng"]), float(b["lat"]), float(b["lng"])),
        )
        by_branch[nearest["id"]].append(p)
    return by_branch, unattributable


def _make_rec_crew(branch_id: str, k: int, size: int) -> dict[str, Any]:
    """A synthetic Mon-Fri crew at a branch, shaped for run_optimization."""
    return {
        "id": f"rec-{branch_id}-{k}",
        "name": f"Rec crew {k} ({size}p)",
        "crew_size": size,
        "home_branch_id": branch_id,
        "max_clock_hours_per_day": _REC_MAX_HOURS_PER_DAY,
        "works_monday": True,
        "works_tuesday": True,
        "works_wednesday": True,
        "works_thursday": True,
        "works_friday": True,
        "works_saturday": False,
        "works_sunday": False,
    }


def _bin_pack_branch(props: list[dict[str, Any]], branch_id: str) -> list[dict[str, Any]]:
    """First-fit-decreasing pack of a branch's properties (weekly labor =
    est_labor_hours) into 2-/3-person crew bins. Returns synthetic crew dicts."""
    bins: list[dict[str, Any]] = []  # {size, cap, load}

    def open_bin(size: int) -> dict[str, Any]:
        b = {"size": size, "cap": _REC_CAP3 if size == 3 else _REC_CAP2, "load": 0.0}
        bins.append(b)
        return b

    for p in sorted(props, key=lambda p: float(p["est_labor_hours"]), reverse=True):
        labor = float(p["est_labor_hours"])
        if labor > _REC_CAP3:  # oversize: dedicated 3-person crews, split evenly
            import math
            n = math.ceil(labor / _REC_CAP3)
            for _ in range(n):
                b = open_bin(3)
                b["load"] = labor / n
            continue
        if labor > _REC_CAP2:  # needs a 3-person crew
            fit = next((b for b in bins if b["size"] == 3 and b["cap"] - b["load"] >= labor), None)
            (fit or open_bin(3))["load"] += labor
            continue
        # labor <= cap2: fit into any bin with room, preferring to fill 3-person bins'
        # slack (tightest fit), else open a 2-person bin.
        fits = [b for b in bins if b["cap"] - b["load"] >= labor]
        if fits:
            fits.sort(key=lambda b: (b["size"] != 3, b["cap"] - b["load"]))
            fits[0]["load"] += labor
        else:
            open_bin(2)["load"] += labor

    return [_make_rec_crew(branch_id, k + 1, b["size"]) for k, b in enumerate(bins)]


def _seed_fleet(properties: list[dict[str, Any]], branches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Analytical starting fleet: bin-pack each branch's attributed properties."""
    by_branch, _unattributable = _attribute_to_branches(properties, branches)
    fleet: list[dict[str, Any]] = []
    for branch_id, props in by_branch.items():
        fleet.extend(_bin_pack_branch(props, branch_id))
    return fleet
```

- [ ] **Step 3: Create `solver/api/check_recommend.py`**

```python
"""Pure checks for the crew-mix recommender helpers. Run:
python3 solver/api/check_recommend.py   (no OR-Tools needed)."""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import (
    _attribute_to_branches, _seed_fleet, _bin_pack_branch,
    _REC_CAP2, _REC_CAP3,
)

branches = [
    {"id": "slc", "lat": 40.76, "lng": -111.89},
    {"id": "provo", "lat": 40.23, "lng": -111.66},
]

# --- attribution: preferred honored, else nearest ---
props = [
    {"id": "p_pref", "est_labor_hours": 10, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "provo"},
    {"id": "p_near", "est_labor_hours": 10, "lat": 40.75, "lng": -111.88, "preferred_branch_id": None},  # near slc
    {"id": "p_far", "est_labor_hours": 10, "lat": 40.24, "lng": -111.65, "preferred_branch_id": None},   # near provo
]
by_branch, unattr = _attribute_to_branches(props, branches)
assert "p_pref" in [p["id"] for p in by_branch["provo"]], "preferred honored"
assert "p_near" in [p["id"] for p in by_branch["slc"]], "nearest = slc"
assert "p_far" in [p["id"] for p in by_branch["provo"]], "nearest = provo"
assert unattr == []

# --- bin-pack: all small -> only 2-person crews, all covered ---
small = [{"id": f"s{i}", "est_labor_hours": 40, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"} for i in range(4)]
crews = _bin_pack_branch(small, "slc")
assert crews and all(c["crew_size"] == 2 for c in crews), [c["crew_size"] for c in crews]
# 4 x 40 = 160 person-hrs; cap2 ~85 => 2 crews (40+40 per crew fits 85)
assert len(crews) == 2, len(crews)
assert all(c["home_branch_id"] == "slc" and c["works_monday"] for c in crews)

# --- a property between cap2 and cap3 forces a 3-person crew ---
mid = [{"id": "mid", "est_labor_hours": 100, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"}]  # 85 < 100 <= 127.5
crews = _bin_pack_branch(mid, "slc")
assert len(crews) == 1 and crews[0]["crew_size"] == 3, crews

# --- oversize (Canyon Park 132.6 > cap3) -> split across 3-person crews ---
big = [{"id": "canyon", "est_labor_hours": 132.6, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"}]
crews = _bin_pack_branch(big, "slc")
import math
assert len(crews) == math.ceil(132.6 / _REC_CAP3) and all(c["crew_size"] == 3 for c in crews), crews

# --- seed_fleet flattens across branches ---
fleet = _seed_fleet(props, branches)
assert all("home_branch_id" in c and "crew_size" in c for c in fleet)
assert {c["home_branch_id"] for c in fleet} <= {"slc", "provo"}

print("check_recommend: PASS (attribution + bin-pack + seed)")
```

- [ ] **Step 4: Run + parse**

Run: `python3 solver/api/check_recommend.py` → `check_recommend: PASS (attribution + bin-pack + seed)`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend.py
git commit -m "feat(solver): analytical seed fleet (attribution + bin-pack)"
```

---

## Task 4: Adjust decision (pure)

**Files:** Modify `solver/api/index.py`; Modify `solver/api/check_recommend.py`.

- [ ] **Step 1: Add `_recommend_adjustments`**

```python
def _recommend_adjustments(
    fleet: list[dict[str, Any]],
    crew_util: list[dict[str, Any]],
    unassigned_ids: list[str],
    prop_branch: dict[str, str],
    prop_labor: dict[str, float],
) -> tuple[list[tuple[str, int]], list[str]]:
    """Decide per-branch crew changes after a validate run.

    Returns (adds, removes): `adds` = list of (branch_id, size) crews to add where a
    branch has uncovered work (size 3 if any uncovered property at that branch exceeds
    a 2-person crew's weekly capacity, else 2); `removes` = crew ids to drop on
    branches that are fully covered yet over-provisioned (all crews under the clock
    floor and more than one crew)."""
    util_by_crew = {u["crew_id"]: float(u["clock_hours"]) for u in crew_util}
    crews_by_branch: dict[str, list[dict[str, Any]]] = {}
    for c in fleet:
        crews_by_branch.setdefault(c["home_branch_id"], []).append(c)

    unassigned_by_branch: dict[str, list[str]] = {}
    for pid in unassigned_ids:
        b = prop_branch.get(pid)
        if b is not None:
            unassigned_by_branch.setdefault(b, []).append(pid)

    adds: list[tuple[str, int]] = []
    for branch_id, pids in unassigned_by_branch.items():
        size = 3 if any(prop_labor.get(pid, 0.0) > _REC_CAP2 for pid in pids) else 2
        adds.append((branch_id, size))

    removes: list[str] = []
    if not unassigned_ids:  # only trim when everything is covered
        for branch_id, crews in crews_by_branch.items():
            if len(crews) > 1 and all(util_by_crew.get(c["id"], 0.0) < _REC_OVER_PROVISIONED_CLOCK for c in crews):
                least = min(crews, key=lambda c: util_by_crew.get(c["id"], 0.0))
                removes.append(least["id"])

    return adds, removes
```

- [ ] **Step 2: Append checks to `check_recommend.py`** (before the final print):

```python
from index import _recommend_adjustments

fleet = [
    {"id": "rec-slc-1", "home_branch_id": "slc", "crew_size": 2},
    {"id": "rec-provo-1", "home_branch_id": "provo", "crew_size": 2},
    {"id": "rec-provo-2", "home_branch_id": "provo", "crew_size": 2},
]
prop_branch = {"u_big": "slc", "u_small": "provo"}
prop_labor = {"u_big": 120.0, "u_small": 10.0}  # 120 > cap2 => needs 3-person

# uncovered work at slc (big) and provo (small) => add 3p at slc, 2p at provo; no removes (unassigned present)
adds, removes = _recommend_adjustments(
    fleet,
    [{"crew_id": "rec-slc-1", "clock_hours": 50}, {"crew_id": "rec-provo-1", "clock_hours": 20}, {"crew_id": "rec-provo-2", "clock_hours": 15}],
    ["u_big", "u_small"], prop_branch, prop_labor,
)
assert ("slc", 3) in adds and ("provo", 2) in adds, adds
assert removes == [], removes

# fully covered, provo over-provisioned (both crews < 40 clock) => trim provo's least-loaded; slc single crew untouched
adds, removes = _recommend_adjustments(
    fleet, [{"crew_id": "rec-slc-1", "clock_hours": 48}, {"crew_id": "rec-provo-1", "clock_hours": 20}, {"crew_id": "rec-provo-2", "clock_hours": 15}],
    [], prop_branch, prop_labor,
)
assert adds == [], adds
assert removes == ["rec-provo-2"], removes  # least-loaded provo crew

print("check_recommend: PASS (adjustments)")
```

- [ ] **Step 3: Run + parse**

Run: `python3 solver/api/check_recommend.py` → ends `check_recommend: PASS (adjustments)`
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`

- [ ] **Step 4: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend.py
git commit -m "feat(solver): per-branch add/trim adjustment decision (pure)"
```

---

## Task 5: `_build_recommendation` + `run_recommendation` loop + dispatch

**Files:** Modify `solver/api/index.py`.

> Calls `run_optimization` (OR-Tools) — not runnable locally. Implement, parse-check, keep pure checks green; verify post-deploy.

- [ ] **Step 1: Add `_build_recommendation` (pure)**

```python
def _build_recommendation(
    fleet: list[dict[str, Any]],
    result: dict[str, Any],
    by_branch: dict[str, list[dict[str, Any]]],
    prop_labor: dict[str, float],
    unattributable: list[str],
    branches: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the recommendation payload from the final fleet + last validate result."""
    branch_name = {b["id"]: b.get("name", b["id"]) for b in branches}
    util_by_crew = {u["crew_id"]: u for u in result.get("crew_utilization", [])}
    crews_by_branch: dict[str, list[dict[str, Any]]] = {}
    for c in fleet:
        crews_by_branch.setdefault(c["home_branch_id"], []).append(c)

    branches_out: list[dict[str, Any]] = []
    tot2 = tot3 = 0
    for branch_id, props in by_branch.items():
        crews = crews_by_branch.get(branch_id, [])
        two = sum(1 for c in crews if c["crew_size"] == 2)
        three = sum(1 for c in crews if c["crew_size"] == 3)
        tot2 += two
        tot3 += three
        demand = sum(float(p["est_labor_hours"]) for p in props)
        scheduled = sum(float(util_by_crew.get(c["id"], {}).get("clock_hours", 0.0)) for c in crews)
        utils = [float(util_by_crew.get(c["id"], {}).get("util_pct", 0.0)) for c in crews]
        drivers = [p["name"] for p in props if float(p["est_labor_hours"]) > _REC_CAP2 and float(p["est_labor_hours"]) <= _REC_CAP3]
        splits = [p["name"] for p in props if float(p["est_labor_hours"]) > _REC_CAP3]
        branches_out.append({
            "branch_id": branch_id,
            "branch_name": branch_name.get(branch_id, branch_id),
            "two_person": two,
            "three_person": three,
            "total_people": two * 2 + three * 3,
            "demand_hours": round(demand, 1),
            "avg_util_pct": round(sum(utils) / len(utils), 1) if utils else 0.0,
            "drivers_three_person": drivers,
            "split_properties": splits,
        })

    unassigned_ids = result.get("unassigned_property_ids", []) or []
    residual_hours = sum(prop_labor.get(pid, 0.0) for pid in unassigned_ids)
    return {
        "branches": branches_out,
        "totals": {
            "two_person": tot2,
            "three_person": tot3,
            "total_crews": tot2 + tot3,
            "total_people": tot2 * 2 + tot3 * 3,
            "demand_hours": round(sum(prop_labor.values()), 1),
        },
        "unattributable_property_ids": unattributable,
        "residual_unassigned": {"count": len(unassigned_ids), "labor_hours": round(residual_hours, 1)},
    }
```

- [ ] **Step 2: Add `run_recommendation`**

```python
def run_recommendation(payload: dict[str, Any]) -> dict[str, Any]:
    """recommend mode: analytical seed -> validate with run_optimization -> bounded
    add/trim loop -> write result to crew_recommendations."""
    started = time.time()
    rec_id = payload.get("recommendation_id")
    branches = payload["branches"]
    properties = payload["properties"]
    try:
        by_branch, unattributable = _attribute_to_branches(properties, branches)
        prop_branch = {p["id"]: b_id for b_id, props in by_branch.items() for p in props}
        prop_labor = {p["id"]: float(p["est_labor_hours"]) for p in properties}

        fleet = _seed_fleet(properties, branches)
        next_idx: dict[str, int] = {}

        def validate(crews: list[dict[str, Any]]) -> dict[str, Any]:
            return run_optimization(
                {"crews": crews, "branches": branches, "properties": properties},
                time_limit_seconds=_REC_VALIDATE_SECONDS,
            )

        result = validate(fleet)
        iterations = 1
        for _round in range(_REC_MAX_RUNS - 1):
            if (time.time() - started) > _REC_TIME_CAP_SECONDS:
                break
            adds, removes = _recommend_adjustments(
                fleet, result["crew_utilization"], result["unassigned_property_ids"], prop_branch, prop_labor
            )
            if not adds and not removes:
                break
            if removes:
                rm = set(removes)
                fleet = [c for c in fleet if c["id"] not in rm]
            for branch_id, size in adds:
                k = next_idx.get(branch_id, 1000) + 1
                next_idx[branch_id] = k
                fleet.append(_make_rec_crew(branch_id, k, size))
            result = validate(fleet)
            iterations += 1

        rec = _build_recommendation(fleet, result, by_branch, prop_labor, unattributable, branches)
        if rec_id:
            _supabase_patch("crew_recommendations", rec_id, {
                "status": "completed",
                "result_jsonb": rec,
                "iterations": iterations,
                "solver_runtime_seconds": round(time.time() - started, 1),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
        return {"status": "completed", "iterations": iterations, **rec}
    except Exception as e:
        if rec_id:
            try:
                _supabase_patch("crew_recommendations", rec_id, {
                    "status": "failed",
                    "failure_reason": str(e)[:500],
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
        raise
```

- [ ] **Step 3: Dispatch `recommend` in `do_POST`**

In `handler.do_POST`, the dispatch currently is:
```python
            run_id = payload.get("run_id")
            mode = payload.get("mode", "optimize")
            result = run_evaluation(payload) if mode == "evaluate" else run_optimization(payload)
            if run_id:
                _persist(run_id, result)
```
Replace with:
```python
            run_id = payload.get("run_id")
            mode = payload.get("mode", "optimize")
            if mode == "recommend":
                # run_recommendation writes its own crew_recommendations row.
                result = run_recommendation(payload)
            elif mode == "evaluate":
                result = run_evaluation(payload)
                if run_id:
                    _persist(run_id, result)
            else:
                result = run_optimization(payload)
                if run_id:
                    _persist(run_id, result)
```
(The outer `except` still marks `optimization_runs` failed for run_id-based modes; `run_recommendation` already marks its own row failed, so no change needed there.)

- [ ] **Step 4: Verify**

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`
Run: `python3 solver/api/check_recommend.py` (all PASS), `python3 solver/api/check_chunking.py` (ALL PASS), `python3 solver/api/check_grouping.py` (PASS).

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): run_recommendation loop + recommend mode dispatch"
```

---

## Task 6: Migration — `crew_recommendations` table

**Files:** Create `supabase/migrations/20260526000100_crew_recommendations.sql`.

- [ ] **Step 1: Write the migration**

```sql
-- Crew-mix recommendations: each run of the solver's `recommend` mode writes one row.
create table if not exists crew_recommendations (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  active_branch_ids uuid[],
  active_property_ids uuid[],
  config_snapshot jsonb,
  result_jsonb jsonb,
  iterations int,
  solver_runtime_seconds numeric,
  failure_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create index if not exists crew_recommendations_created_idx
  on crew_recommendations(created_at desc);
```

- [ ] **Step 2: Commit (note: never auto-applied)**

```bash
git add supabase/migrations/20260526000100_crew_recommendations.sql
git commit -m "feat: crew_recommendations table migration"
```

**Paste-ready SQL for the user** (run via `supabase db push` before deploy):
```sql
create table if not exists crew_recommendations (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  active_branch_ids uuid[], active_property_ids uuid[],
  config_snapshot jsonb, result_jsonb jsonb,
  iterations int, solver_runtime_seconds numeric, failure_reason text,
  started_at timestamp with time zone, completed_at timestamp with time zone,
  created_at timestamp with time zone default now()
);
create index if not exists crew_recommendations_created_idx on crew_recommendations(created_at desc);
```

---

## Task 7: Types + `startRecommendation` action

**Files:** Modify `src/lib/types.ts`; Create `src/app/recommend/actions.ts`.

- [ ] **Step 1: Add types to `src/lib/types.ts`**

```ts
export interface BranchRecommendation {
  branch_id: string;
  branch_name: string;
  two_person: number;
  three_person: number;
  total_people: number;
  demand_hours: number;
  avg_util_pct: number;
  drivers_three_person: string[];
  split_properties: string[];
}

export interface RecommendationResult {
  branches: BranchRecommendation[];
  totals: {
    two_person: number;
    three_person: number;
    total_crews: number;
    total_people: number;
    demand_hours: number;
  };
  unattributable_property_ids: string[];
  residual_unassigned: { count: number; labor_hours: number };
}

export interface CrewRecommendation {
  id: string;
  name: string | null;
  status: RunStatus; // reuse 'pending'|'running'|'completed'|'failed'
  result_jsonb: RecommendationResult | null;
  iterations: number | null;
  solver_runtime_seconds: number | null;
  failure_reason: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Create `src/app/recommend/actions.ts`**

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import type { Branch, Property } from '@/lib/types';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export type RecommendActionResult = { ok: true; recommendation_id: string } | { ok: false; error: string };

export async function startRecommendation(formData: FormData): Promise<RecommendActionResult> {
  try {
    const name = String(formData.get('name') ?? '').trim() || `Fleet recommendation ${new Date().toISOString().slice(0, 16)}`;
    const supabase = getServiceClient();

    const [{ data: branchesData }, { data: propsData }] = await Promise.all([
      supabase.from('branches').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('properties').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
    ]);
    const branches = (branchesData ?? []) as Branch[];
    const properties = (propsData ?? []) as Property[];
    if (branches.length === 0) return { ok: false, error: 'No active geocoded branches' };
    if (properties.length === 0) return { ok: false, error: 'No active geocoded properties' };

    const { data: rec, error: recErr } = await supabase
      .from('crew_recommendations')
      .insert({
        name,
        status: 'running',
        active_branch_ids: branches.map((b) => b.id),
        active_property_ids: properties.map((p) => p.id),
        config_snapshot: { branch_count: branches.length, property_count: properties.length },
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (recErr || !rec) return { ok: false, error: recErr?.message ?? 'Could not create recommendation' };

    void invokeRecommend(rec.id, { branches, properties }).catch(async (e) => {
      await supabase
        .from('crew_recommendations')
        .update({ status: 'failed', failure_reason: e instanceof Error ? e.message : String(e), completed_at: new Date().toISOString() })
        .eq('id', rec.id);
    });

    revalidatePath('/recommend');
    return { ok: true, recommendation_id: rec.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function invokeRecommend(recId: string, payload: { branches: Branch[]; properties: Property[] }) {
  if (!PYTHON_SOLVER_URL) throw new Error('PYTHON_SOLVER_URL is not configured.');
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recommendation_id: recId, mode: 'recommend', ...payload }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
```

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean. `npm run lint` → clean.
```bash
git add src/lib/types.ts src/app/recommend/actions.ts
git commit -m "feat: CrewRecommendation types + startRecommendation action"
```

---

## Task 8: `/recommend` page + form + table + nav

**Files:** Create `src/app/recommend/{page.tsx,recommend-form.tsx,recommend-table.tsx,recommend-refresher.tsx}`; Modify `src/components/top-nav.tsx`.

- [ ] **Step 1: `recommend-form.tsx` (client)**

```tsx
'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { startRecommendation } from './actions';

export function RecommendForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const r = await startRecommendation(fd);
          if (r.ok) router.refresh();
          else setError(r.error);
        });
      }}
      className="flex items-end gap-3"
    >
      <div>
        <Label htmlFor="name">Recommendation name</Label>
        <Input id="name" name="name" placeholder="Fleet plan — June 2026" />
      </div>
      <Button type="submit" disabled={pending}>{pending ? 'Starting…' : 'Recommend fleet'}</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
```

- [ ] **Step 2: `recommend-table.tsx` (presentational)**

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecommendationResult } from '@/lib/types';

export function RecommendTable({ result }: { result: RecommendationResult }) {
  const t = result.totals;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Recommended fleet</CardDescription>
          <CardTitle className="text-2xl">
            {t.total_crews} crews · {t.two_person} two-person + {t.three_person} three-person · {t.total_people} people
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Covers ~{t.demand_hours.toFixed(0)} person-hours/week across {result.branches.length} branches.
          {result.residual_unassigned.count > 0 && (
            <span className="text-amber-700">
              {' '}⚠️ {result.residual_unassigned.count} properties (~{result.residual_unassigned.labor_hours.toFixed(0)} h)
              still uncovered — a true capacity limit.
            </span>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>By branch</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Demand (h/wk)</TableHead>
                <TableHead className="text-right">2-person</TableHead>
                <TableHead className="text-right">3-person</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead className="text-right">Avg util</TableHead>
                <TableHead>3-person driven by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.branches.map((b) => (
                <TableRow key={b.branch_id}>
                  <TableCell className="font-medium">{b.branch_name}</TableCell>
                  <TableCell className="text-right">{b.demand_hours.toFixed(0)}</TableCell>
                  <TableCell className="text-right">{b.two_person}</TableCell>
                  <TableCell className="text-right">{b.three_person}</TableCell>
                  <TableCell className="text-right">{b.total_people}</TableCell>
                  <TableCell className="text-right">{b.avg_util_pct.toFixed(0)}%</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[...b.drivers_three_person, ...b.split_properties.map((s) => `${s} (split)`)].join(', ') || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {result.unattributable_property_ids.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {result.unattributable_property_ids.length} properties couldn’t be attributed to a branch (missing coordinates) and were excluded.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `recommend-refresher.tsx` (client, auto-refresh while running)**

A small local poller (avoids importing across the `[runId]` bracket dir):

```tsx
'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function RecommendRefresher({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return null;
}
```

- [ ] **Step 4: `page.tsx` (server, polls while running)**

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getServerClient } from '@/lib/supabase';
import type { CrewRecommendation } from '@/lib/types';
import { RecommendRefresher } from './recommend-refresher';
import { RecommendForm } from './recommend-form';
import { RecommendTable } from './recommend-table';

export const dynamic = 'force-dynamic';

export default async function RecommendPage() {
  const supabase = getServerClient();
  const { data } = await supabase
    .from('crew_recommendations')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const rec = (data as CrewRecommendation) ?? null;
  const polling = rec?.status === 'running' || rec?.status === 'pending';

  return (
    <div className="space-y-6">
      {polling && <RecommendRefresher />}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Recommend fleet</h1>
        <p className="text-sm text-muted-foreground">
          Suggests crews per branch and the 2-/3-person mix to cover the portfolio sustainably, validated by the
          routing solver. Takes several minutes.
        </p>
      </div>

      <RecommendForm />

      {!rec && (
        <Card><CardHeader><CardDescription>No recommendation yet — run one above.</CardDescription></CardHeader></Card>
      )}

      {rec && polling && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Computing… <Badge variant="warning">{rec.status}</Badge>
            </CardTitle>
            <CardDescription>Seeding a fleet and validating it with the solver across several rounds. This page refreshes automatically.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {rec && rec.status === 'failed' && (
        <Card className="border-destructive/40">
          <CardHeader><CardTitle>Recommendation failed</CardTitle><CardDescription>{rec.failure_reason ?? 'Unknown error'}</CardDescription></CardHeader>
        </Card>
      )}

      {rec && rec.status === 'completed' && rec.result_jsonb && (
        <>
          <RecommendTable result={rec.result_jsonb} />
          <p className="text-xs text-muted-foreground">
            {rec.iterations ?? 0} solver round(s) · {rec.solver_runtime_seconds ?? 0}s. Analytical seed validated by the
            optimizer; capacity assumes ~50 sustainable clock-hrs/crew/wk. Create these crews and run the optimizer to confirm.
          </p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add nav link** in `src/components/top-nav.tsx` — after the `{ href: '/compare', label: 'Compare' }` entry add:
```ts
  { href: '/recommend', label: 'Recommend' },
```

- [ ] **Step 6: Verify + commit**

Run: `npm run typecheck && npm run lint && npm run build` → clean; `/recommend` in the route table.
```bash
git add src/app/recommend/ src/components/top-nav.tsx
git commit -m "feat: /recommend page (trigger + poll + per-branch fleet table)"
```

---

## Task 9: Full verification + post-deploy checklist

- [ ] **Step 1: Local checks**

Run: `python3 solver/api/check_recommend.py` (all PASS), `python3 solver/api/check_chunking.py` (ALL PASS), `python3 solver/api/check_grouping.py` (PASS).
Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read()); print('ok')"` → `ok`.
Run: `npm run typecheck && npm run lint && npm run test && npm run build` → all clean/green.

- [ ] **Step 2: Post-deploy (after migration + solver redeploy + web deploy)**

1. Apply the Task 6 SQL (`supabase db push`); redeploy `solver/`; deploy web.
2. On `/recommend`, click "Recommend fleet"; the page polls and reaches `completed` within ~minutes.
3. Per-branch table shows a sensible 2/3 mix; big properties (e.g. Canyon Park) appear under "3-person driven by" / "(split)".
4. `residual_unassigned` is 0 for a feasible portfolio (or flags a genuine capacity gap).
5. Sanity-check one branch: create the recommended crews and run `/optimize` — coverage + utilization should roughly match the recommendation.

- [ ] **Step 3: Record results; tune constants if the mix/count looks off** (`_REC_SUSTAINABLE_CLOCK_PER_WEEK`, `_REC_USABLE_FRACTION`, `_REC_OVER_PROVISIONED_CLOCK`).

---

## Notes for the executor

- **Three deploy steps:** migration → solver redeploy → web deploy. The recommendation needs the new table and the new solver mode.
- **Runtime:** bounded by `_REC_MAX_RUNS` (5) × `_REC_VALIDATE_SECONDS` (5)/day + `_REC_TIME_CAP_SECONDS` (600). Several-minute background job; the page polls.
- **Pure-first:** attribution, bin-pack, adjust decision, and result-build are pure and locally checked; only `run_recommendation`'s loop calls `run_optimization` (post-deploy gate).
- **DRY:** synthetic-crew shape lives only in `_make_rec_crew`; capacity/threshold logic only in the `_REC_*` constants; the recommender reuses `run_optimization` unchanged (via the new optional param) rather than duplicating routing.
