"""Pure checks for the capital-aware planner. Run:
python3 solver/api/check_recommend_plan.py   (no OR-Tools needed)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import _plan_fleet_changes, _make_rec_crew, _REC_CAP2, _branch_clusters, _apply_extra_additions, _cover_residual

BN = {"slc": "SLC HQ", "stg": "St George", "lin": "Lindon"}

def crew(cid, bid, size=2):
    return {"id": cid, "name": cid, "crew_size": size, "home_branch_id": bid}

def props(bid, *hours):
    return [{"id": f"{bid}-p{i}", "est_labor_hours": h} for i, h in enumerate(hours)]

# --- no over-provisioning: small branch, single crew is NEEDED for its 78h -> not surplus, no change ---
by_branch = {"stg": props("stg", 78.0)}                  # demand 78 < CAP2_TIGHT 93.5
plan = _plan_fleet_changes([crew("c1", "stg", 2)], by_branch, {"c1": 18.0}, BN, 110000)
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["changes"]["upsizes"] == [] and plan["changes"]["additions"] == [], plan["changes"]
assert plan["changes"]["surplus_idle"] == [], plan["changes"]   # the lone crew is needed for 78h

# --- relocate-first: short branch + a SURPLUS idle crew elsewhere (same cluster) -> relocate ($0) ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("s1", "stg", 3), crew("s2", "stg", 3)]  # stg has 2; 1 is spare
plan = _plan_fleet_changes(crews, by_branch, {"a": 60.0, "s1": 6.0, "s2": 6.0}, BN, 110000)
reloc = plan["changes"]["relocations"]
assert any(r["to_branch_name"] == "SLC HQ" and r["reason"] == "deficit" for r in reloc), reloc
assert plan["branches"]["stg"]["crews_after"]["three"] == 1, plan["branches"]["stg"]  # stg keeps 1 for its 10h

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

# --- rebalance: no deficit; a branch with a SURPLUS idle crew feeds a loaded same-cluster branch ---
by_branch = {"slc": props("slc", 90.0), "stg": props("stg", 5.0)}
crews = [crew("busy", "slc", 2), crew("s1", "stg", 2), crew("s2", "stg", 2)]  # stg has 2; 1 spare
plan = _plan_fleet_changes(crews, by_branch, {"busy": 58.0, "s1": 6.0, "s2": 6.0}, BN, 110000)
assert any(r["reason"] == "rebalance" and r["to_branch_name"] == "SLC HQ"
           for r in plan["changes"]["relocations"]), plan["changes"]
assert plan["totals"]["new_crews"] == 0, plan["totals"]
assert plan["branches"]["stg"]["crews_after"]["two"] == 1, plan["branches"]["stg"]  # stg keeps 1 for its 5h

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

# --- transitivity: A-B close, B-C close, A-C far -> all one cluster (single linkage) ---
_chain = [
    {"id": "a", "lat": 40.0000, "lng": -111.0000},
    {"id": "b", "lat": 40.4000, "lng": -111.0000},   # ~28 mi from a
    {"id": "c", "lat": 40.8000, "lng": -111.0000},   # ~28 mi from b, ~55 mi (road) past 60 from a
]
_clc = _branch_clusters(_chain, 40.0)                 # a-b and b-c within 40mi road; a-c is not
assert _clc["a"] == _clc["b"] == _clc["c"], _clc      # single-linkage chains them anyway

# --- cluster gating: idle crew at a far singleton branch is NOT relocated to a loaded branch ---
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 10.0)}
crews = [crew("a", "slc", 3), crew("b", "slc", 3), crew("idle", "stg", 3)]  # slc deficit, stg idle+far
clusters = {"slc": "slc", "stg": "stg"}  # different clusters
plan = _plan_fleet_changes(crews, by_branch, {"a": 52.0, "b": 52.0, "idle": 6.0}, BN, 110000,
                           clusters=clusters)
reloc = plan["changes"]["relocations"]
assert not any(r["to_branch_name"] == "SLC HQ" for r in reloc), reloc  # stg crew can't cross clusters
assert plan["branches"]["stg"]["crews_after"]["three"] == 1, plan["branches"]["stg"]  # stays at stg

# --- cluster gating, Tier 2 (rebalance): idle crew in a far cluster is NOT rebalanced across ---
by_branch = {"slc": props("slc", 90.0), "stg": props("stg", 5.0)}
crews = [crew("busy", "slc", 2), crew("idle", "stg", 2)]  # slc loaded (>50), stg idle+far
clusters = {"slc": "slc", "stg": "stg"}
plan = _plan_fleet_changes(crews, by_branch, {"busy": 58.0, "idle": 6.0}, BN, 110000,
                           clusters=clusters)
assert plan["changes"]["relocations"] == [], plan["changes"]   # no cross-cluster rebalance
assert plan["totals"]["new_crews"] == 0, plan["totals"]

# --- coverage floor: branch with 3 idle crews / 78h keeps 1, flags 2 as surplus; never drained to 0 ---
by_branch = {"stg": props("stg", 78.0)}
crews = [crew("c1", "stg", 2), crew("c2", "stg", 3), crew("c3", "stg", 3)]
clusters = {"stg": "stg"}  # singleton; nowhere to relocate
plan = _plan_fleet_changes(crews, by_branch, {"c1": 14.0, "c2": 14.0, "c3": 14.0}, BN, 110000,
                           clusters=clusters)
after = plan["branches"]["stg"]["crews_after"]
assert after["two"] + after["three"] == 3, after          # nobody relocated (singleton cluster)
assert plan["changes"]["surplus_idle"] == [{"branch_name": "St George", "count": 2}], plan["changes"]

# --- coverage floor in sources(): a lone NEEDED crew at a same-cluster branch is not relocated ---
# (regression guard: without keeps_coverage, stg's only crew would move to slc, stranding stg's 80h)
by_branch = {"slc": props("slc", 200.0), "stg": props("stg", 80.0)}
crews = [crew("b1", "slc", 3), crew("a1", "stg", 2)]   # stg: 1 crew, needed for 80h (cap 93.5)
clusters = {"slc": "slc_stg", "stg": "slc_stg"}        # SAME cluster, so only keeps_coverage can block
plan = _plan_fleet_changes(crews, by_branch, {"b1": 60.0, "a1": 25.0}, BN, 110000,
                           clusters=clusters)
assert plan["branches"]["stg"]["crews_after"]["two"] == 1, plan["branches"]["stg"]  # stg keeps its crew
assert plan["totals"]["new_crews"] >= 1, plan["totals"]  # slc closed its deficit by buying, not draining stg

# --- _apply_extra_additions folds loop-bought crews into an assembled plan ---
_plan = {
    "branches": {"slc": {"crews_before": {"two": 1, "three": 0},
                         "crews_after": {"two": 1, "three": 0},
                         "relocated_in": [], "upsized": 0, "added": {"two": 0, "three": 0}}},
    "changes": {"relocations": [], "upsizes": [], "additions": [], "surplus_idle": []},
    "totals": {"fleet_before": 1, "fleet_after": 1, "new_crews": 0,
               "capex_usd": 110000.0, "net_capital_usd": 0},
}
_apply_extra_additions(_plan, {"slc": {"two": 1, "three": 1}}, {"slc": "SLC HQ"}, 110000)
assert _plan["totals"]["new_crews"] == 2, _plan["totals"]
assert _plan["totals"]["net_capital_usd"] == 220000, _plan["totals"]
assert _plan["branches"]["slc"]["added"] == {"two": 1, "three": 1}, _plan["branches"]["slc"]
assert _plan["branches"]["slc"]["crews_after"] == {"two": 2, "three": 1}, _plan["branches"]["slc"]
assert {(a["size"], a["count"]) for a in _plan["changes"]["additions"]} == {(2, 1), (3, 1)}, _plan["changes"]

# --- _cover_residual buys crews near stranded props and stops when covered ---
_by_branch = {"slc": [{"id": "slc-a", "est_labor_hours": 90.0}, {"id": "slc-b", "est_labor_hours": 50.0}],
              "stg": [{"id": "stg-a", "est_labor_hours": 40.0}]}
_prop_labor = {"slc-a": 90.0, "slc-b": 50.0, "stg-a": 40.0}
def _fake_validate(crews):
    # round 0: slc-b stranded; after >=1 bought crew at slc, everything covered.
    bought_at_slc = sum(1 for c in crews if str(c["id"]).startswith("rec-slc-"))
    unassigned = [] if bought_at_slc >= 1 else ["slc-b"]
    return {"crew_utilization": [], "unassigned_property_ids": unassigned}
result, extra, proposed, vcount = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _fake_validate, max_rounds=5)
assert result["unassigned_property_ids"] == [], result
assert extra.get("slc", {}).get("two", 0) >= 1, extra        # bought a 2p at slc (slc-b is < CAP2)
assert vcount >= 2, vcount                                    # initial validate + at least one re-validate

# --- _cover_residual stops (no infinite loop) when a stranded prop is genuinely un-routable ---
def _never_covers(crews):
    return {"crew_utilization": [], "unassigned_property_ids": ["slc-b"]}
result2, extra2, _, vcount2 = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _never_covers, max_rounds=5)
assert result2["unassigned_property_ids"] == ["slc-b"], result2  # surfaced as a true limit
assert vcount2 <= 3, vcount2                                     # bailed on no-improvement, not 5 rounds

print("check_recommend_plan: PASS")
