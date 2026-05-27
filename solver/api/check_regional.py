"""OR-Tools-backed checks for cluster-partitioned routing in run_optimization. Run:
python3 solver/api/check_regional.py   (needs ortools)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import run_optimization


def branch(bid, lat, lng):
    return {"id": bid, "name": bid, "lat": lat, "lng": lng}


def crew(cid, bid, size=2):
    return {"id": cid, "name": cid, "home_branch_id": bid, "crew_size": size,
            "max_clock_hours_per_day": 10.0,
            "works_monday": True, "works_tuesday": True, "works_wednesday": True,
            "works_thursday": True, "works_friday": True,
            "works_saturday": False, "works_sunday": False}


def prop(pid, lat, lng, labor):
    return {"id": pid, "name": pid, "address": "", "lat": lat, "lng": lng, "est_labor_hours": labor}


def crew_of(result, pid):
    for r in result["routes_jsonb"]["per_day"]:
        for s in r["stops"]:
            if s["property_id"] == pid:
                return r["crew_id"]
    return None


# --- regional isolation: each property is served by ITS cluster's crew, never the other's ---
branches = [branch("A", 40.0, -111.0), branch("B", 44.0, -116.0)]  # far apart -> different clusters
crews = [crew("ca", "A"), crew("cb", "B")]
props = [prop("a1", 40.02, -111.0, 8.0), prop("b1", 44.02, -116.0, 8.0)]
res = run_optimization({"crews": crews, "branches": branches, "properties": props}, time_limit_seconds=5)
assert res["unassigned_property_ids"] == [], res["unassigned_property_ids"]
assert crew_of(res, "a1") == "ca", res
assert crew_of(res, "b1") == "cb", res

# --- cross-cluster forbidden EVEN when reachable under the day cap (partition, not the cap, blocks it) ---
# A has no crew; B's crew is ~81 road-mi away (different cluster) but a 16h job (8h work) + ~2.8h
# round-trip drive = ~10.8h < 12h cap, so a region-blind VRP WOULD let B serve it. Partition forbids it.
b2 = [branch("A", 40.0, -111.0), branch("B", 40.9, -111.0)]  # ~81 road-mi -> different clusters
res2 = run_optimization({"crews": [crew("cb", "B")], "branches": b2,
                         "properties": [prop("a1", 40.0, -111.0, 16.0)]}, time_limit_seconds=8)
assert res2["unassigned_property_ids"] == ["a1"], res2  # A's own cluster has no crew -> unassigned
assert crew_of(res2, "a1") is None, res2

# --- within-cluster pooling: SLC+Lindon-style close branches share work ---
# A (no crew) and B (crew) are ~9 road-mi apart -> same cluster, so B's crew serves A's property.
b3 = [branch("A", 40.00, -111.0), branch("B", 40.10, -111.0)]  # ~9 road-mi -> same cluster
res3 = run_optimization({"crews": [crew("cb", "B")], "branches": b3,
                         "properties": [prop("a1", 40.00, -111.0, 8.0)]}, time_limit_seconds=5)
assert res3["unassigned_property_ids"] == [], res3  # same cluster -> pooled
assert crew_of(res3, "a1") == "cb", res3

print("check_regional: PASS")
