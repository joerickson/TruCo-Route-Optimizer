"""Haversine + 1.3x road factor distance matrix.

We deliberately use Haversine instead of Mapbox Matrix API for capacity planning:
-  ~570 nodes => 324K cells, way past Mapbox 25x25 single-request limit
-  Solver cares about *relative* travel time, and 1.3x multiplier matches reality
   well enough at the strategic-planning level
-  Free, deterministic, no API quota burn during optimization
"""
from __future__ import annotations

import math
from typing import Sequence

ROAD_FACTOR = 1.3
EARTH_RADIUS_MI = 3958.8

# Distance-tiered effective speed: short in-neighborhood hops crawl between stops/lights,
# longer trips get on arterials and then the freeway. Modeled as CUMULATIVE segments on the
# road-distance (haversine x ROAD_FACTOR) so travel time is strictly increasing with distance
# (a flat per-tier speed would make a 12.1-mi trip *faster* than an 11.9-mi one and break the
# routing solver's distance ordering). Each tuple is (segment_upper_bound_miles, mph).
_SPEED_TIERS = (
    (3.0, 25.0),    # first 3 road-mi: neighborhood streets
    (12.0, 40.0),   # next 3-12 road-mi: arterials
    (float("inf"), 65.0),  # beyond 12 road-mi: freeway
)


def haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return EARTH_RADIUS_MI * 2 * math.asin(math.sqrt(a))


def road_minutes(road_miles: float) -> float:
    """Drive minutes for a given road distance using the cumulative tiered-speed model."""
    minutes = 0.0
    lower = 0.0
    for upper, mph in _SPEED_TIERS:
        if road_miles <= lower:
            break
        seg = min(road_miles, upper) - lower
        minutes += (seg / mph) * 60.0
        lower = upper
    return minutes


def drive_minutes(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    return road_minutes(haversine_miles(lat1, lng1, lat2, lng2) * ROAD_FACTOR)


def build_matrix(coords: Sequence[tuple[float, float]]) -> list[list[int]]:
    """Return drive-time matrix in integer seconds (OR-Tools wants ints)."""
    n = len(coords)
    out = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            mins = drive_minutes(coords[i][0], coords[i][1], coords[j][0], coords[j][1])
            secs = int(round(mins * 60))
            out[i][j] = secs
            out[j][i] = secs
    return out


def drive_miles(coords: Sequence[tuple[float, float]], path: Sequence[int]) -> float:
    total = 0.0
    for i in range(len(path) - 1):
        a = coords[path[i]]
        b = coords[path[i + 1]]
        total += haversine_miles(a[0], a[1], b[0], b[1]) * ROAD_FACTOR
    return total
