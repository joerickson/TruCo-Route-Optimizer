"""Standalone checks for the pure chunking/aggregation helpers.
Run: python3 solver/api/check_chunking.py
Imports without OR-Tools because index.py guards the solver_logic import.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _chunk_thresholds, chunk_labor


def approx(a, b, eps=1e-6):
    return abs(a - b) < eps


# --- _chunk_thresholds ---
crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10},
    {"crew_size": 3, "max_clock_hours_per_day": 10},
]
single_day_max, shift = _chunk_thresholds(crews)
assert single_day_max == 30.0, single_day_max  # 3 * 10
assert shift == 10.0, shift                     # min daily hours
assert _chunk_thresholds([]) == (30.0, 10.0)

# --- chunk_labor ---
assert chunk_labor(12, 30, 10) == [12], "<= single_day_max stays whole"
assert chunk_labor(30, 30, 10) == [30], "exactly single_day_max stays whole"
assert chunk_labor(35, 30, 10) == [10, 10, 10, 5], chunk_labor(35, 30, 10)
c250 = chunk_labor(250, 30, 10)
assert len(c250) == 25 and approx(sum(c250), 250), (len(c250), sum(c250))
c = chunk_labor(132.6, 30, 10)
assert approx(sum(c), 132.6), sum(c)
assert all(x <= 10 + 1e-9 for x in c), c
assert c[-1] > 0, "no zero-padded remainder"

# Dust remainder just over a shift multiple must not produce a trailing 0.0 chunk.
cd = chunk_labor(30.00001, 30, 10)
assert cd[-1] > 0, cd
assert all(x > 0 for x in cd), cd
assert approx(sum(cd), 30.00001, eps=1e-3), sum(cd)

print("check_chunking: PASS (thresholds + chunk_labor)")

from index import _properties_for_solver

_crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10},
    {"crew_size": 3, "max_clock_hours_per_day": 10},
]
# single_day_max = 30, shift = 10
base = {"address": "1 Main", "lat": 40.0, "lng": -111.0,
        "preferred_day_of_week": None, "assigned_day_of_week": 2, "assigned_crew_id": "c1"}
props = [
    {"id": "small", "name": "Small", "est_labor_hours": 12, **base},   # <=30 -> 1 chunk
    {"id": "big", "name": "Big Park", "est_labor_hours": 35, **base},  # ->10,10,10,5 = 4 chunks
    {"id": "nogeo", "name": "NoGeo", "est_labor_hours": 5,
     "address": "x", "lat": None, "lng": None,
     "preferred_day_of_week": None, "assigned_day_of_week": None, "assigned_crew_id": None},
]
chunks = _properties_for_solver(props, _crews)

assert all(c["property_id"] != "nogeo" for c in chunks)
small = [c for c in chunks if c["property_id"] == "small"]
assert len(small) == 1 and small[0]["id"] == "small" and small[0]["chunk_count"] == 1
assert small[0]["name"] == "Small" and approx(small[0]["labor_hours"], 12)
big = [c for c in chunks if c["property_id"] == "big"]
assert len(big) == 4 and [c["id"] for c in big] == ["big#1", "big#2", "big#3", "big#4"]
assert big[0]["name"] == "Big Park (1/4)" and big[0]["chunk_index"] == 1 and big[0]["chunk_count"] == 4
assert approx(sum(c["labor_hours"] for c in big), 35)
assert all(c["assigned_crew_id"] == "c1" and c["assigned_day_of_week"] == 2 for c in big)

print("check_chunking: PASS (properties_for_solver)")

from index import _bucketize_properties

bucket_crews = [
    {"crew_size": 2, "max_clock_hours_per_day": 10,
     "works_monday": True, "works_tuesday": True, "works_wednesday": True,
     "works_thursday": True, "works_friday": True},
]
sticky_chunk = {"id": "s", "property_id": "s", "labor_hours": 8, "lat": 40.0, "lng": -111.0,
                "assigned_day_of_week": 2, "chunk_count": 1}
split_chunks = [
    {"id": f"b#{k}", "property_id": "b", "labor_hours": 10, "lat": 40.1, "lng": -111.1,
     "assigned_day_of_week": 2, "chunk_count": 4}
    for k in range(1, 5)
]
buckets = _bucketize_properties([sticky_chunk, *split_chunks], bucket_crews)
assert any(c["id"] == "s" for c in buckets[2]), "single-chunk sticky to assigned day"
split_days = [d for d, items in buckets.items() for c in items if c["property_id"] == "b"]
assert len(set(split_days)) > 1, f"split property should spread across days, got {split_days}"

print("check_chunking: PASS (bucketize)")
