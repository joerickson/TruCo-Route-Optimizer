# Recommender Coverage + Clusters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the crew-mix recommender so it never (a) relocates crews between branches too far apart to be one commute cluster, (b) drains a branch below the crews needed to cover its own demand, or (c) reports "0 new crews / $0" while leaving routable work uncovered.

**Architecture:** Three changes, all in `solver/api/index.py`, validated by the pure check script `solver/api/check_recommend_plan.py` (no OR-Tools needed):
1. **Cluster gating** — derive commute clusters from branch coordinates (union-find on Haversine distance); `_plan_fleet_changes` only relocates a crew to a branch in the *same* cluster. This alone strands neither St George nor Dallas's local demand, because they are singleton clusters with no relocation target.
2. **Coverage floor** — a crew is only a relocation *source* if its home branch can still cover its attributed demand without it. `surplus_idle` is recomputed as "idle crews removable while keeping coverage" — so a branch's last needed crew is no longer mislabeled surplus.
3. **Coverage feedback loop** — `run_recommendation` replaces its single proposed-fleet validate with `_cover_residual`: after validating, buy a crew at the branch nearest each stranded property and re-validate, iterating until covered, budget-exhausted, or no improvement (genuinely un-routable). Crews bought in the loop are folded back into the plan's `changes`/`totals`/per-branch counts so the headline capital and "new crews" reflect them.

**Tech Stack:** Python 3, OR-Tools VRP (the `validate` solve, injected as a callable so loop logic is unit-testable without OR-Tools), Haversine util in `solver/api/distance_matrix.py`, pure assertion checks in `solver/api/check_recommend_plan.py`.

**Why these three together:** Bug #2 (St George/Dallas drained to 0 crews) *creates* part of Bug #1 (438 h "uncovered"): draining a branch doesn't move its demand, it strands it. Cluster gating + coverage floor stop the stranding; the feedback loop closes the remaining gap between the planner's aggregate-person-hours model and the real routing solve.

---

## File Structure

- `solver/api/index.py` — all production changes:
  - **New** `_branch_clusters(branches, radius_miles)` — pure, returns `{branch_id: cluster_root_id}`.
  - **New** tunable `_REC_CLUSTER_RADIUS_MILES`.
  - **Modify** `_plan_fleet_changes(...)` — add `clusters` param; gate relocations; add coverage-floor source filter; recompute `surplus_idle`.
  - **New** `_apply_extra_additions(plan, extra, branch_name, capex_usd)` — pure; folds loop-bought crews into an assembled plan dict.
  - **New** `_cover_residual(proposed_crews, by_branch, prop_labor, branch_name, validate, max_rounds)` — pure given an injected `validate`; returns `(result, extra_additions, proposed_crews, validate_count)`.
  - **Modify** `run_recommendation(...)` — compute clusters, pass to planner, replace single validate with `_cover_residual`, merge additions.
  - **Modify** import line — also import `ROAD_FACTOR` from `distance_matrix`.
- `solver/api/check_recommend_plan.py` — update the two relocation/rebalance fixtures (they encode the old "drain any idle crew" behavior) and add cluster + coverage-floor + merge-helper + loop cases.

---

## Task 1: Cluster derivation helper

**Files:**
- Modify: `solver/api/index.py` (add tunable near line 93; add function after `_attribute_to_branches`, ~line 328; extend the `distance_matrix` import)
- Test: `solver/api/check_recommend_plan.py`

- [ ] **Step 1: Extend the distance_matrix import**

Find the existing import of `haversine_miles` near the top of `solver/api/index.py` (it is imported from `distance_matrix`). Add `ROAD_FACTOR`:

```python
from distance_matrix import haversine_miles, ROAD_FACTOR, build_matrix, drive_miles
```

(Keep whatever names are already imported; only add `ROAD_FACTOR`. If `build_matrix`/`drive_miles` are not currently imported, do not add them.)

- [ ] **Step 2: Add the tunable**

After `_REC_DEFAULT_CREW_CAPEX_USD = 110_000.0` (line ~93):

```python
_REC_CLUSTER_RADIUS_MILES = 60.0  # branches within this road-distance are one commute cluster
```

