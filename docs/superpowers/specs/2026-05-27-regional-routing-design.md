# Regional (Cluster-Partitioned) Routing — Design

**Status:** Approved 2026-05-27. Solver-only.

## Problem

`solve_day` routes **all crews and all properties in one region-blind VRP**. The planner already attributes each property to its nearest branch (`_attribute_to_branches`), but the router ignores that. To avoid dropping a far property (10M drop penalty), the optimizer assigns it to *any* crew — so a St George crew gets Spanish Fork/Provo (→ Lindon), plus Texas and Nevada. Observed: **Crew 24 (St George) at 281% util — 140 clock-h/wk, 100 h driving, 6,289 mi**, spanning UT→TX→NV. Removing the total-day cap earlier took away the last guardrail.

This is wrong by construction: Salt Lake, St George, Dallas, and Las Vegas are **separate operations**. A crew must only serve properties in its own region.

## Solution (two coordinated changes)

### 1. Partition routing by commute cluster
A property is served only by crews in **its own cluster**. Clusters are the existing `_branch_clusters(branches)` (≤60 road-mi, cumulative-distance) over the 5 branches → **Wasatch {SLC, Lindon}**, **St George**, **Dallas**, **Las Vegas**.

- **Property → cluster**: via its attributed branch (`_attribute_to_branches` → nearest active branch → that branch's cluster). Provo/Spanish Fork/Eagle Mountain attribute to Lindon → Wasatch. Cedar City/Hurricane/Washington → St George. Kaufman/Fort Worth → Dallas. Henderson → Las Vegas. Logan (no nearer branch) → SLC → Wasatch (a long but same-region haul, bounded by the cap below).
- **Crew → cluster**: via its `home_branch_id`'s cluster. St George crews (24/25/26) only serve the St George cluster → they can never be handed Spanish Fork or Texas again.
- Each cluster runs the **existing** per-weekday pipeline (bucketize → per-day VRP → cross-day rebalance) on its own crews + properties; results merge and aggregate once over all crews/properties.
- A cluster with properties but **no crews** → those properties are unassigned (honest). Unattributable (ungeocoded / no active branch) properties → unassigned, as today.

### 2. Total-day cap (backstop)
Re-introduce a per-crew **total (work + drive) cap** alongside the existing work cap: work ≤ `max_clock_hours_per_day` (10h) AND work + drive ≤ `max_clock_hours_per_day + _DRIVE_ALLOWANCE_HOURS`. With `_DRIVE_ALLOWANCE_HOURS = 2.0` a standard crew is bounded at **12h total/day**. Per-cluster routing already keeps drives local; this guarantees no pathological day even within a spread-out cluster (e.g. southern Utah). A property that cannot fit any crew-day within the cap surfaces as unassigned (a true geographic limit), consistent with prior decisions.

## File-by-file

- **`solver/api/solver_logic.py` — `solve_day`**: add a second capacity dimension. Keep the "Work" dimension (`service//size`, cap = `max_clock_hours×3600`). Add a "Total" dimension using the existing cost transit (`service//size + drive`), capped per vehicle at `(max_clock_hours + _DRIVE_ALLOWANCE_HOURS)×3600`. Arc cost unchanged. (`_DRIVE_ALLOWANCE_HOURS` lives in `solver_logic.py`.)
- **`solver/api/index.py` — extract `_optimize_subset(crews, properties, branches_by_id, time_limit_seconds) -> (all_routes, unassigned_chunk_ids)`**: the current body of `run_optimization` from `_properties_for_solver` through the cross-day rebalance loop, operating on the given crew/property subset.
- **`solver/api/index.py` — `run_optimization`**: compute `clusters = _branch_clusters(branches)`; `by_branch, unattributable = _attribute_to_branches(properties, branches)`; group properties by `clusters[branch_id]` and crews by `clusters[home_branch_id]`; call `_optimize_subset` per cluster; merge routes + unassigned (seed unassigned with `unattributable`); a cluster with no crews contributes its property ids to unassigned; `_aggregate_result(crews, all_routes, unassigned, properties, elapsed)` over the FULL crew/property lists (so idle crews still report 0% and all properties are accounted).
- **`run_evaluation` unchanged**: it scores a fixed schedule per (day, crew) already — no global VRP, so no cross-region issue.
- **`run_recommendation` unchanged**: its `validate` calls `run_optimization`, so it inherits regional routing automatically. (The over-crewing this exposes at St George — real local demand ~69h vs 3 crews — is handled later by the parked disband/redeploy + cluster-sizing work, not here.)

## Tests

Pure (no OR-Tools) — `check_recommend_plan.py` already covers `_branch_clusters`. New OR-Tools checks in `check_solve_day.py` (runs locally; ortools installed):

1. **Regional isolation**: two branches in different clusters, each with one crew; a property near branch A is NOT assigned to branch B's crew even when B's crew is idle and A's is busy — it's served by A's crew or unassigned, never B's.
2. **No-crew cluster**: a cluster with properties but no crew → those properties unassigned (not stolen by another cluster's crew).
3. **Total-day cap**: a single crew + a property reachable but whose work+drive would exceed `max_clock + 2h` → unassigned (work-only would have allowed it); and a property within the cap → assigned.
4. **Within-cluster pooling**: SLC + Lindon (same cluster), a Lindon-area property is servable by either; with Lindon's crew full it can go to the SLC crew (same cluster) — confirms pooling still works.
5. Existing `check_solve_day` work-cap cases still pass (work cap unchanged).

## Out of scope (follow-ups, already in backlog)

- Cluster-level capacity *sizing* in the recommender (so the Wasatch cluster doesn't over-buy at Lindon when SLC has slack) — the cluster-rebalance relocate lever.
- Disband + redeploy surplus assets (St George over-crewing this will expose).
- Branch filter on schedule views; actual-hours upload.

## Verification

`check_solve_day.py`, `check_recommend.py`, `check_recommend_plan.py`, `check_chunking.py`, `check_distance.py` all PASS; then a real-data run confirms Crew 24-style cross-region routes are gone (St George crews only serve southern Utah; no UT→TX/NV).
