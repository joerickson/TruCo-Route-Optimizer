"""Pure checks for the capital-aware planner. Run:
python3 solver/api/check_recommend_plan.py   (no OR-Tools needed)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _plan_fleet_changes, _make_rec_crew, _REC_CAP2, _branch_clusters

BN = {"slc": "SLC HQ", "stg": "St George", "lin": "Lindon"}

def crew(cid, bid, size=2):
    return {"id": cid, "name": cid, "crew_size": size, "home_branch_id": bid}

def props(bid, *hours):
    return [{"id": f"{bid}-p{i}", "est_labor_hours": h} for i, h in enumerate(hours)]

# --- no over-provisioning: small branch with idle crew + routing artifact -> no change ---
by_branch = {"stg": props("stg", 78.0)}                  # demand 78 < CAP2_TIGHT 93.5
plan = _plan_fleet_changes([crew("c1", "stg", 2)], by_branch, {"c1": 18.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["changes"]["upsizes"] == [] and plan["changes"]["additions"] == [], plan["changes"]
# idle crew, but every branch <=50 => surplus (not relocated, not bought)
assert plan["changes"]["surplus_idle"] == [{"branch_name": "St George", "count": 1}], plan["changes"]

# --- relocate-first: short branch + idle crew elsewhere -> relocate ($0), no buy ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("idle", "stg", 3)]    # slc deficit (200 > 140.25), stg idle
plan = _plan_fleet_changes(crews, by_branch, {"a": 52.0, "idle": 8.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
reloc = plan["changes"]["relocations"]
assert any(r["to_branch_name"] == "SLC HQ" and r["reason"] == "deficit" for r in reloc), reloc

# --- upsize-before-buy: short branch, no sources, has a 2-person crew -> upsize ---
by_branch = {"slc": props("slc", 130.0)}                 # 130 > CAP2_TIGHT 93.5, < CAP3_TIGHT 140.25
plan = _plan_fleet_changes([crew("a", "slc", 2)], by_branch, {"a": 56.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert sum(u["count"] for u in plan["changes"]["upsizes"]) == 1, plan["changes"]

# --- buy-last: short branch, no crews at all -> buy; 3p when a >CAP2 property exists ---
by_branch = {"slc": props("slc", 100.0)}                 # 100 > CAP2 (85) => big => 3-person
plan = _plan_fleet_changes([], by_branch, {}, BN, 110000)
assert plan["totals"]["new_crews"] >= 1, plan["totals"]
assert any(a["size"] == 3 for a in plan["changes"]["additions"]), plan["changes"]
assert plan["totals"]["net_capital_usd"] == plan["totals"]["new_crews"] * 110000, plan["totals"]

# --- rebalance: no deficit, idle crew at <=40 branch, another branch avg >50 -> relocate(rebalance) ---
by_branch = {"slc": props("slc", 90.0), "stg": props("stg", 5.0)}
crews = [crew("busy", "slc", 2), crew("idle", "stg", 2)]
plan = _plan_fleet_changes(crews, by_branch, {"busy": 58.0, "idle": 6.0}, BN, 110000)
assert any(r["reason"] == "rebalance" and r["to_branch_name"] == "SLC HQ" for r in plan["changes"]["relocations"]), plan["changes"]
assert plan["totals"]["new_crews"] == 0, plan["totals"]

# --- capex echo + name format ---
assert _make_rec_crew("lin", 1, 3, "Lindon")["name"] == "Lindon · 3p #1"
plan = _plan_fleet_changes([], {"slc": props("slc", 200.0)}, {}, BN, 90000)
assert plan["totals"]["capex_usd"] == 90000 and plan["totals"]["net_capital_usd"] == plan["totals"]["new_crews"] * 90000

# --- clusters: near branches merge, far branches stay singleton ---
_branches = [
    {"id": "slc", "lat": 40.7608, "lng": -111.8910},  # Salt Lake City
    {"id": "lin", "lat": 40.3416, "lng": -111.7144},  # Lindon (~30 mi from SLC)
    {"id": "stg", "lat": 37.0965, "lng": -113.5684},  # St George (~270 mi)
    {"id": "dal", "lat": 32.7767, "lng": -96.7970},   # Dallas (~1000+ mi)
    {"id": "nocoord"},                                 # no lat/lng -> singleton
]
_cl = _branch_clusters(_branches, 60.0)
assert _cl["slc"] == _cl["lin"], _cl                   # SLC + Lindon together
assert _cl["stg"] != _cl["slc"], _cl                   # St George alone
assert _cl["dal"] != _cl["slc"] and _cl["dal"] != _cl["stg"], _cl
assert _cl["nocoord"] == "nocoord", _cl                # ungeocoded -> own singleton

print("check_recommend_plan: PASS")
