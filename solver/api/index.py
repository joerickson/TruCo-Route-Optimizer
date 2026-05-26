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
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any

# @vercel/python doesn't add the entrypoint's directory to sys.path, so sibling
# .py files in api/ can't be imported by name without this. Without it,
# `from solver_logic import ...` raises ModuleNotFoundError at runtime.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

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


def _bucketize_properties(
    properties: list[dict[str, Any]], crews: list[dict[str, Any]]
) -> dict[int, list[dict[str, Any]]]:
    """Distribute properties across the 5 weekdays.

    Strategy:
      - If property has assigned_day_of_week, honor it (soft, but we don't move it here).
      - Otherwise greedy round-robin in geographic order by latitude band, balancing total
        labor hours across days. Cheap heuristic — solver does the real work within a day.
    """
    work_days = [d for d in (1, 2, 3, 4, 5) if any(c.get(WEEKDAY_FIELDS[d]) for c in crews)]
    if not work_days:
        work_days = [1, 2, 3, 4, 5]

    buckets: dict[int, list[dict[str, Any]]] = {d: [] for d in work_days}

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


def run_optimization(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    crews = payload["crews"]
    branches = payload["branches"]
    properties = payload["properties"]

    branches_by_id = {b["id"]: b for b in branches}
    solver_props = _properties_for_solver(properties, crews)
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
        # Per-day OR-Tools time. GLS metaheuristic uses the FULL time budget
        # even on tiny inputs, so this multiplies by # of non-empty days.
        # Vercel's edge proxy kills connections with no first-byte-out within
        # 60s, so total budget must stay well under that (5 days × 8s = 40s).
        result = solve_day(day, props_for_day, crews_today, time_limit_seconds=8)
        all_routes.extend(result["routes"])
        unassigned.extend(result.get("unassigned", []))

    return _aggregate_result(crews, all_routes, unassigned, properties, time.time() - started)


def _supabase_patch(run_id: str, fields: dict[str, Any]) -> None:
    """PATCH a single optimization_runs row via Supabase REST.

    Uses urllib.request rather than the supabase-py library because supabase-py
    2.10.0 rejects the new sb_secret_* service-role key format with "Invalid
    API key". The REST API itself accepts the new key fine.
    """
    url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(f"Missing supabase env: url_set={bool(url)}, key_set={bool(key)}")

    req = urllib.request.Request(
        f"{url}/rest/v1/optimization_runs?id=eq.{run_id}",
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
        raise RuntimeError(f"Update returned no rows for run_id={run_id}")


def _persist(run_id: str, result: dict[str, Any]) -> None:
    # Postgres needs an ISO timestamp here. Sending the literal string "now()"
    # was the silent-failure bug that left runs stuck on 'running'.
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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (Vercel convention)
        try:
            length = int(self.headers.get("content-length", 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            run_id = payload.get("run_id")
            mode = payload.get("mode", "optimize")
            result = run_evaluation(payload) if mode == "evaluate" else run_optimization(payload)
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
            if run_id := (locals().get("run_id")):
                try:
                    _supabase_patch(run_id, {
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
