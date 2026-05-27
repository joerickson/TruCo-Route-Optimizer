"""Vercel Python serverless function: POST /api/index

Note on filename: Vercel's @vercel/python@6 auto-detector only recognizes
entrypoints named app.py / index.py / server.py / main.py / wsgi.py /
asgi.py. We use index.py with a BaseHTTPRequestHandler `handler` class —
this is an accepted top-level name per Vercel docs.

Body (from Next.js server action):
  {
    "run_id": "uuid",
    "crews": [...],
    "branches": [...],
    "properties": [...]
  }

Behavior:
  1. For each weekday (Mon-Fri), select active crews + properties whose service is due.
  2. Distribute properties across days using a soft same-day preference (assigned_day_of_week).
  3. Run OR-Tools VRP per day.
  4. Aggregate results and write back to optimization_runs row in Supabase.

Vercel Python uses the BaseHTTPRequestHandler-style handler convention.
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable

# @vercel/python doesn't add the entrypoint's directory to sys.path, so sibling
# .py files in api/ can't be imported by name without this. Without it,
# `from solver_logic import ...` raises ModuleNotFoundError at runtime.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from distance_matrix import haversine_miles, ROAD_FACTOR

# Diagnostic: capture import failures so the GET health check can report them
# instead of the function silently 500ing on invocation.
_IMPORT_ERRORS: list[str] = []

try:
    from solver_logic import solve_day
except Exception as e:
    solve_day = None  # type: ignore
    _IMPORT_ERRORS.append(f"solver_logic: {type(e).__name__}: {e}")

try:
    import ortools  # noqa: F401
    _ortools_version = getattr(ortools, '__version__', 'unknown')
except Exception as e:
    _ortools_version = f"IMPORT FAILED: {type(e).__name__}: {e}"
    _IMPORT_ERRORS.append(f"ortools: {type(e).__name__}: {e}")


WEEKDAY_FIELDS = {
    1: "works_monday",
    2: "works_tuesday",
    3: "works_wednesday",
    4: "works_thursday",
    5: "works_friday",
    6: "works_saturday",
    7: "works_sunday",
}


# Cross-day rebalance tunables.
_DAY_CAPACITY_HEADROOM = 0.85  # leave ~15% of a day's labor capacity for drive time
_MAX_REBALANCE_ROUNDS = 3
_REBALANCE_TIME_CAP_SECONDS = 240

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
_REC_TIGHT_CLOCK_PER_WEEK = 55.0   # add-trigger ceiling (deferred-capex "tight" band)
_REC_CAP2_TIGHT = _REC_USABLE_FRACTION * _REC_TIGHT_CLOCK_PER_WEEK * 2  # ~93.5
_REC_CAP3_TIGHT = _REC_USABLE_FRACTION * _REC_TIGHT_CLOCK_PER_WEEK * 3  # ~140.25
_REC_DEFAULT_CREW_CAPEX_USD = 110_000.0
_REC_CLUSTER_RADIUS_MILES = 60.0  # branches within this road-distance are one commute cluster
# Crews bought by the coverage loop use this id offset so they never collide with planner-bought
# rec crews (those start at k=1; the planner buys at most demand/_REC_CAP2 per branch, far below 900).
_REC_LOOP_CREW_ID_OFFSET = 900


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
      rebalanced). solve_day does the real routing within a day.
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


def _crews_for_day(crews: list[dict[str, Any]], branches_by_id: dict[str, dict[str, Any]], day: int) -> list[dict[str, Any]]:
    field = WEEKDAY_FIELDS[day]
    out: list[dict[str, Any]] = []
    for c in crews:
        if not c.get(field):
            continue
        branch = branches_by_id.get(c["home_branch_id"])
        if not branch:
            continue
        out.append(
            {
                "id": c["id"],
                "name": c["name"],
                "branch_id": branch["id"],
                "branch_lat": branch["lat"],
                "branch_lng": branch["lng"],
                "max_clock_hours": float(c.get("max_clock_hours_per_day") or 8),
                "crew_size": int(c.get("crew_size") or 2),
            }
        )
    return out


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
    eps = 5e-5  # below the 4-dp rounding resolution; ignore dust remainders
    while remaining > eps:
        take = round(min(shift, remaining), 4)
        if take <= 0:
            break
        chunks.append(take)
        remaining -= take
    return chunks


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


def _branch_clusters(
    branches: list[dict[str, Any]], radius_miles: float = _REC_CLUSTER_RADIUS_MILES
) -> dict[str, str]:
    """Group branches into commute clusters by single-linkage road distance.

    Two geocoded branches whose Haversine x ROAD_FACTOR distance is <= radius_miles
    join the same cluster (transitive). Branches without coordinates are each their own
    singleton. Returns {branch_id: root_id} where root_id is an arbitrary but stable
    member of the cluster — it is NOT a meaningful "main branch" label; test cluster
    membership by equality of two branches' values, don't display the root. Used to gate
    crew relocations: a crew may only relocate to a branch in its own cluster (you can't
    run St George's routes out of a Lindon depot 270 mi away).
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


def _plan_fleet_changes(
    current_crews: list[dict[str, Any]],
    by_branch: dict[str, list[dict[str, Any]]],
    util_by_crew: dict[str, float],
    branch_name: dict[str, str],
    capex_usd: float = _REC_DEFAULT_CREW_CAPEX_USD,
    clusters: dict[str, str] | None = None,
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
    # baseline_clock is intentionally static (computed once from the baseline run before any
    # planner mutations).  The stale value is acceptable for this planning estimate; it is
    # load-bearing for Tier-2 termination — if we recomputed it the loop could diverge.
    def est_avg(bid):
        n = len(crews_at.get(bid, []))
        return baseline_clock.get(bid, 0.0) / n if n else 0.0

    def keeps_coverage(c) -> bool:
        # Removing c must leave its home branch able to cover its own attributed demand.
        bid = c["home_branch_id"]
        return branch_cap(bid) - cap_of(c) >= demand.get(bid, 0.0)

    moved_ids: set[str] = set()

    cluster_of = clusters or {}

    def same_cluster(bid_a: str, bid_b: str) -> bool:
        # No cluster map (older callers / pure tests) => unrestricted (legacy behavior).
        if not cluster_of:
            return True
        ca, cb = cluster_of.get(bid_a), cluster_of.get(bid_b)
        # An unmapped branch is its own singleton: never same-cluster as anything (avoids
        # None == None treating two unknown branches as relocatable).
        return ca is not None and ca == cb

    def sources():  # idle, removable crews at non-short branches (not yet moved), biggest first then name
        out = [c for c in crews
               if is_idle(c) and deficit(c["home_branch_id"]) <= 0
               and c["id"] not in moved_ids and keeps_coverage(c)]
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
        moved_ids.add(c["id"])
        relocations.append({
            "crew_name": c.get("name", c["id"]),
            "from_branch_name": branch_name.get(frm, frm),
            "to_branch_name": branch_name.get(to_bid, to_bid),
            "to_branch_id": to_bid,
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
            srcs = [s for s in sources()
                    if s["home_branch_id"] != bid and same_cluster(s["home_branch_id"], bid)]
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
            key=lambda b: (-est_avg(b), b),
        )
        moved = False
        for tb in targets:
            src = next((s for s in srcs
                        if s["home_branch_id"] != tb and same_cluster(s["home_branch_id"], tb)), None)
            if src is None:
                continue
            relocate(src, tb, "rebalance")
            moved = True
            break
        if not moved:
            break

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
        for c in sorted(idle_here, key=cap_of):  # drop smallest first to maximize removable (surplus) count
            if cap - cap_of(c) >= demand.get(bid, 0.0):
                cap -= cap_of(c)
                removable += 1
        if removable:
            surplus[bid] = removable

    # --- assemble output ---
    def counts(crew_list):
        return {"two": sum(1 for c in crew_list if c["crew_size"] == 2),
                "three": sum(1 for c in crew_list if c["crew_size"] == 3)}

    before_at: dict[str, list[dict[str, Any]]] = {}
    for c in current_crews:
        before_at.setdefault(c["home_branch_id"], []).append(c)

    branches_out: dict[str, Any] = {}
    for bid in branch_ids:
        relocated_in = [r["crew_name"] for r in relocations if r["to_branch_id"] == bid]
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


def _apply_extra_additions(
    plan: dict[str, Any],
    extra: dict[str, dict[str, int]],
    branch_name: dict[str, str],
    capex_usd: float,
) -> dict[str, Any]:
    """Fold crews bought during the coverage loop back into an assembled plan dict (in place):
    per-branch added/crews_after, changes.additions, and totals (new_crews/fleet_after/net_capital).

    Call once per plan with the full set of loop-bought crews. NOT idempotent: calling twice with
    the same `extra` double-counts new_crews and corrupts net_capital."""
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
    validate: Callable[[list[dict[str, Any]]], dict[str, Any]],
    max_rounds: int = _REC_MAX_RUNS,
) -> tuple[dict[str, Any], dict[str, dict[str, int]], list[dict[str, Any]], int]:
    """Close the loop between the planner's aggregate model and the real routing solve.

    Validate the proposed fleet, then probe PER BRANCH: each round, buy ONE crew at every branch
    that still has a stranded, attributable property and isn't already exhausted; re-validate; keep
    a probe only if it reduced THAT branch's own stranded count, otherwise roll it back and stop
    buying there. This prevents over-buying at a branch whose remaining properties are un-routable
    (e.g. beyond daily drive range): such work is surfaced as a true geographic/capacity limit
    instead of being chased with crews that never help. Termination is therefore decided per branch,
    not on the global unassigned count (a branch whose work can't be reduced no longer drags crews
    in just because some OTHER branch is still improving). Returns
    (final_result, extra_additions_by_branch, proposed_crews_incl_bought, validate_count).
    """
    prop_branch = {p["id"]: bid for bid, props in by_branch.items() for p in props}
    crews = list(proposed_crews)
    extra: dict[str, dict[str, int]] = {}
    new_idx: dict[str, int] = {}
    validate_count = 0

    if not crews:
        return {"crew_utilization": [], "unassigned_property_ids": []}, extra, crews, 0

    def stranded_by_branch(res: dict[str, Any]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for pid in (res.get("unassigned_property_ids", []) or []):
            bid = prop_branch.get(pid)  # ignore unattributable (orphan) properties
            if bid is not None:
                counts[bid] = counts.get(bid, 0) + 1
        return counts

    result = validate(crews)
    validate_count += 1

    exhausted: set[str] = set()
    rounds = 0
    while rounds < max_rounds:
        before = stranded_by_branch(result)
        targets = [bid for bid, n in before.items() if n > 0 and bid not in exhausted]
        if not targets:
            break
        unassigned = result.get("unassigned_property_ids", []) or []
        probes: dict[str, tuple[str, int]] = {}  # branch_id -> (probe crew id, size) bought this round
        for bid in targets:
            pids = [pid for pid in unassigned if prop_branch.get(pid) == bid]
            size = 3 if any(prop_labor.get(pid, 0.0) > _REC_CAP2 for pid in pids) else 2
            k = new_idx.get(bid, 0) + 1
            new_idx[bid] = k
            # offset index keeps these ids distinct from planner-bought rec crews
            crew = _make_rec_crew(bid, _REC_LOOP_CREW_ID_OFFSET + k, size, branch_name.get(bid, bid))
            crews.append(crew)
            probes[bid] = (crew["id"], size)
        rounds += 1
        result = validate(crews)
        validate_count += 1
        after = stranded_by_branch(result)
        rolled_back = False
        for bid, (cid, size) in probes.items():
            if after.get(bid, 0) < before.get(bid, 0):
                # the probe reduced this branch's stranded work -> keep it; branch stays active
                sk = "three" if size == 3 else "two"
                extra.setdefault(bid, {})
                extra[bid][sk] = extra[bid].get(sk, 0) + 1
            else:
                # no improvement at this branch -> its remaining work is un-routable; undo + stop here
                crews = [c for c in crews if c["id"] != cid]
                exhausted.add(bid)
                rolled_back = True
        if rolled_back:
            # reconcile the result with the cleaned fleet so the returned result matches `crews`
            result = validate(crews)
            validate_count += 1
    return result, extra, crews, validate_count


def _classify_capacity(avg_clock_per_crew: float) -> tuple[str, str]:
    if avg_clock_per_crew < 40:
        return (
            "over_provisioned",
            f"Crews averaging only {avg_clock_per_crew:.0f} clock-hours/week. Could run with fewer crews.",
        )
    if avg_clock_per_crew <= 50:
        return (
            "sufficient",
            f"Crews averaging {avg_clock_per_crew:.0f} clock-hours/week — sustainable.",
        )
    if avg_clock_per_crew <= 55:
        return (
            "tight_but_feasible",
            f"Crews averaging {avg_clock_per_crew:.0f} clock-hours/week — sustainable but no margin for weather or sick days.",
        )
    if avg_clock_per_crew <= 60:
        return (
            "add_crew_recommended",
            f"Crews averaging {avg_clock_per_crew:.0f} clock-hours/week — adding 1-2 crews recommended.",
        )
    return (
        "add_crew_required",
        f"Crews averaging {avg_clock_per_crew:.0f} clock-hours/week — unsustainable. Add 2+ crews.",
    )


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
            "_prop_ids": set(),
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
        t["_prop_ids"].update(s["property_id"] for s in r["stops"])

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

    total_clock = sum(c["clock_hours"] for c in crew_utilization)
    total_drive = sum(c["drive_hours"] for c in crew_utilization)
    total_miles = sum(c["drive_miles"] for c in crew_utilization)
    # NB: raw properties (person-hours). Do NOT pass solver_props — those are chunks (labor_hours), not whole-property est_labor_hours.
    total_labor_persons = sum(float(p["est_labor_hours"]) for p in properties)

    n_active_crews = sum(1 for c in crew_utilization if c["clock_hours"] > 0)
    avg_clock_per_crew = total_clock / max(1, n_active_crews)
    rec_code, rec_text = _classify_capacity(avg_clock_per_crew)

    # `unassigned` holds chunk ids ("propId" or "propId#k"); a property is unassigned
    # if ANY of its chunks is. Map back to distinct property ids.
    unassigned_property_ids = sorted({str(cid).rsplit("#", 1)[0] for cid in unassigned})

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
        "unassigned_property_ids": unassigned_property_ids,
    }


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


# Sentinel max-clock for evaluate mode: removes capacity as a reason to drop a
# stop, so an overloaded crew is scored at its true hours instead of shedding
# work. (A stop can still land in `unassigned` if it's genuinely infeasible to
# route — solve_day keeps a finite drop penalty — but that won't happen for the
# geocoded, single-crew groups evaluate mode builds.)
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
    solver_props = _properties_for_solver(properties, crews)
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
            "max_clock_hours": _EVAL_MAX_CLOCK_HOURS,  # relaxed: no capacity-based drops
            "crew_size": int(crew.get("crew_size") or 2),
        }]
        result = solve_day(day, props_for_group, crew_for_day, time_limit_seconds=8)
        all_routes.extend(result["routes"])
        unassigned.extend(result.get("unassigned", []))

    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)