- [ ] **Step 3: Write the failing test**

Add to `solver/api/check_recommend_plan.py` (after the existing imports, extend the import line and append a test block at the end before the final `print`):

```python
from index import _branch_clusters

# --- clusters: near branches merge, far branches stay singleton ---
_branches = [
    {"id": "slc", "lat": 40.7608, "lng": -111.8910},  # Salt Lake City
    {"id": "lin", "lat": 40.3416, "lng": -111.7144},  # Lindon (~30 mi from SLC)
    {"id": "stg", "lat": 37.0965, "lng": -113.5684},  # St George (~270 mi)
    {"id": "dal", "lat": 32.7767, "lng": -96.7970},   # Dallas (~1000+ mi)
    {"id": "nocoord"},                                 # no lat/lng -> singleton
]
_cl = _branch_clusters(_branches, 60.0)
assert _cl["slc"] == _cl["lin"], _cl                   # SLC + Lindon together
assert _cl["stg"] != _cl["slc"], _cl                   # St George alone
assert _cl["dal"] != _cl["slc"] and _cl["dal"] != _cl["stg"], _cl
assert _cl["nocoord"] == "nocoord", _cl                # ungeocoded -> own singleton
```

- [ ] **Step 4: Run test to verify it fails**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `ImportError: cannot import name '_branch_clusters'`

- [ ] **Step 5: Implement `_branch_clusters`**

Add after `_attribute_to_branches` (~line 328) in `solver/api/index.py`:

```python
def _branch_clusters(
    branches: list[dict[str, Any]], radius_miles: float = _REC_CLUSTER_RADIUS_MILES
) -> dict[str, str]:
    """Group branches into commute clusters by single-linkage road distance.

    Two geocoded branches whose Haversine x ROAD_FACTOR distance is <= radius_miles
    join the same cluster (transitive). Branches without coordinates are each their own
    singleton. Returns {branch_id: cluster_root_id}. Used to gate crew relocations: a crew
    may only relocate to a branch in its own cluster (you can't run St George's routes out
    of a Lindon depot 270 mi away).
    """
    parent = {b["id"]: b["id"] for b in branches}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    geo = [b for b in branches if b.get("lat") is not None and b.get("lng") is not None]
    for i in range(len(geo)):
        for j in range(i + 1, len(geo)):
            d = haversine_miles(
                float(geo[i]["lat"]), float(geo[i]["lng"]),
                float(geo[j]["lat"]), float(geo[j]["lng"]),
            ) * ROAD_FACTOR
            if d <= radius_miles:
                union(geo[i]["id"], geo[j]["id"])
    return {bid: find(bid) for bid in parent}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `check_recommend_plan: PASS`

- [ ] **Step 7: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend_plan.py
git commit -m "feat(solver): derive commute clusters from branch coordinates"
```

---

## Task 2: Gate relocations to the same cluster

**Files:**
- Modify: `solver/api/index.py` — `_plan_fleet_changes` signature + relocation source/target gates; `run_recommendation` call site
- Test: `solver/api/check_recommend_plan.py`

- [ ] **Step 1: Write the failing test**

Append to `check_recommend_plan.py`:

```python
# --- cluster gating: idle crew at a far singleton branch is NOT relocated to a loaded branch ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("b", "slc", 3), crew("idle", "stg", 3)]  # slc deficit, stg idle+far
clusters = {"slc": "slc", "stg": "stg"}  # different clusters
plan = _plan_fleet_changes(crews, by_branch, {"a": 52.0, "b": 52.0, "idle": 6.0}, BN, 110000,
                           clusters=clusters)
reloc = plan["changes"]["relocations"]
assert not any(r["to_branch_name"] == "SLC HQ" for r in reloc), reloc  # stg crew can't cross clusters
assert plan["branches"]["stg"]["crews_after"]["three"] == 1, plan["branches"]["stg"]  # stays at stg
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: FAIL — either `TypeError: _plan_fleet_changes() got an unexpected keyword argument 'clusters'`, or the assertion fails because the crew was relocated across clusters.

- [ ] **Step 3: Add the `clusters` parameter and `same_cluster` helper**

In `_plan_fleet_changes` (line 428), change the signature:

```python
def _plan_fleet_changes(
    current_crews: list[dict[str, Any]],
    by_branch: dict[str, list[dict[str, Any]]],
    util_by_crew: dict[str, float],
    branch_name: dict[str, str],
    capex_usd: float = _REC_DEFAULT_CREW_CAPEX_USD,
    clusters: dict[str, str] | None = None,
) -> dict[str, Any]:
```

Immediately after `moved_ids: set[str] = set()` (line 469), add:

```python
    cluster_of = clusters or {}

    def same_cluster(bid_a: str, bid_b: str) -> bool:
        # No cluster map (older callers / pure tests) => unrestricted (legacy behavior).
        if not cluster_of:
            return True
        return cluster_of.get(bid_a) == cluster_of.get(bid_b)
