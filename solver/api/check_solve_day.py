"""OR-Tools-backed checks for solve_day's day-capacity model. Run:
python3 solver/api/check_solve_day.py   (needs ortools)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from solver_logic import solve_day

BR = {"branch_lat": 40.0, "branch_lng": -111.0}


def crew(cid, size=2, max_clock=10.0):
    return {"id": cid, "name": cid, "branch_id": "b", "crew_size": size,
            "max_clock_hours": max_clock, **BR}


def prop(pid, lat, lng, labor):
    return {"id": pid, "property_id": pid, "name": pid, "address": "",
            "lat": lat, "lng": lng, "labor_hours": labor, "chunk_index": 1, "chunk_count": 1}


# --- a far property whose WORK fits the day but work+drive would not, is now ASSIGNED ---
# 18 person-hrs / 2 = 9h work (<= 10h cap); ~0.4deg north => ~1.4h round-trip drive on top.
far = prop("far", 40.40, -111.0, 18.0)
res = solve_day(1, [far], [crew("c1", size=2, max_clock=10.0)], time_limit_seconds=5)
assert res["unassigned"] == [], res            # work rides under the cap; drive is on top
assert any(s["property_name"] == "far" for r in res["routes"] for s in r["stops"]), res

# --- the work cap still binds: a property needing >10h of WORK for the crew is dropped ---
big = prop("big", 40.40, -111.0, 24.0)          # 24/2 = 12h work > 10h cap
res2 = solve_day(1, [big], [crew("c1", size=2, max_clock=10.0)], time_limit_seconds=5)
assert res2["unassigned"] == ["big"], res2

# --- the same big property fits a 3-person crew (24/3 = 8h work <= 10h) ---
res3 = solve_day(1, [prop("big3", 40.40, -111.0, 24.0)], [crew("c3", size=3, max_clock=10.0)],
                 time_limit_seconds=5)
assert res3["unassigned"] == [], res3

print("check_solve_day: PASS")
