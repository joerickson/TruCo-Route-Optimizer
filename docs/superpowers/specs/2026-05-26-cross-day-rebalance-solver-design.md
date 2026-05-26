# Cross-Day Capacity-Aware Split + Iterative Rebalance — Design Spec

**Date:** 2026-05-26
**Status:** Approved (design)
**Scope:** Stop the optimizer from dropping properties onto an overloaded day when
another day had spare capacity. Make the initial day-assignment capacity-aware, and
add a bounded post-solve rebalance that moves unassigned chunks to days with room
and re-solves them.

## 1. Problem

`run_optimization` runs **one independent VRP per weekday**. Before solving, the
greedy `_bucketize_properties` assigns each work-chunk to exactly one day by
balancing **labor only** (least-loaded day). If that split overloads a day relative
to that day's crew capacity, `solve_day` drops the overflow to `unassigned` — even
when another weekday had spare capacity. Days never rebalance against each other,
so a property can be unassigned because of *how days were split*, not because the
fleet is actually full. This is the dominant source of **avoidable** unassigned
work now that big properties can split into chunks.

### Out of scope
- Joint multi-day VRP (vehicles = crew×weekday). Considered and rejected: a
  ~150-vehicle / ~600-node model risks worse routes than per-day solves within the
  time budget, and is a much bigger rewrite. Revisit only if B proves insufficient.
- **Cross-day "same crew finishes all of a property's chunks" preference (deferred).**
  Requested, but **not expressible in the per-day decomposition**: crew assignment
  happens inside each independent day-solve, and no soft constraint spans separate
  solves. Within a day, the cost model already favors one crew doing a property's
  co-located chunks (splitting them makes a second crew drive to the same spot — pure
  extra cost), so the same-day case is effectively handled. Honoring it **across
  days** requires the joint multi-day model (C), where `AddSoftSameVehicleConstraint`
  over a property's chunk nodes would express it. Decision (2026-05-26): ship this
  per-day rebalance for completeness now; revisit C for cross-day same-crew after
  seeing how much it matters on real runs.
- Changing `solve_day`, `_extract_routes`, `_aggregate_result`, `_properties_for_solver`,
  or `run_evaluation`. Rebalance is **optimize-mode only**; baseline/evaluate scoring
  keeps its fixed-assignment behavior untouched.
- Crew-size or chunking changes (already shipped).

## 2. Current state

- `run_optimization` (`solver/api/index.py`): `_properties_for_solver(properties, crews)`
  → chunks; `_bucketize_properties(chunks, crews)` → `{day: chunks}` (sticky
  single-chunk to `assigned_day_of_week`, free chunks balanced by labor); then per
  day `solve_day(day, chunks, _crews_for_day(crews, branches_by_id, day))` →
  `{routes, unassigned}`; `_aggregate_result(...)`.
- `_crews_for_day` already encodes crew eligibility for a day: the crew's
  `works_<day>` flag is set **and** its `home_branch_id` resolves to a geocoded
  branch.
- Runtime budget (confirmed): a few minutes per optimization is acceptable on
  Coolify (the solver does all work then writes back within one request; the web
  polls Supabase). The old ~60s Vercel edge-proxy limit no longer binds.

## 3. Design (approach B)

Three pieces, all in `solver/api/index.py`. `solve_day` is reused unchanged.

### 3.1 Per-day capacity — `_day_capacities` (pure)

```python
def _day_capacities(
    crews: list[dict[str, Any]],
    branches_by_id: dict[str, dict[str, Any]],
    headroom: float = 0.85,
) -> dict[int, float]:
    """Usable person-hours each weekday can absorb.

    For each weekday 1..5: sum (crew_size * max_clock_hours_per_day) over crews
    that work that day AND have a geocoded home branch (same eligibility as
    _crews_for_day), times `headroom` to leave room for drive time so we don't
    pack a day to 100% labor and then have travel tip it into drops.
    """
```

`headroom` (default 0.85) is a named module constant `_DAY_CAPACITY_HEADROOM`.

### 3.2 Capacity-aware initial split (`_bucketize_properties`)

Signature gains the capacities: `_bucketize_properties(properties, crews, day_caps)`
(`run_optimization` computes `day_caps = _day_capacities(crews, branches_by_id)` and
passes it). Behavior:

- **Sticky unchanged:** a single-chunk property (`chunk_count == 1`) with
  `assigned_day_of_week` in `work_days` still goes to that day (honor current
  schedule). Sticky chunks consume their day's capacity.
- **Free chunks (everything else):** first-fit-decreasing bin-packing —
  1. start each day's remaining-spare at `day_caps[d]` minus the labor of sticky
     chunks already placed there;
  2. sort free chunks by `labor_hours` descending;
  3. place each chunk on the work-day with the **most remaining spare that still
     fits it** (`spare[d] >= labor`); decrement that day's spare;
  4. if no day can fit it, place it on the max-spare day anyway (it will surface as
     unassigned and be handled by the rebalance loop / reported).

This replaces today's "assign to least-loaded day" with capacity-respecting packing,
which removes most overflow drops up front.

### 3.3 Bounded iterative rebalance (`run_optimization`)

Named constants: `_MAX_REBALANCE_ROUNDS = 3`, `_REBALANCE_TIME_CAP_SECONDS = 240`.