```

- [ ] **Step 4: Gate the Tier 1 and Tier 2 relocation targets**

In TIER 1 (line ~514), change the source filter:

```python
        while deficit(bid) > 0:
            srcs = [s for s in sources()
                    if s["home_branch_id"] != bid and same_cluster(s["home_branch_id"], bid)]
            if not srcs:
                break
            relocate(srcs[0], bid, "deficit")
```

In TIER 2 (line ~540), change the source pick:

```python
        for tb in targets:
            src = next((s for s in srcs
                        if s["home_branch_id"] != tb and same_cluster(s["home_branch_id"], tb)), None)
            if src is None:
                continue
            relocate(src, tb, "rebalance")
            moved = True
            break
```

- [ ] **Step 5: Pass clusters from the call site**

In `run_recommendation`, just before the `# 2) plan deltas` block (line ~935), compute clusters and pass them:

```python
        clusters = _branch_clusters(branches)
        # 2) plan deltas
        plan = _plan_fleet_changes(current_crews, by_branch, util_before, branch_name,
                                   capex_usd, clusters=clusters)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `check_recommend_plan: PASS` (all prior cases still pass — they pass no `clusters`, so `same_cluster` returns True and legacy behavior holds).

- [ ] **Step 7: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend_plan.py
git commit -m "feat(solver): gate crew relocations to the same commute cluster"
```

---

## Task 3: Coverage floor + honest surplus

**Files:**
- Modify: `solver/api/index.py` — `_plan_fleet_changes` `sources()` filter + `surplus` computation
- Test: `solver/api/check_recommend_plan.py` (rewrite two legacy fixtures, add one)

- [ ] **Step 1: Rewrite the two legacy fixtures that assume draining a branch's only crew**

These two existing cases encode the buggy "relocate any idle crew, even a branch's last one" behavior. Replace them so the source branch has a genuine *surplus* crew (relocation stays valid under the coverage floor).

Replace the **"relocate-first"** block (currently lines ~23-29):

```python
# --- relocate-first: short branch + a SURPLUS idle crew elsewhere (same cluster) -> relocate ($0) ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("s1", "stg", 3), crew("s2", "stg", 3)]  # stg has 2; 1 is spare
plan = _plan_fleet_changes(crews, by_branch, {"a": 60.0, "s1": 6.0, "s2": 6.0}, BN, 110000)
reloc = plan["changes"]["relocations"]
assert any(r["to_branch_name"] == "SLC HQ" and r["reason"] == "deficit" for r in reloc), reloc
assert plan["branches"]["stg"]["crews_after"]["three"] == 1, plan["branches"]["stg"]  # stg keeps 1 for its 10h
```

Replace the **"rebalance"** block (currently lines ~44-49):

```python
# --- rebalance: no deficit; a branch with a SURPLUS idle crew feeds a loaded same-cluster branch ---
by_branch = {"slc": props("slc", 90.0), "stg": props("stg", 5.0)}
crews = [crew("busy", "slc", 2), crew("s1", "stg", 2), crew("s2", "stg", 2)]  # stg has 2; 1 spare
plan = _plan_fleet_changes(crews, by_branch, {"busy": 58.0, "s1": 6.0, "s2": 6.0}, BN, 110000)
assert any(r["reason"] == "rebalance" and r["to_branch_name"] == "SLC HQ"
           for r in plan["changes"]["relocations"]), plan["changes"]
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["branches"]["stg"]["crews_after"]["two"] == 1, plan["branches"]["stg"]  # stg keeps 1 for its 5h
```

