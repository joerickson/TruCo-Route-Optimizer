# Capital-Aware Crew Recommender + What-If Preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the from-scratch recommender with a capital-aware delta planner
(relocate→upsize→buy, $110k/new crew, UI-editable) and persist its resulting
schedule as a viewable read-only `what_if` run linked from `/recommend`.

**Architecture:** Pure Python planner (`_plan_fleet_changes`) in the solver, driven by
a baseline solver run for current util; `run_recommendation` orchestrates baseline →
plan → proposed-validate(+bounded refine) → persist what-if run + recommendation.
Web: capex input, crews in payload, delta-view table, what-if link, run-page gate.

**Tech Stack:** Python (OR-Tools solver, backgrounded), Next.js 14 App Router, Supabase.

**Spec:** `docs/superpowers/specs/2026-05-27-recommender-fix-and-whatif-design.md`

**Deploy order (after merge):** run migration (Task 3 SQL) → redeploy solver → push web.

---

### Task 1: Capital-aware planner — constants, `_make_rec_crew` name, `_plan_fleet_changes` (pure)

**Files:**
- Modify: `solver/api/index.py` (constants block ~line 80-89; `_make_rec_crew` ~line 326; add `_plan_fleet_changes`)
- Test: `solver/api/check_recommend_plan.py` (new)

- [ ] **Step 1: Add constants** after the existing recommender tunables (after `_REC_VALIDATE_SECONDS = 5`):

```python
_REC_TIGHT_CLOCK_PER_WEEK = 55.0   # add-trigger ceiling (deferred-capex "tight" band)
_REC_CAP2_TIGHT = _REC_USABLE_FRACTION * _REC_TIGHT_CLOCK_PER_WEEK * 2  # ~93.5
_REC_CAP3_TIGHT = _REC_USABLE_FRACTION * _REC_TIGHT_CLOCK_PER_WEEK * 3  # ~140.25
_REC_DEFAULT_CREW_CAPEX_USD = 110_000.0
```

- [ ] **Step 2: Change `_make_rec_crew` signature + name** so synthetic crews read well on the run page. Replace its definition:

```python
def _make_rec_crew(branch_id: str, k: int, size: int, branch_label: str | None = None) -> dict[str, Any]:
    """A synthetic Mon-Fri crew at a branch, shaped for run_optimization."""
    label = branch_label or branch_id
    return {
        "id": f"rec-{branch_id}-{k}",
        "name": f"{label} · {size}p #{k}",
        "crew_size": size,
        "home_branch_id": branch_id,
        "max_clock_hours_per_day": _REC_MAX_HOURS_PER_DAY,
        "works_monday": True, "works_tuesday": True, "works_wednesday": True,
        "works_thursday": True, "works_friday": True,
        "works_saturday": False, "works_sunday": False,
    }
```

Note: `_bin_pack_branch` (used only by the now-legacy `_seed_fleet`) calls
`_make_rec_crew(branch_id, k+1, b["size"])` — still valid (new arg defaults). Leave
`_seed_fleet`/`_bin_pack_branch`/`_recommend_adjustments` in place for now; Task 2
stops calling them. `check_recommend.py` keeps passing.

- [ ] **Step 3: Add `_plan_fleet_changes`** (pure; no OR-Tools). Place after `_recommend_adjustments`:

