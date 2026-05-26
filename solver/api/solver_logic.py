"""OR-Tools VRP solver — runs once per weekday.

Inputs (per day):
  - properties_for_day:   list of work-chunk dicts (property_id, name, address, lat, lng,
                                                     labor_hours [person-hours per chunk],
                                                     chunk_index, chunk_count)
  - crews_for_day:        list of dicts (id, name, branch_id, branch_lat, branch_lng,
                                         crew_size, max_clock_hours)
  - distance_matrix:      square int matrix in *seconds*; indices 0..n_crews-1 are
                          per-crew start depots; remaining indices are chunk nodes

Output:
  - list[CrewDayRoute] (see types in api/solver.py)
  - per-crew metrics aggregated by caller
"""
from __future__ import annotations

from typing import Any

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

from distance_matrix import build_matrix, drive_miles


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

    # Node layout: indices 0..n_crews-1 are per-crew start depots; the rest are chunk nodes.
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
                # round() here; the routing callback uses // (floor). They differ by <=1s/stop — cosmetic, not load-bearing.
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
