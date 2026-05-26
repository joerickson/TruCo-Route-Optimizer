"""Standalone check for _group_by_crew_day. Run: python3 solver/api/check_grouping.py
Importable without OR-Tools because index.py guards the solver_logic import.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _group_by_crew_day

props = [
    {"id": "a", "assigned_day_of_week": 1, "assigned_crew_id": "c1"},
    {"id": "b", "assigned_day_of_week": 1, "assigned_crew_id": "c1"},
    {"id": "c", "assigned_day_of_week": 2, "assigned_crew_id": "c1"},
    {"id": "d", "assigned_day_of_week": 1, "assigned_crew_id": "c2"},
    {"id": "e", "assigned_day_of_week": None, "assigned_crew_id": "c1"},  # no day
    {"id": "f", "assigned_day_of_week": 3, "assigned_crew_id": None},     # no crew
]
groups, unassigned = _group_by_crew_day(props)

assert set(groups.keys()) == {(1, "c1"), (2, "c1"), (1, "c2")}, groups.keys()
assert [p["id"] for p in groups[(1, "c1")]] == ["a", "b"]
assert [p["id"] for p in groups[(2, "c1")]] == ["c"]
assert [p["id"] for p in groups[(1, "c2")]] == ["d"]
assert sorted(unassigned) == ["e", "f"], unassigned
print("check_grouping: PASS")