```python
def _plan_fleet_changes(
    current_crews: list[dict[str, Any]],
    by_branch: dict[str, list[dict[str, Any]]],
    util_by_crew: dict[str, float],
    branch_name: dict[str, str],
    capex_usd: float,
) -> dict[str, Any]:
    """Capital-aware delta planner. Given the current fleet + per-branch attributed
    properties + baseline per-crew clock-hours, return the cheapest set of changes
    (relocate $0 -> upsize 2->3 labor-only -> buy $110k) to bring each branch within
    the ~55 clock-h/wk tight ceiling, then rebalance remaining idle crews toward the
    most-loaded branches. Returns {proposed_crews, branches, changes, totals}.

    MIRRORS the lever order/caps of src/lib/unassigned-fix.ts (TS, web) on purpose;
    different runtimes (this needs the solver's background-job loop). Keep in sync.
    """
    # Working copy of the fleet (mutable home_branch_id / crew_size).
    crews = [dict(c, crew_size=int(c.get("crew_size") or 2)) for c in current_crews]
    branch_ids = list(by_branch.keys())
    crews_at: dict[str, list[dict[str, Any]]] = {bid: [] for bid in branch_ids}
    for c in crews:
        crews_at.setdefault(c["home_branch_id"], []).append(c)

    demand = {bid: sum(float(p["est_labor_hours"]) for p in props) for bid, props in by_branch.items()}
    baseline_clock: dict[str, float] = {}
    for c in current_crews:
        baseline_clock[c["home_branch_id"]] = baseline_clock.get(c["home_branch_id"], 0.0) + util_by_crew.get(c["id"], 0.0)

    def cap_of(c): return _REC_CAP3_TIGHT if c["crew_size"] == 3 else _REC_CAP2_TIGHT
    def branch_cap(bid): return sum(cap_of(c) for c in crews_at.get(bid, []))
    def deficit(bid): return demand.get(bid, 0.0) - branch_cap(bid)
    def has_big(bid): return any(float(p["est_labor_hours"]) > _REC_CAP2 for p in by_branch.get(bid, []))
    def has_three(bid): return any(c["crew_size"] == 3 for c in crews_at.get(bid, []))
    def is_idle(c): return util_by_crew.get(c["id"], 0.0) < _REC_OVER_PROVISIONED_CLOCK
    def est_avg(bid):
        n = len(crews_at.get(bid, []))
        return baseline_clock.get(bid, 0.0) / n if n else 0.0

    def sources():  # idle crews at non-short branches, biggest first then name
        out = [c for c in crews if is_idle(c) and deficit(c["home_branch_id"]) <= 0]
        out.sort(key=lambda c: (-cap_of(c), c.get("name", "")))
        return out

    relocations: list[dict[str, Any]] = []
    upsizes: dict[str, int] = {}
    additions: dict[tuple[str, int], int] = {}
    new_idx: dict[str, int] = {}

    def relocate(c, to_bid, reason):
        frm = c["home_branch_id"]
        crews_at[frm].remove(c)
        c["home_branch_id"] = to_bid
        crews_at.setdefault(to_bid, []).append(c)
        relocations.append({
            "crew_name": c.get("name", c["id"]),
            "from_branch_name": branch_name.get(frm, frm),
            "to_branch_name": branch_name.get(to_bid, to_bid),
            "reason": reason,
        })

    def upsize(bid):
        twos = [c for c in crews_at[bid] if c["crew_size"] == 2]
        if not twos:
            return False
        twos[0]["crew_size"] = 3
        upsizes[bid] = upsizes.get(bid, 0) + 1
        return True

    def buy(bid, size):
        k = new_idx.get(bid, 0) + 1
        new_idx[bid] = k
        nc = _make_rec_crew(bid, k, size, branch_name.get(bid, bid))
        crews.append(nc)
        crews_at[bid].append(nc)
        additions[(bid, size)] = additions.get((bid, size), 0) + 1

    # TIER 1: close >55 deficits, cheapest lever first.
    for bid in sorted([b for b in branch_ids if deficit(b) > 0], key=lambda b: -deficit(b)):
        while deficit(bid) > 0:
            srcs = [s for s in sources() if s["home_branch_id"] != bid]
            if not srcs:
                break
            relocate(srcs[0], bid, "deficit")
        while deficit(bid) > 0 and upsize(bid):
            pass
        while deficit(bid) > 0:
            buy(bid, 3 if (has_big(bid) and not has_three(bid)) else 2)

    # Big-property feasibility: every branch with a >CAP2 property needs a 3-person crew.
    for bid in branch_ids:
        if has_big(bid) and not has_three(bid):
            if not upsize(bid):
                buy(bid, 3)

    # TIER 2: rebalance remaining idle crews toward most-loaded branches still > 50.
    while True:
        srcs = sources()
        if not srcs:
            break
        targets = sorted(
            [b for b in branch_ids if est_avg(b) > _REC_SUSTAINABLE_CLOCK_PER_WEEK],
            key=lambda b: -est_avg(b),
        )
        moved = False
        for tb in targets:
            src = next((s for s in srcs if s["home_branch_id"] != tb), None)
            if src is None:
                continue
            relocate(src, tb, "rebalance")
            moved = True
            break
        if not moved:
            break

    # Surplus: idle crews with no beneficial target (flagged, never disbanded).
    surplus: dict[str, int] = {}
    for s in sources():
        surplus[s["home_branch_id"]] = surplus.get(s["home_branch_id"], 0) + 1

    # --- assemble output ---
    def counts(crew_list):
        return {"two": sum(1 for c in crew_list if c["crew_size"] == 2),
                "three": sum(1 for c in crew_list if c["crew_size"] == 3)}

    before_at: dict[str, list[dict[str, Any]]] = {}
    for c in current_crews:
        before_at.setdefault(c["home_branch_id"], []).append(c)

    branches_out: dict[str, Any] = {}
    for bid in branch_ids:
        relocated_in = [r["crew_name"] for r in relocations if r["to_branch_name"] == branch_name.get(bid, bid)]
        added = {"two": additions.get((bid, 2), 0), "three": additions.get((bid, 3), 0)}
        branches_out[bid] = {
            "crews_before": counts(before_at.get(bid, [])),
            "crews_after": counts(crews_at.get(bid, [])),
            "relocated_in": relocated_in,
            "upsized": upsizes.get(bid, 0),
            "added": added,
        }

    new_crews = sum(additions.values())
    changes = {
        "relocations": relocations,
        "upsizes": [{"branch_name": branch_name.get(b, b), "count": n} for b, n in upsizes.items()],
        "additions": [{"branch_name": branch_name.get(b, b), "size": s, "count": n} for (b, s), n in additions.items()],
        "surplus_idle": [{"branch_name": branch_name.get(b, b), "count": n} for b, n in surplus.items()],
    }
    totals = {
        "fleet_before": len(current_crews),
        "fleet_after": len(crews),
        "new_crews": new_crews,
        "capex_usd": float(capex_usd),
        "net_capital_usd": int(new_crews * float(capex_usd)),
    }
    return {"proposed_crews": crews, "branches": branches_out, "changes": changes, "totals": totals}
```