def _solve_days(
    days: list[int],
    buckets: dict[int, list[dict[str, Any]]],
    crews: list[dict[str, Any]],
    branches_by_id: dict[str, dict[str, Any]],
    time_limit_seconds: int = 8,
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
        result = solve_day(day, chunks, crews_today, time_limit_seconds=time_limit_seconds)
        routes_by_day[day] = result["routes"]
        unassigned_by_day[day] = result.get("unassigned", [])
    return routes_by_day, unassigned_by_day


def _optimize_subset(
    crews: list[dict[str, Any]],
    properties: list[dict[str, Any]],
    branches_by_id: dict[str, dict[str, Any]],
    time_limit_seconds: int = 8,
    started: float | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run the per-weekday VRP + cross-day rebalance for ONE crew/property set (a commute
    cluster). Returns (all_routes, unassigned_chunk_ids). With no crews, every geocoded
    property's chunks are unassigned (nobody to serve this cluster). `started` lets the caller
    share one rebalance time-budget across all clusters (defaults to this call's start)."""
    if started is None:
        started = time.time()
    solver_props = _properties_for_solver(properties, crews)
    if not solver_props:
        return [], []
    if not crews:
        return [], [c["id"] for c in solver_props]

    day_caps = _day_capacities(crews, branches_by_id)
    buckets = _bucketize_properties(solver_props, crews, day_caps)
    work_days = sorted(buckets.keys())
    chunk_by_id = {c["id"]: c for c in solver_props}

    # Initial solve of every day.
    routes_by_day, unassigned_by_day = _solve_days(work_days, buckets, crews, branches_by_id, time_limit_seconds=time_limit_seconds)

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
        re_routes, re_unassigned = _solve_days(sorted(dirty), buckets, crews, branches_by_id, time_limit_seconds=time_limit_seconds)
        routes_by_day.update(re_routes)
        unassigned_by_day.update(re_unassigned)

    all_routes = [r for d in work_days for r in routes_by_day[d]]
    unassigned = [cid for d in work_days for cid in unassigned_by_day[d]]
    return all_routes, unassigned


def run_optimization(payload: dict[str, Any], time_limit_seconds: int = 8) -> dict[str, Any]:
    """Optimize per commute cluster: a property is only ever served by crews in its own
    cluster (Wasatch / St George / Dallas / Las Vegas), so no crew is routed across regions.
    Within a cluster, SLC and Lindon crews share the work (pooling). Results merge and
    aggregate once over the full crew/property lists."""
    started = time.time()
    crews = payload["crews"]
    branches = payload["branches"]
    properties = payload["properties"]
    branches_by_id = {b["id"]: b for b in branches}

    clusters = _branch_clusters(branches)
    by_branch, unattributable = _attribute_to_branches(properties, branches)

    props_by_cluster: dict[str, list[dict[str, Any]]] = {}
    for bid, props in by_branch.items():
        props_by_cluster.setdefault(clusters.get(bid, bid), []).extend(props)
    crews_by_cluster: dict[str, list[dict[str, Any]]] = {}
    for c in crews:
        home = c.get("home_branch_id")
        crews_by_cluster.setdefault(clusters.get(home, home), []).append(c)

    all_routes: list[dict[str, Any]] = []
    unassigned: list[str] = list(unattributable)  # ungeocoded / no active branch -> nobody can serve
    for cl, cl_props in props_by_cluster.items():
        cl_crews = crews_by_cluster.get(cl, [])
        if not cl_crews:
            unassigned.extend(p["id"] for p in cl_props)  # region has work but no crew
            continue
        routes, un = _optimize_subset(cl_crews, cl_props, branches_by_id,
                                      time_limit_seconds=time_limit_seconds, started=started)
        all_routes.extend(routes)
        unassigned.extend(un)

    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)


def run_recommendation(payload: dict[str, Any]) -> dict[str, Any]:
    """recommend mode: baseline validate -> capital-aware plan -> proposed validate
    -> coverage feedback loop (buy near stranded props + re-validate) -> persist what-if
    run + delta recommendation."""
    started = time.time()
    rec_id = payload.get("recommendation_id")
    try:
        branches = payload["branches"]
        properties = payload["properties"]
        current_crews = payload.get("crews", [])
        capex_usd = float(payload.get("capex_usd") or _REC_DEFAULT_CREW_CAPEX_USD)
        target_week = payload.get("target_week")
        rec_name = payload.get("name") or "Fleet recommendation"
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
        util_before = {u["crew_id"]: float(u.get("clock_hours", 0.0)) for u in baseline.get("crew_utilization", [])}
        util_before_pct = {u["crew_id"]: float(u.get("util_pct", 0.0)) for u in baseline.get("crew_utilization", [])}

        clusters = _branch_clusters(branches)
        # 2) plan deltas
        plan = _plan_fleet_changes(current_crews, by_branch, util_before, branch_name,
                                   capex_usd, clusters=clusters)

        # attach per-branch before-util for the builder
        before_at: dict[str, list[str]] = {}
        for c in current_crews:
            before_at.setdefault(c["home_branch_id"], []).append(c["id"])
        for bid in by_branch:
            ids = before_at.get(bid, [])
            vals = [util_before_pct.get(cid, 0.0) for cid in ids]
            plan["branches"].setdefault(bid, {})["util_before_pct"] = round(sum(vals) / len(vals), 1) if vals else 0.0

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


def _supabase_patch(table: str, row_id: str, fields: dict[str, Any]) -> None:
    """PATCH a single row in the given Supabase table via REST.

    Uses urllib.request rather than the supabase-py library because supabase-py
    2.10.0 rejects the new sb_secret_* service-role key format with "Invalid
    API key". The REST API itself accepts the new key fine.
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


def _persist(run_id: str, result: dict[str, Any]) -> None:
    # Postgres needs an ISO timestamp here. Sending the literal string "now()"
    # was the silent-failure bug that left runs stuck on 'running'.
    _supabase_patch("optimization_runs", run_id, {
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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (Vercel convention)
        try:
            length = int(self.headers.get("content-length", 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            run_id = payload.get("run_id")
            mode = payload.get("mode", "optimize")
            if mode == "recommend":
                # Recommendation is a long job (minutes: an analytical seed + several
                # full validate solves). Holding the HTTP connection that long gets it
                # cut by the proxy ("fetch failed" on the caller). Ack immediately and
                # run it on a background thread — run_recommendation writes its own
                # crew_recommendations row (completed/failed) when done; the web polls
                # that row. The container is long-lived (Coolify), so the thread
                # survives past this response.
                threading.Thread(target=run_recommendation, args=(payload,), daemon=True).start()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(
                    json.dumps({"status": "accepted", "recommendation_id": payload.get("recommendation_id")}).encode("utf-8")
                )
                return
            elif mode == "evaluate":
                result = run_evaluation(payload)
                if run_id:
                    _persist(run_id, result)
            else:
                result = run_optimization(payload)
                if run_id:
                    # Let _persist failures surface to the outer except so the run
                    # row gets marked 'failed'. Returning 200 with a swallowed
                    # persist_error left runs stuck on 'running' forever.
                    _persist(run_id, result)

            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
        except Exception as e:
            err = {"status": "failed", "error": str(e), "trace": traceback.format_exc()[-500:]}
            if (locals().get("mode") != "recommend") and (run_id := (locals().get("run_id"))):
                try:
                    _supabase_patch("optimization_runs", run_id, {
                        "status": "failed",
                        "failure_reason": str(e)[:500],
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                    })
                except Exception:
                    pass
            self.send_response(500)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(err).encode("utf-8"))

    def do_GET(self):  # noqa: N802
        # Health check + diagnostic. Returns import status so we can debug
        # FUNCTION_INVOCATION_FAILED without trawling Vercel logs.
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        body = {
            "ok": len(_IMPORT_ERRORS) == 0,
            "service": "truco-optimizer",
            "python_version": sys.version,
            "ortools_version": _ortools_version,
            "import_errors": _IMPORT_ERRORS,
            "supabase_url_set": bool(os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")),
            "supabase_key_set": bool(key),
            "supabase_key_len": len(key),
            "supabase_key_prefix": key[:8] if key else "",
        }
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))
