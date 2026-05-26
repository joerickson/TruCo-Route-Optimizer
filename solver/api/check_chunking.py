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

print("check_chunking: PASS (thresholds + chunk_labor)")