- [ ] **Step 4: Write `solver/api/check_recommend_plan.py`** (pattern from `check_recommend.py`):

```python
"""Pure checks for the capital-aware planner. Run:
python3 solver/api/check_recommend_plan.py   (no OR-Tools needed)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _plan_fleet_changes, _make_rec_crew, _REC_CAP2

BN = {"slc": "SLC HQ", "stg": "St George", "lin": "Lindon"}

def crew(cid, bid, size=2):
    return {"id": cid, "name": cid, "crew_size": size, "home_branch_id": bid}

def props(bid, *hours):
    return [{"id": f"{bid}-p{i}", "est_labor_hours": h} for i, h in enumerate(hours)]

# --- no over-provisioning: small branch with idle crew + routing artifact -> no change ---
by_branch = {"stg": props("stg", 78.0)}                  # demand 78 < CAP2_TIGHT 93.5
plan = _plan_fleet_changes([crew("c1", "stg", 2)], by_branch, {"c1": 18.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["changes"]["upsizes"] == [] and plan["changes"]["additions"] == [], plan["changes"]
# idle crew, but every branch <=50 => surplus (not relocated, not bought)
assert plan["changes"]["surplus_idle"] == [{"branch_name": "St George", "count": 1}], plan["changes"]

# --- relocate-first: short branch + idle crew elsewhere -> relocate ($0), no buy ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("idle", "stg", 3)]    # slc deficit (200 > 140.25), stg idle
plan = _plan_fleet_changes(crews, by_branch, {"a": 52.0, "idle": 8.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
reloc = plan["changes"]["relocations"]
assert any(r["to_branch_name"] == "SLC HQ" and r["reason"] == "deficit" for r in reloc), reloc

# --- upsize-before-buy: short branch, no sources, has a 2-person crew -> upsize ---
by_branch = {"slc": props("slc", 130.0)}                 # 130 > CAP2_TIGHT 93.5, < CAP3_TIGHT 140.25
plan = _plan_fleet_changes([crew("a", "slc", 2)], by_branch, {"a": 56.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert sum(u["count"] for u in plan["changes"]["upsizes"]) == 1, plan["changes"]

# --- buy-last: short branch, no crews at all -> buy; 3p when a >CAP2 property exists ---
by_branch = {"slc": props("slc", 100.0)}                 # 100 > CAP2 (85) => big => 3-person
plan = _plan_fleet_changes([], by_branch, {}, BN, 110000)
assert plan["totals"]["new_crews"] >= 1, plan["totals"]
assert any(a["size"] == 3 for a in plan["changes"]["additions"]), plan["changes"]
assert plan["totals"]["net_capital_usd"] == plan["totals"]["new_crews"] * 110000, plan["totals"]

# --- rebalance: no deficit, idle crew at <=40 branch, another branch avg >50 -> relocate(rebalance) ---
by_branch = {"slc": props("slc", 90.0), "stg": props("stg", 5.0)}
crews = [crew("busy", "slc", 2), crew("idle", "stg", 2)]
plan = _plan_fleet_changes(crews, by_branch, {"busy": 58.0, "idle": 6.0}, BN, 110000)
assert any(r["reason"] == "rebalance" and r["to_branch_name"] == "SLC HQ" for r in plan["changes"]["relocations"]), plan["changes"]
assert plan["totals"]["new_crews"] == 0, plan["totals"]

# --- capex echo + name format ---
assert _make_rec_crew("lin", 1, 3, "Lindon")["name"] == "Lindon · 3p #1"
plan = _plan_fleet_changes([], {"slc": props("slc", 200.0)}, {}, BN, 90000)
assert plan["totals"]["capex_usd"] == 90000 and plan["totals"]["net_capital_usd"] == plan["totals"]["new_crews"] * 90000

print("check_recommend_plan: PASS")
```