- [ ] **Step 2: Update the "no over-provisioning" fixture's surplus expectation**

The first fixture (currently lines ~15-21) has a single St George crew covering 78 h. Under the coverage floor that crew is **needed**, not surplus. Change its surplus assertion:

```python
# --- no over-provisioning: small branch, single crew is NEEDED for its 78h -> not surplus, no change ---
by_branch = {"stg": props("stg", 78.0)}                  # demand 78 < CAP2_TIGHT 93.5
plan = _plan_fleet_changes([crew("c1", "stg", 2)], by_branch, {"c1": 18.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["changes"]["upsizes"] == [] and plan["changes"]["additions"] == [], plan["changes"]
assert plan["changes"]["surplus_idle"] == [], plan["changes"]   # the lone crew is needed for 78h
```

- [ ] **Step 3: Add the coverage-floor + true-surplus test**

Append:

```python
# --- coverage floor: branch with 3 idle crews / 78h keeps 1, flags 2 as surplus; never drained to 0 ---
by_branch = {"stg": props("stg", 78.0)}
crews = [crew("c1", "stg", 2), crew("c2", "stg", 3), crew("c3", "stg", 3)]
clusters = {"stg": "stg"}  # singleton; nowhere to relocate
plan = _plan_fleet_changes(crews, by_branch, {"c1": 14.0, "c2": 14.0, "c3": 14.0}, BN, 110000,
                           clusters=clusters)
after = plan["branches"]["stg"]["crews_after"]
assert after["two"] + after["three"] == 3, after          # nobody relocated (singleton cluster)
assert plan["changes"]["surplus_idle"] == [{"branch_name": "St George", "count": 2}], plan["changes"]
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: FAIL — the coverage-floor case reports `surplus_idle` count 3 (old logic counts all idle sources) instead of 2, and/or the rewritten relocate/rebalance cases relocate the wrong crew.

- [ ] **Step 5: Add the coverage-floor filter to `sources()`**

In `_plan_fleet_changes`, add a `keeps_coverage` helper next to the other closures (after `est_avg`, ~line 467):

```python
    def keeps_coverage(c) -> bool:
        # Removing c must leave its home branch able to cover its own attributed demand.
        bid = c["home_branch_id"]
        return branch_cap(bid) - cap_of(c) >= demand.get(bid, 0.0)
```

Change `sources()` (line ~471) to require it:

```python
    def sources():  # idle, removable crews at non-short branches (not yet moved), biggest first then name
        out = [c for c in crews
               if is_idle(c) and deficit(c["home_branch_id"]) <= 0
               and c["id"] not in moved_ids and keeps_coverage(c)]
        out.sort(key=lambda c: (-cap_of(c), c.get("name", "")))
        return out
```

- [ ] **Step 6: Recompute `surplus_idle` as truly-removable idle crews**

Replace the surplus block (lines ~549-552) with:

```python
    # Surplus: idle crews a branch could shed while still covering its own demand, that
    # weren't relocated (no useful same-cluster target). These are honest downsize candidates;
    # a branch's last needed crew is NOT surplus.
    surplus: dict[str, int] = {}
    for bid in branch_ids:
        idle_here = [c for c in crews_at.get(bid, []) if is_idle(c)]
        if not idle_here:
            continue
        cap = branch_cap(bid)
        removable = 0
        for c in sorted(idle_here, key=cap_of):  # drop smallest first to maximize count kept honest
            if cap - cap_of(c) >= demand.get(bid, 0.0):
                cap -= cap_of(c)
                removable += 1
        if removable:
            surplus[bid] = removable
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `check_recommend_plan: PASS`

- [ ] **Step 8: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend_plan.py
git commit -m "feat(solver): coverage floor so a branch is never drained below its own demand"
```

---

## Task 4: Coverage feedback loop (pure, validate injected)

**Files:**
- Modify: `solver/api/index.py` — add `_apply_extra_additions` and `_cover_residual` (place after `_build_recommendation`, ~line 638)
- Test: `solver/api/check_recommend_plan.py`

- [ ] **Step 1: Write the failing test (merge helper + loop with a fake validate)**

Append to `check_recommend_plan.py`:

```python
from index import _apply_extra_additions, _cover_residual