```
day_caps = _day_capacities(crews, branches_by_id)
buckets  = _bucketize_properties(solver_props, crews, day_caps)     # {day: [chunk]}
chunk_by_id = {c["id"]: c for day's chunks ...}
work_days = sorted(buckets)

# Solve every non-empty day once.
routes_by_day, unassigned_by_day = _solve_days(work_days, buckets, crews, branches_by_id)

tried: dict[str, set[int]] = {}   # chunk_id -> days already attempted
for _round in range(_MAX_REBALANCE_ROUNDS):
    unassigned_ids = [cid for d in work_days for cid in unassigned_by_day[d]]
    if not unassigned_ids or (time.time() - started) > _REBALANCE_TIME_CAP_SECONDS:
        break
    # spare per day from chunk labor actually placed (bucket labor minus that day's unassigned)
    spare = {d: day_caps[d] - _assigned_labor(buckets[d], unassigned_by_day[d]) for d in work_days}
    dirty: set[int] = set()
    for cid in sorted(unassigned_ids, key=lambda c: chunk_by_id[c]["labor_hours"], reverse=True):
        chunk = chunk_by_id[cid]
        cur_day = _day_of(buckets, cid)
        target = _pick_rebalance_day(chunk["labor_hours"], spare, work_days, cur_day, tried.get(cid, set()))
        if target is None:
            continue
        buckets[cur_day].remove(chunk); buckets[target].append(chunk)
        spare[target] -= chunk["labor_hours"]
        tried.setdefault(cid, set()).add(target)
        dirty.add(cur_day); dirty.add(target)
    if not dirty:
        break
    # Re-solve only changed days; replace their routes + unassigned.
    re_routes, re_unassigned = _solve_days(sorted(dirty), buckets, crews, branches_by_id)
    routes_by_day.update(re_routes)
    unassigned_by_day.update(re_unassigned)

all_routes = [r for d in work_days for r in routes_by_day[d]]
unassigned = [cid for d in work_days for cid in unassigned_by_day[d]]
return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)
```

Supporting pure helpers (testable without OR-Tools):
- `_assigned_labor(day_chunks, day_unassigned_ids) -> float` — sum `labor_hours` of
  the day's chunks not in its unassigned set.
- `_pick_rebalance_day(labor, spare, work_days, current_day, tried_days) -> int | None`
  — the work-day with the most spare that fits `labor`, excluding `current_day` and
  any day already tried for this chunk; `None` if none qualifies.
- `_day_of(buckets, chunk_id) -> int` — which bucket currently holds the chunk.

`_solve_days(days, buckets, crews, branches_by_id)` is a thin wrapper: for each day
with chunks and eligible crews it calls `solve_day` (else marks all that day's
chunks unassigned), returning `({day: routes}, {day: unassigned_ids})`. It
encapsulates the per-day loop that `run_optimization` does today.

### 3.4 Why it's safe / monotonic

Rebalance only **moves an unassigned chunk to a day with computed spare** and
re-solves the source + target days. Adding one chunk to a day with room does not
evict that day's already-placed chunks; worst case the moved chunk still doesn't fit
(drive-heavy) and stays unassigned. The `tried` set prevents re-attempting the same
day for the same chunk, so the loop terminates. Net assigned count is therefore
**≥ today's** — no regression path.

## 4. Files

- `solver/api/index.py` — add `_day_capacities`, `_assigned_labor`,
  `_pick_rebalance_day`, `_day_of`, `_solve_days`; rewrite `_bucketize_properties`
  free-chunk placement (new `day_caps` param); rewrite `run_optimization` body to
  the rebalance loop. `run_evaluation` and all other functions unchanged.
- `solver/api/check_chunking.py` — extend with assertions for the new pure helpers.
- No `solver_logic.py` change, no web change, no DB/schema change, no migration.

## 5. Testing

Pure Python checks (no OR-Tools, run locally via `check_chunking.py`):
- `_day_capacities`: sums `crew_size × max_day × headroom` only over crews that work
  the day and have a geocoded branch; a crew with no branch or not working a day
  contributes 0; headroom applied.
- `_bucketize_properties` capacity-aware split: a set of free chunks whose total
  exceeds one day's cap spreads across days respecting caps; largest-first ordering;
  sticky single-chunk still honored; when total demand exceeds all capacity, the
  excess lands somewhere (not lost from buckets — every chunk is in exactly one day).
- `_pick_rebalance_day`: returns the max-spare fitting day, excludes current + tried,
  returns None when nothing fits.
- `_assigned_labor`: sums non-unassigned chunk labor.

The rebalance loop (which calls `solve_day`) and end-to-end routing quality are
verified **post-deploy** (no local OR-Tools), via a fresh optimization: confirm that
properties previously unassigned-with-idle-crews now route, and that anything still
unassigned coincides with a genuinely full fleet (per-day spare near zero).

## 6. Risks / notes

- **Labor-only capacity model.** Spare is computed from person-hours with a headroom
  fudge for drive time; a day can still drop a drive-heavy chunk the heuristic
  thought fit. Handled gracefully — it stays unassigned and is reported. Tune
  `_DAY_CAPACITY_HEADROOM` if drops cluster on geographically spread days.
- **Time budget.** Worst case ≈ initial all-days (~40s) + `_MAX_REBALANCE_ROUNDS` ×
  (re-solved days × 8s). Bounded by `_REBALANCE_TIME_CAP_SECONDS` (240s) checked each
  round. Comfortably within "a few minutes."
- **Determinism / churn.** Re-solving a day after adding a chunk produces new routes
  / arrival times for that day; expected.
- **No regression for runs that already fully assign:** with nothing unassigned the
  loop exits immediately after the first solve; the only behavior change then is the
  capacity-aware initial split (which still produces a valid full assignment).
- **OR-Tools not installed locally** — same constraint as prior solver work; the
  loop/`solve_day` integration is a post-deploy gate, the pure helpers are checked
  locally.