- [ ] **Step 5: Run checks** (both must pass; OR-Tools not needed):

Run: `python3 solver/api/check_recommend_plan.py && python3 solver/api/check_recommend.py`
Expected: `check_recommend_plan: PASS` and the two `check_recommend: PASS` lines.

- [ ] **Step 6: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend_plan.py
git commit -m "feat(solver): capital-aware fleet-change planner (relocate/upsize/buy + rebalance)"
```

---

### Task 2: Rewire `run_recommendation` + `_build_recommendation` + `_supabase_insert` + what-if run

**Files:**
- Modify: `solver/api/index.py` (`run_recommendation` ~line 749; `_build_recommendation` ~line 427; add `_supabase_insert` near `_supabase_patch` ~line 814)

- [ ] **Step 1: Add `_supabase_insert`** right after `_supabase_patch`:

```python
def _supabase_insert(table: str, row: dict[str, Any]) -> str:
    """INSERT one row via REST, returning its id. Mirrors _supabase_patch's auth/error handling."""
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(f"Missing supabase env: url_set={bool(url)}, key_set={bool(key)}")
    req = urllib.request.Request(
        f"{url}/rest/v1/{table}",
        method="POST",
        data=json.dumps(row).encode("utf-8"),
        headers={
            "apikey": key, "Authorization": f"Bearer {key}",
            "Content-Type": "application/json", "Prefer": "return=representation",
        },
    )
    try:
        resp_body = urllib.request.urlopen(req, timeout=10).read().decode()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Supabase INSERT {e.code}: {e.read().decode()[:300]}") from None
    rows = json.loads(resp_body) if resp_body else []
    if not rows:
        raise RuntimeError(f"Insert returned no rows for {table}")
    return rows[0]["id"]
