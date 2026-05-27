"""Pure checks for the crew-mix recommender helpers. Run:
python3 solver/api/check_recommend.py   (no OR-Tools needed)."""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import (
    _attribute_to_branches, _seed_fleet, _bin_pack_branch,
    _REC_CAP2, _REC_CAP3,
)

branches = [
    {"id": "slc", "lat": 40.76, "lng": -111.89},
    {"id": "provo", "lat": 40.23, "lng": -111.66},
]

# --- attribution: preferred honored, else nearest ---
props = [
    {"id": "p_pref", "est_labor_hours": 10, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "provo"},
    {"id": "p_near", "est_labor_hours": 10, "lat": 40.75, "lng": -111.88, "preferred_branch_id": None},  # near slc
    {"id": "p_far", "est_labor_hours": 10, "lat": 40.24, "lng": -111.65, "preferred_branch_id": None},   # near provo
]
by_branch, unattr = _attribute_to_branches(props, branches)
assert "p_pref" in [p["id"] for p in by_branch["provo"]], "preferred honored"
assert "p_near" in [p["id"] for p in by_branch["slc"]], "nearest = slc"
assert "p_far" in [p["id"] for p in by_branch["provo"]], "nearest = provo"
assert unattr == []

# --- bin-pack: all small -> only 2-person crews, all covered ---
small = [{"id": f"s{i}", "est_labor_hours": 40, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"} for i in range(4)]
crews = _bin_pack_branch(small, "slc")
assert crews and all(c["crew_size"] == 2 for c in crews), [c["crew_size"] for c in crews]
assert len(crews) == 2, len(crews)  # 4x40=160; cap2 ~85 => 2 crews (40+40 fits 85)
assert all(c["home_branch_id"] == "slc" and c["works_monday"] for c in crews)

# --- a property between cap2 and cap3 forces a 3-person crew ---
mid = [{"id": "mid", "est_labor_hours": 100, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"}]  # 85 < 100 <= 127.5
crews = _bin_pack_branch(mid, "slc")
assert len(crews) == 1 and crews[0]["crew_size"] == 3, crews

# --- oversize (Canyon Park 132.6 > cap3) -> split across 3-person crews ---
big = [{"id": "canyon", "est_labor_hours": 132.6, "lat": 40.76, "lng": -111.89, "preferred_branch_id": "slc"}]
crews = _bin_pack_branch(big, "slc")
import math
assert len(crews) == math.ceil(132.6 / _REC_CAP3) and all(c["crew_size"] == 3 for c in crews), crews

# --- seed_fleet flattens across branches ---
fleet = _seed_fleet(props, branches)
assert all("home_branch_id" in c and "crew_size" in c for c in fleet)
assert {c["home_branch_id"] for c in fleet} <= {"slc", "provo"}

print("check_recommend: PASS (attribution + bin-pack + seed)")

from index import _recommend_adjustments

adj_fleet = [
    {"id": "rec-slc-1", "home_branch_id": "slc", "crew_size": 2},
    {"id": "rec-provo-1", "home_branch_id": "provo", "crew_size": 2},
    {"id": "rec-provo-2", "home_branch_id": "provo", "crew_size": 2},
]
prop_branch = {"u_big": "slc", "u_small": "provo"}
prop_labor = {"u_big": 120.0, "u_small": 10.0}  # 120 > cap2 => needs 3-person

# uncovered work at slc (big) and provo (small) => add 3p at slc, 2p at provo; no removes (unassigned present)
adds, removes = _recommend_adjustments(
    adj_fleet,
    [{"crew_id": "rec-slc-1", "clock_hours": 50}, {"crew_id": "rec-provo-1", "clock_hours": 20}, {"crew_id": "rec-provo-2", "clock_hours": 15}],
    ["u_big", "u_small"], prop_branch, prop_labor,
)
assert ("slc", 3) in adds and ("provo", 2) in adds, adds
assert removes == [], removes

# fully covered, provo over-provisioned (both crews < 40 clock) => trim provo's least-loaded; slc single crew untouched
adds, removes = _recommend_adjustments(
    adj_fleet,
    [{"crew_id": "rec-slc-1", "clock_hours": 48}, {"crew_id": "rec-provo-1", "clock_hours": 20}, {"crew_id": "rec-provo-2", "clock_hours": 15}],
    [], prop_branch, prop_labor,
)
assert adds == [], adds
assert removes == ["rec-provo-2"], removes  # least-loaded provo crew

print("check_recommend: PASS (adjustments)")
