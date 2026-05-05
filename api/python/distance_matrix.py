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
AVG_SPEED_MPH = 30.0  # suburban/urban assumed average for landscape crews


def haversine_miles(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return EARTH_RADIUS_MI * 2 * math.asin(math.sqrt(a))


def drive_minutes(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    miles = haversine_miles(lat1, lng1, lat2, lng2) * ROAD_FACTOR
    return (miles / AVG_SPEED_MPH) * 60.0


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