```

- [ ] **Step 2: Replace `_build_recommendation`** with the delta-shape builder. It takes the
plan (from Task 1), the proposed-fleet validate `result`, the per-branch attribution,
labor map, unattributable ids, branches, and the baseline `util_before` map:

```python
def _build_recommendation(
    plan: dict[str, Any],
    result: dict[str, Any],
    by_branch: dict[str, list[dict[str, Any]]],
    prop_labor: dict[str, float],
    unattributable: list[str],
    branches: list[dict[str, Any]],
    proposed_crews: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble the delta-shape recommendation payload (see spec §5). Per-branch
    `util_before_pct` is precomputed onto plan["branches"][bid] by run_recommendation."""
    branch_name = {b["id"]: b.get("name", b["id"]) for b in branches}
    util_after = {u["crew_id"]: float(u.get("util_pct", 0.0)) for u in result.get("crew_utilization", [])}
    crews_after_at: dict[str, list[str]] = {}
    for c in proposed_crews:
        crews_after_at.setdefault(c["home_branch_id"], []).append(c["id"])

    def avg(vals): return round(sum(vals) / len(vals), 1) if vals else 0.0

    branches_out = []
    for bid, props in by_branch.items():
        pb = plan["branches"].get(bid, {})
        after_ids = crews_after_at.get(bid, [])
        branches_out.append({
            "branch_id": bid,
            "branch_name": branch_name.get(bid, bid),
            "demand_hours": round(sum(float(p["est_labor_hours"]) for p in props), 1),
            "crews_before": pb.get("crews_before", {"two": 0, "three": 0}),
            "crews_after": pb.get("crews_after", {"two": 0, "three": 0}),
            "util_before_pct": pb.get("util_before_pct", 0.0),
            "util_after_pct": avg([util_after.get(cid, 0.0) for cid in after_ids]),
            "relocated_in": pb.get("relocated_in", []),
            "upsized": pb.get("upsized", 0),
            "added": pb.get("added", {"two": 0, "three": 0}),
            "drivers_three_person": [p["name"] for p in props if _REC_CAP2 < float(p["est_labor_hours"]) <= _REC_CAP3],
            "split_properties": [p["name"] for p in props if float(p["est_labor_hours"]) > _REC_CAP3],
        })

    unassigned_ids = result.get("unassigned_property_ids", []) or []
    return {
        "branches": branches_out,
        "changes": plan["changes"],
        "totals": {**plan["totals"], "demand_hours": round(sum(prop_labor.values()), 1)},
        "unattributable_property_ids": unattributable,
        "residual_unassigned": {"count": len(unassigned_ids),
                                "labor_hours": round(sum(prop_labor.get(pid, 0.0) for pid in unassigned_ids), 1)},
    }
```

- [ ] **Step 3: Replace `run_recommendation` body** (keep the `rec_id`/try/except shell + the failed-status patch):

```python
def run_recommendation(payload: dict[str, Any]) -> dict[str, Any]:
    """recommend mode: baseline validate -> capital-aware plan -> proposed validate
    (+ bounded refine) -> persist what-if run + delta recommendation."""
    started = time.time()
    rec_id = payload.get("recommendation_id")
    branches = payload["branches"]
    properties = payload["properties"]
    current_crews = payload.get("crews", [])
    capex_usd = float(payload.get("capex_usd") or _REC_DEFAULT_CREW_CAPEX_USD)
    target_week = payload.get("target_week")
    rec_name = payload.get("name") or "Fleet recommendation"
    try:
        by_branch, unattributable = _attribute_to_branches(properties, branches)
        prop_labor = {p["id"]: float(p["est_labor_hours"]) for p in properties}
        branch_name = {b["id"]: b.get("name", b["id"]) for b in branches}

        def validate(crews):
            return run_optimization(
                {"crews": crews, "branches": branches, "properties": properties},
                time_limit_seconds=_REC_VALIDATE_SECONDS,
            )

        # 1) baseline: current fleet -> per-crew clock + avg per branch
        baseline = validate(current_crews) if current_crews else {"crew_utilization": []}
        util_before = {u["crew_id"]: float(u["clock_hours"]) for u in baseline.get("crew_utilization", [])}
        util_before_pct = {u["crew_id"]: float(u.get("util_pct", 0.0)) for u in baseline.get("crew_utilization", [])}

        # 2) plan deltas
        plan = _plan_fleet_changes(current_crews, by_branch, util_before, branch_name, capex_usd)

        # attach per-branch before-util for the builder
        before_at: dict[str, list[str]] = {}
        for c in current_crews:
            before_at.setdefault(c["home_branch_id"], []).append(c["id"])
        for bid in by_branch:
            ids = before_at.get(bid, [])
            vals = [util_before_pct.get(cid, 0.0) for cid in ids]
            plan["branches"].setdefault(bid, {})["util_before_pct"] = round(sum(vals) / len(vals), 1) if vals else 0.0

        # 3) validate proposed fleet (+ bounded refine handled by the planner's tight caps;
        #    one validate is sufficient — the planner already sizes to the 55h ceiling).
        proposed = plan["proposed_crews"]
        result = validate(proposed) if proposed else baseline
        iterations = (1 if current_crews else 0) + (1 if proposed else 0)

        # 4) persist what-if run, link it
        run_id = None
        if target_week and proposed:
            try:
                run_id = _supabase_insert("optimization_runs", {
                    "name": f"What-if: {rec_name}",
                    "run_kind": "what_if",
                    "target_week_start_date": target_week,
                    "active_branch_ids": [b["id"] for b in branches],
                    "active_property_ids": [p["id"] for p in properties],
                    "status": "completed",
                    "solver_runtime_seconds": result.get("solver_runtime_seconds"),
                    "total_clock_hours_per_week": result.get("total_clock_hours_per_week"),
                    "total_labor_hours_per_week": result.get("total_labor_hours_per_week"),
                    "total_drive_hours_per_week": result.get("total_drive_hours_per_week"),
                    "total_drive_miles_per_week": result.get("total_drive_miles_per_week"),
                    "crew_utilization": result.get("crew_utilization"),
                    "capacity_recommendation": result.get("capacity_recommendation"),
                    "recommendation_text": result.get("recommendation_text"),
                    "routes_jsonb": result.get("routes_jsonb"),
                    "unassigned_property_ids": result.get("unassigned_property_ids"),
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                run_id = None  # best-effort link

        rec = _build_recommendation(plan, result, by_branch, prop_labor, unattributable,
                                     branches, proposed)
        if rec_id:
            fields = {
                "status": "completed",
                "result_jsonb": rec,
                "iterations": iterations,
                "solver_runtime_seconds": round(time.time() - started, 1),
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }
            if run_id:
                fields["optimization_run_id"] = run_id
            _supabase_patch("crew_recommendations", rec_id, fields)
        return {"status": "completed", "iterations": iterations, "optimization_run_id": run_id, **rec}
    except Exception as e:
        if rec_id:
            try:
                _supabase_patch("crew_recommendations", rec_id, {
                    "status": "failed", "failure_reason": str(e)[:500],
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                })
            except Exception:
                pass
        raise
```

- [ ] **Step 2-verify: Python compiles + pure checks still pass** (OR-Tools paths run post-deploy):

Run: `python3 -c "import ast; ast.parse(open('solver/api/index.py').read())" && python3 solver/api/check_recommend_plan.py`
Expected: no output from the parse (valid syntax), then `check_recommend_plan: PASS`.

- [ ] **Step 3: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): recommend mode = baseline+plan+proposed validate, persist what-if run"
```

---

### Task 3: Migration — `optimization_run_id` + `what_if` run_kind

**Files:**
- Create: `supabase/migrations/20260527000100_recommender_whatif.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Link a crew recommendation to the read-only "what-if" optimization run that shows
-- the schedule its recommended fleet produces.
alter table public.crew_recommendations
  add column if not exists optimization_run_id uuid
    references public.optimization_runs(id) on delete set null;

-- Allow the what-if run kind (existing inline check is auto-named *_run_kind_check).
alter table public.optimization_runs drop constraint if exists optimization_runs_run_kind_check;
alter table public.optimization_runs
  add constraint optimization_runs_run_kind_check
    check (run_kind in ('optimized','baseline','what_if'));
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260527000100_recommender_whatif.sql
git commit -m "feat(db): crew_recommendations.optimization_run_id + what_if run_kind"
```

---

### Task 4: Web types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Replace `RecommendationResult` + `BranchRecommendation`** with the delta shape, and extend two existing types:

```ts
export interface BranchRecommendation {
  branch_id: string;
  branch_name: string;
  demand_hours: number;
  crews_before: { two: number; three: number };
  crews_after: { two: number; three: number };
  util_before_pct: number;
  util_after_pct: number;
  relocated_in: string[];
  upsized: number;
  added: { two: number; three: number };
  drivers_three_person: string[];
  split_properties: string[];
}

export interface RecommendationChanges {
  relocations: { crew_name: string; from_branch_name: string; to_branch_name: string; reason: 'deficit' | 'rebalance' }[];
  upsizes: { branch_name: string; count: number }[];
  additions: { branch_name: string; size: 2 | 3; count: number }[];
  surplus_idle: { branch_name: string; count: number }[];
}

export interface RecommendationResult {
  branches: BranchRecommendation[];
  changes: RecommendationChanges;
  totals: {
    fleet_before: number;
    fleet_after: number;
    new_crews: number;
    capex_usd: number;
    net_capital_usd: number;
    demand_hours: number;
  };
  unattributable_property_ids: string[];
  residual_unassigned: { count: number; labor_hours: number };
}
```

Add `optimization_run_id: string | null;` to `CrewRecommendation` (after `result_jsonb`).
Change `OptimizationRun.run_kind` to `'optimized' | 'baseline' | 'what_if'`.

- [ ] **Step 2: Typecheck** (will fail in `recommend-table.tsx` until Task 6 — expected):

Run: `npm run typecheck`
Expected: errors only in `src/app/recommend/recommend-table.tsx` (old field names). That's fixed in Task 6; if any *other* file errors, fix it here.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): delta-shape RecommendationResult + optimization_run_id + what_if run_kind"
```

---

### Task 5: Recommend form (capex input) + action (crews/capex/target_week in payload)

**Files:**
- Modify: `src/app/recommend/recommend-form.tsx`, `src/app/recommend/actions.ts`

- [ ] **Step 1: Add the capex input** to `recommend-form.tsx` — a number `Input name="capex"` defaulting to `110000`, placed before the submit button:

```tsx
      <div>
        <Label htmlFor="capex">Capex per new crew ($)</Label>
        <Input id="capex" name="capex" type="number" min={0} step={1000} defaultValue={110000} />
      </div>
```

- [ ] **Step 2: Update `startRecommendation`** in `actions.ts`:
  - also fetch active crews: add to the `Promise.all` a query
    `supabase.from('crews').select('*').eq('is_active', true)` → `crews`.
  - parse capex: `const capex = Number(formData.get('capex')); const capex_usd = Number.isFinite(capex) && capex >= 0 ? capex : 110000;`
  - compute target_week (current week's Monday, ISO date):
    ```ts
    const now = new Date();
    const dow = (now.getUTCDay() + 6) % 7; // 0=Mon
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
    const target_week = monday.toISOString().slice(0, 10);
    ```
  - include `crews`, `capex_usd`, `target_week`, and `name` in the `invokeRecommend` payload:
    `void invokeRecommend(rec.id, { branches, properties, crews, capex_usd, target_week, name }).catch(...)`
  - widen `invokeRecommend`'s `payload` param type accordingly (`crews: Crew[]; capex_usd: number; target_week: string; name: string`). Import `Crew` from `@/lib/types`.
  - store capex in the existing `config_snapshot` insert (`{ ...prev, capex_usd }`) for traceability.

- [ ] **Step 3: Typecheck + lint** (recommend-table still errors until Task 6):

Run: `npm run lint`
Expected: clean (lint doesn't fail on the table's type errors). Typecheck still shows only `recommend-table.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/app/recommend/recommend-form.tsx src/app/recommend/actions.ts
git commit -m "feat(recommend): capex input + current crews/target_week in solver payload"
```

---

### Task 6: Recommend results — delta view + what-if link

**Files:**
- Modify: `src/app/recommend/recommend-table.tsx`, `src/app/recommend/page.tsx`

- [ ] **Step 1: Rewrite `recommend-table.tsx`** to render the delta shape. Component
signature gains the run link: `export function RecommendTable({ result, runId }: { result: RecommendationResult; runId: string | null })`.
Render, in order:
  1. **Headline card:** `Net new capital: $${(t.net_capital_usd).toLocaleString()}` · `Fleet ${t.fleet_before} → ${t.fleet_after}` · `${t.new_crews} new crew(s) @ $${t.capex_usd.toLocaleString()}`. Residual-unassigned warning as today.
  2. **What-if link** (when `runId`): an anchor/button `View optimized schedule for this fleet →` to `/runs/${runId}` (use `next/link`).
  3. **Changes card:** four sub-lists, each omitted when empty:
     - Relocations: `Move {crew_name}: {from} → {to}` + a muted `$0 · {reason}`.
     - Upsizes: `Upsize {count} crew(s) at {branch} to 3-person` + muted `labor only`.
     - Additions: `Add {count} {size}-person crew(s) at {branch}` + `${count*capex} capital`.
     - Surplus idle: `{count} idle crew(s) at {branch} — could be redeployed`.
     - If all four empty: "No fleet changes needed — current crews cover demand within the sustainable ceiling."
  4. **By-branch table:** columns Branch · Demand (h/wk) · Crews before (e.g. `2×2p`) · Crews after · Util before → after · 3-person driven by (reuse `drivers_three_person`+`split_properties` join). Use `b.crews_before/after` (format `${x.two}×2p + ${x.three}×3p` or `—`), `b.util_before_pct`/`b.util_after_pct`.
  5. Unattributable footnote as today.

  Keep using existing `Card`/`Table` primitives; escape entities (`&rarr;` or a literal arrow in a string is fine; `&apos;`). No `any`.

- [ ] **Step 2: Pass `runId`** from `page.tsx` where `RecommendTable` is rendered:
  `<RecommendTable result={rec.result_jsonb} runId={rec.optimization_run_id} />`.

- [ ] **Step 3: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all clean; `/recommend` and `/runs/[runId]` present.

- [ ] **Step 4: Commit**

```bash
git add src/app/recommend/recommend-table.tsx src/app/recommend/page.tsx
git commit -m "feat(recommend): delta-view results (changes + capex + before/after) and what-if link"
```

---

### Task 7: Run page — gate fix card off for `what_if`, add banner

**Files:**
- Modify: `src/app/runs/[runId]/page.tsx`

- [ ] **Step 1: Gate the fix plan.** Change the `fixPlan` computation (line ~53) to skip what-if runs:

```ts
  const fixPlan =
    run.status === 'completed' && run.run_kind !== 'what_if'
      ? await loadFixPlan(supabase, run)
      : null;
```

- [ ] **Step 2: Add a what-if banner** near the top of the completed-run render (e.g. just after the title row / before the day content, mirroring the existing `run_kind === 'baseline'` badge at line ~64 and banner at line ~76):

```tsx
      {run.run_kind === 'what_if' && (
        <div className="rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          What-if preview of a recommended fleet — these crews aren&rsquo;t in your Crews table. Capacity here is the
          optimizer&rsquo;s estimate; create the crews to make it real.
        </div>
      )}
```

Also add a `what_if` badge beside the existing baseline badge (line ~64):
`{run.run_kind === 'what_if' && <Badge variant="secondary">what-if</Badge>}`.

The crew-meta chip is already null-safe (`crewMeta[id] && ...`), so synthetic crews
render name-only with no change.

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean; `/runs/[runId]` present.

- [ ] **Step 4: Commit**

```bash
git add "src/app/runs/[runId]/page.tsx"
git commit -m "feat(runs): suppress unassigned-fix card for what_if runs + preview banner"
```

---

### Final verification (after all tasks)

- [ ] `python3 solver/api/check_recommend_plan.py && python3 solver/api/check_recommend.py && python3 solver/api/check_chunking.py && python3 solver/api/check_grouping.py` — all PASS.
- [ ] `npm run test && npm run typecheck && npm run lint && npm run build` — green/clean.
- [ ] **Post-deploy manual gate** (after migration + solver redeploy + web push): run a
  recommendation on real data → verify St George/Dallas show ~1 crew (no 5-crew/21%
  output), a sane changes list + net capital, and that "View optimized schedule for
  this fleet →" opens a `what_if` run with day tabs/per-crew/map and no fix card.