# --- _apply_extra_additions folds loop-bought crews into an assembled plan ---
_plan = {
    "branches": {"slc": {"crews_before": {"two": 1, "three": 0},
                         "crews_after": {"two": 1, "three": 0},
                         "relocated_in": [], "upsized": 0, "added": {"two": 0, "three": 0}}},
    "changes": {"relocations": [], "upsizes": [], "additions": [], "surplus_idle": []},
    "totals": {"fleet_before": 1, "fleet_after": 1, "new_crews": 0,
               "capex_usd": 110000.0, "net_capital_usd": 0},
}
_apply_extra_additions(_plan, {"slc": {"two": 1, "three": 1}}, {"slc": "SLC HQ"}, 110000)
assert _plan["totals"]["new_crews"] == 2, _plan["totals"]
assert _plan["totals"]["net_capital_usd"] == 220000, _plan["totals"]
assert _plan["branches"]["slc"]["added"] == {"two": 1, "three": 1}, _plan["branches"]["slc"]
assert _plan["branches"]["slc"]["crews_after"] == {"two": 2, "three": 1}, _plan["branches"]["slc"]
assert {(a["size"], a["count"]) for a in _plan["changes"]["additions"]} == {(2, 1), (3, 1)}, _plan["changes"]

# --- _cover_residual buys crews near stranded props and stops when covered ---
_by_branch = {"slc": props("slc", 90.0) + props("slc", 50.0), "stg": props("stg", 40.0)}
# property ids produced by props(): slc-p0, slc-p1 (second props call also -> slc-p0!), so build explicit:
_by_branch = {"slc": [{"id": "slc-a", "est_labor_hours": 90.0}, {"id": "slc-b", "est_labor_hours": 50.0}],
              "stg": [{"id": "stg-a", "est_labor_hours": 40.0}]}
_prop_labor = {"slc-a": 90.0, "slc-b": 50.0, "stg-a": 40.0}
_calls = {"n": 0}
def _fake_validate(crews):
    # round 0: slc-b stranded; after >=1 bought crew at slc, everything covered.
    _calls["n"] += 1
    bought_at_slc = sum(1 for c in crews if str(c["id"]).startswith("rec-slc-"))
    unassigned = [] if bought_at_slc >= 1 else ["slc-b"]
    return {"crew_utilization": [], "unassigned_property_ids": unassigned}
result, extra, proposed, vcount = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _fake_validate, max_rounds=5)
assert result["unassigned_property_ids"] == [], result
assert extra.get("slc", {}).get("two", 0) >= 1, extra        # bought a 2p at slc (slc-b is < CAP2)
assert vcount >= 2, vcount                                    # initial validate + at least one re-validate

# --- _cover_residual stops (no infinite loop) when a stranded prop is genuinely un-routable ---
def _never_covers(crews):
    return {"crew_utilization": [], "unassigned_property_ids": ["slc-b"]}
result2, extra2, _, vcount2 = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _never_covers, max_rounds=5)
assert result2["unassigned_property_ids"] == ["slc-b"], result2  # surfaced as a true limit
assert vcount2 <= 3, vcount2                                     # bailed on no-improvement, not 5 rounds
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `ImportError: cannot import name '_apply_extra_additions'`

- [ ] **Step 3: Implement both helpers**

Add after `_build_recommendation` (~line 638) in `solver/api/index.py`:

```python
def _apply_extra_additions(
    plan: dict[str, Any],
    extra: dict[str, dict[str, int]],
    branch_name: dict[str, str],
    capex_usd: float,
) -> dict[str, Any]:
    """Fold crews bought during the coverage loop back into an assembled plan dict (in place):
    per-branch added/crews_after, changes.additions, and totals (new_crews/fleet_after/net_capital)."""
    total_new = 0
    for bid, sizes in extra.items():
        b = plan["branches"].setdefault(bid, {
            "crews_before": {"two": 0, "three": 0}, "crews_after": {"two": 0, "three": 0},
            "relocated_in": [], "upsized": 0, "added": {"two": 0, "three": 0},
        })
        for size_key, size in (("two", 2), ("three", 3)):
            n = sizes.get(size_key, 0)
            if not n:
                continue
            total_new += n
            b["added"][size_key] = b["added"].get(size_key, 0) + n
            b["crews_after"][size_key] = b["crews_after"].get(size_key, 0) + n
            label = branch_name.get(bid, bid)
            row = next((a for a in plan["changes"]["additions"]
                        if a["branch_name"] == label and a["size"] == size), None)
            if row:
                row["count"] += n
            else:
                plan["changes"]["additions"].append(
                    {"branch_name": label, "size": size, "count": n})
    if total_new:
        plan["totals"]["new_crews"] += total_new
        plan["totals"]["fleet_after"] += total_new
        plan["totals"]["net_capital_usd"] = int(plan["totals"]["new_crews"] * float(capex_usd))
    return plan


def _cover_residual(
    proposed_crews: list[dict[str, Any]],
    by_branch: dict[str, list[dict[str, Any]]],
    prop_labor: dict[str, float],
    branch_name: dict[str, str],
    validate,
    max_rounds: int = _REC_MAX_RUNS,
) -> tuple[dict[str, Any], dict[str, dict[str, int]], list[dict[str, Any]], int]:
    """Close the loop between the planner's aggregate model and the real routing solve.

    Validate the proposed fleet; for every routable-but-stranded property, buy a crew at the
    property's branch (3-person if any stranded property there exceeds CAP2, else 2-person) and
    re-validate. Stop when nothing is stranded, the round budget is spent, or a round fails to
    reduce the unassigned count (genuinely un-routable -> surfaced as a true limit). Returns
    (final_result, extra_additions_by_branch, proposed_crews_incl_bought, validate_count).
    """
    prop_branch = {p["id"]: bid for bid, props in by_branch.items() for p in props}
    crews = list(proposed_crews)
    extra: dict[str, dict[str, int]] = {}
    new_idx: dict[str, int] = {}
    validate_count = 0

    if not crews:
        return {"crew_utilization": [], "unassigned_property_ids": []}, extra, crews, 0

    result = validate(crews)
    validate_count += 1

    rounds = 0
    while rounds < max_rounds:
        unassigned = result.get("unassigned_property_ids", []) or []
        actionable = [pid for pid in unassigned if pid in prop_branch]
        if not actionable:
            break
        prev_count = len(unassigned)
        by_b: dict[str, list[str]] = {}
        for pid in actionable:
            by_b.setdefault(prop_branch[pid], []).append(pid)
        for bid, pids in by_b.items():
            big = any(prop_labor.get(pid, 0.0) > _REC_CAP2 for pid in pids)
            size = 3 if big else 2
            k = new_idx.get(bid, 0) + 1
            new_idx[bid] = k
            # offset index keeps these ids distinct from planner-bought rec crews
            crews.append(_make_rec_crew(bid, 900 + k, size, branch_name.get(bid, bid)))
            sk = "three" if size == 3 else "two"
            extra.setdefault(bid, {})
            extra[bid][sk] = extra[bid].get(sk, 0) + 1
        rounds += 1
        result = validate(crews)
        validate_count += 1
        if len(result.get("unassigned_property_ids", []) or []) >= prev_count:
            break  # no improvement => remaining stranded work is genuinely un-routable
    return result, extra, crews, validate_count
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 solver/api/check_recommend_plan.py`
Expected: `check_recommend_plan: PASS`

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py solver/api/check_recommend_plan.py
git commit -m "feat(solver): coverage feedback loop helpers (buy near stranded props, fold into plan)"
```

---

## Task 5: Wire the loop into run_recommendation

**Files:**
- Modify: `solver/api/index.py` — `run_recommendation` step 3 (lines ~947-951)
- Test: `solver/api/check_recommend.py` (the OR-Tools-backed check) — confirm no regression; manual smoke after deploy

- [ ] **Step 1: Replace the single validate with the coverage loop**

In `run_recommendation`, replace the step-3 block (lines ~947-951):

```python
        # 3) validate proposed fleet, then close the loop: buy crews near any routable-but-stranded
        #    property and re-validate until covered, budget-spent, or no improvement. Bought crews
        #    are folded back into the plan so capital/new-crew headlines reflect them.
        proposed = plan["proposed_crews"]
        if proposed:
            result, extra_adds, proposed, vcount = _cover_residual(
                proposed, by_branch, prop_labor, branch_name, validate)
            _apply_extra_additions(plan, extra_adds, branch_name, capex_usd)
        else:
            result, vcount = baseline, 0
        iterations = (1 if current_crews else 0) + vcount
```

(Remove the old `result = validate(proposed) if proposed else baseline` and `iterations = ...` lines this replaces.)

- [ ] **Step 2: Verify `proposed` still drives the what-if run + builder**

Confirm by reading the surrounding code that the what-if persistence block (lines ~955-976) uses `result` and `proposed`, and `_build_recommendation(plan, result, ..., proposed)` (line ~980) receives the post-loop `proposed`. No code change expected — the reassignment in Step 1 already updates `proposed`. The bought crews therefore appear in the what-if schedule's per-crew utilization and the recommendation's per-branch `crews_after`.

Run: `git diff solver/api/index.py | grep -n "proposed"` and eyeball that `proposed` is the loop's returned list everywhere downstream.

- [ ] **Step 3: Run the full pure check suite**

Run: `python3 solver/api/check_recommend_plan.py && python3 solver/api/check_recommend.py`
Expected: both print `PASS` (or `check_recommend.py` requires OR-Tools — if it imports `ortools` and OR-Tools is installed locally, it runs; if not, note it must pass in CI/deploy. Do not skip silently — report which ran).

- [ ] **Step 4: Run the JS test gate (no solver coupling, but confirms web types unaffected)**

Run: `npm run test 2>&1 | grep -E "Test Files|Tests"`
Expected: all pass (unchanged — this task touches only Python).

- [ ] **Step 5: Commit**

```bash
git add solver/api/index.py
git commit -m "feat(solver): run_recommendation closes the coverage loop before persisting the what-if"
```

---

## Deploy note (after merge)

No schema change — this is solver-only logic. Per the deploy workflow, **redeploy the solver project** before the web relies on the new recommendation shape (the shape is unchanged here, so web is unaffected, but the solver must redeploy for the new behavior). Then re-run a recommendation and confirm against the original bad output:
- St George keeps its crews (singleton cluster) and shows **2 surplus idle**, not 0 crews.
- Dallas keeps its crew (singleton cluster), not relocated to Lindon.
- `residual_unassigned` is **0** unless properties are genuinely un-routable; if non-zero, `new_crews`/`net_capital` are non-zero (the loop bought crews to try) — "0 new + uncovered" is now impossible.

---

## Self-Review

**Spec coverage** (the three agreed decisions):
- *Same-metro clusters* → Task 1 (derive) + Task 2 (gate). ✓
- *Close the loop* → Task 4 (`_cover_residual`) + Task 5 (wire in). ✓
- *Keep enough to cover demand* → Task 3 (coverage floor + honest surplus). ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every test step shows assertions. ✓

**Type consistency:**
- `_branch_clusters` returns `dict[str, str]` (branch_id → root id); consumed by `_plan_fleet_changes(clusters=...)` and `same_cluster`. ✓
- `_cover_residual` returns 4-tuple `(result, extra, proposed, validate_count)`; `run_recommendation` unpacks all four; `extra` shape `{bid: {"two"|"three": int}}` matches `_apply_extra_additions`'s expected `extra`. ✓
- `_apply_extra_additions` mutates the same `plan` dict shape produced by `_plan_fleet_changes` (keys `branches`/`changes`/`totals`, per-branch `added`/`crews_after`). ✓
- New rec-crew ids use offsets (`900+k`, and Task 4 test references `rec-slc-` prefix produced by `_make_rec_crew`) — distinct from planner ids. ✓

**Note on test rewrites:** Task 3 deliberately rewrites two pre-existing fixtures in `check_recommend_plan.py` because they assert the old (buggy) "drain a branch's only crew" behavior. This is intended — those expectations were wrong under the agreed coverage floor.
