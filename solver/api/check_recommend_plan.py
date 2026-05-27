"""Pure checks for the capital-aware planner. Run:
python3 solver/api/check_recommend_plan.py   (no OR-Tools needed)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from index import (_plan_fleet_changes, _make_rec_crew, _REC_CAP2, _branch_clusters,
                   _apply_extra_additions, _cover_residual, _redeploy_surplus)

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
assert extra2.get("slc", {}).get("two", 0) == 0, extra2          # the probe didn't help -> rolled back, 0 added

# --- _cover_residual buys a 3-person crew when the stranded property exceeds CAP2 ---
def _validate_big(crews):
    # slc-a (90h > CAP2 85) stranded until a crew is bought at slc.
    bought_at_slc = sum(1 for c in crews if str(c["id"]).startswith("rec-slc-"))
    return {"crew_utilization": [], "unassigned_property_ids": [] if bought_at_slc >= 1 else ["slc-a"]}
result3, extra3, _, _ = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _validate_big, max_rounds=5)
assert result3["unassigned_property_ids"] == [], result3
assert extra3.get("slc", {}).get("three", 0) == 1, extra3        # big stranded prop => 3-person buy
assert extra3.get("slc", {}).get("two", 0) == 0, extra3

# --- _cover_residual ignores an unattributable stranded property (not in any branch) ---
def _orphan_validate(crews):
    return {"crew_utilization": [], "unassigned_property_ids": ["pid-not-in-by-branch"]}
result4, extra4, _, vcount4 = _cover_residual(
    [crew("a", "slc", 2)], _by_branch, _prop_labor, BN, _orphan_validate, max_rounds=5)
assert extra4 == {}, extra4                                      # nothing bought for an orphan prop
assert vcount4 == 1, vcount4                                     # initial validate only; loop breaks immediately

# --- per-branch termination: a branch whose work is un-routable gets 0 crews even while
#     ANOTHER branch keeps improving (the global-count bug bought crews at the dead-end branch) ---
_bb = {"good": [{"id": "g1", "est_labor_hours": 40.0}, {"id": "g2", "est_labor_hours": 40.0}],
       "bad":  [{"id": "b1", "est_labor_hours": 40.0}]}  # b1 never coverable (e.g. beyond daily reach)
_pl = {"g1": 40.0, "g2": 40.0, "b1": 40.0}
def _val_mixed(crews):
    # each bought "good" crew covers one good prop; bad stays stranded no matter what.
    bought_good = sum(1 for c in crews if str(c["id"]).startswith("rec-good-"))
    un = ["b1"]
    if bought_good < 1:
        un += ["g1", "g2"]
    elif bought_good < 2:
        un += ["g2"]
    return {"crew_utilization": [], "unassigned_property_ids": un}
result5, extra5, _, _ = _cover_residual([crew("x", "good", 2)], _bb, _pl, BN, _val_mixed, max_rounds=5)
assert extra5.get("good", {}).get("two", 0) == 2, extra5    # good keeps the 2 crews that helped it
assert "bad" not in extra5, extra5                          # bad's probe didn't help -> rolled back, 0 added
assert result5["unassigned_property_ids"] == ["b1"], result5  # un-routable work surfaced, not chased

# --- cluster rebalance: a deficit branch is covered by relocating a same-cluster branch's
#     SLACK (busy-not-idle) crews before buying, when the cluster has the total capacity ---
by_branch = {"slc": props("slc", 100.0), "lin": props("lin", 300.0)}
crews = [crew("s1", "slc", 3), crew("s2", "slc", 3), crew("s3", "slc", 3), crew("s4", "slc", 3),
         crew("l1", "lin", 2)]
clusters = {"slc": "wf", "lin": "wf"}                      # SLC + Lindon = one cluster
util = {"s1": 55, "s2": 55, "s3": 55, "s4": 55, "l1": 58}  # SLC crews busy (not idle); branch has slack
plan = _plan_fleet_changes(crews, by_branch, util, {"slc": "SLC", "lin": "Lindon"}, 110000,
                           clusters=clusters)
assert any(r["to_branch_name"] == "Lindon" and r["reason"] == "deficit"
           for r in plan["changes"]["relocations"]), plan["changes"]   # SLC slack -> Lindon
assert plan["totals"]["new_crews"] == 0, plan["totals"]                # cluster had capacity; no buy

# --- but cluster genuinely short: relocate all slack, THEN buy the remainder ---
by_branch = {"slc": props("slc", 250.0), "lin": props("lin", 400.0)}
crews = [crew("s1", "slc", 3), crew("s2", "slc", 3), crew("l1", "lin", 2)]  # cluster cap 374 < demand 650
util = {"s1": 55, "s2": 55, "l1": 58}
plan = _plan_fleet_changes(crews, by_branch, util, {"slc": "SLC", "lin": "Lindon"}, 110000,
                           clusters={"slc": "wf", "lin": "wf"})
assert plan["totals"]["new_crews"] >= 1, plan["totals"]                # slack exhausted -> buy

# --- _redeploy_surplus: surplus assets fund additions ($0) before counting new capital ---
def _mk_plan(additions, fleet_before, fleet_after, capex=110000):
    return {
        "branches": {
            "stg": {"crews_before": {"two": 1, "three": 2}, "crews_after": {"two": 1, "three": 2},
                    "relocated_in": [], "upsized": 0, "added": {"two": 0, "three": 0}},
            "lin": {"crews_before": {"two": 3, "three": 1}, "crews_after": {"two": 3 + sum(a["count"] for a in additions if a["size"] == 2), "three": 1},
                    "relocated_in": [], "upsized": 0, "added": {}},
        },
        "changes": {"relocations": [], "upsizes": [], "additions": [dict(a) for a in additions],
                    "surplus_idle": [{"branch_name": "St George", "count": 2}],
                    "redeployments": [], "disbanded": []},
        "totals": {"fleet_before": fleet_before, "fleet_after": fleet_after,
                   "new_crews": sum(a["count"] for a in additions), "capex_usd": float(capex),
                   "net_capital_usd": int(sum(a["count"] for a in additions) * capex)},
    }

BN2 = {"stg": "St George", "lin": "Lindon"}

# 2 St George surplus (1×2p,1×3p) fund 2 of Lindon's 5 buys -> 3 new, 2 redeployed, net capital drops
p = _mk_plan([{"branch_name": "Lindon", "size": 2, "count": 5}], fleet_before=32, fleet_after=37)
_redeploy_surplus(p, {"stg": {"two": 1, "three": 1}}, BN2, 110000)
assert p["totals"]["new_crews"] == 3, p["totals"]                      # 5 buys - 2 redeployed
assert p["totals"]["net_capital_usd"] == 330000, p["totals"]
assert p["totals"]["fleet_after"] == 35, p["totals"]                   # 32 + 5 additions - 2 disbanded
assert sum(a["count"] for a in p["changes"]["additions"]) == 3, p["changes"]
assert sum(r["count"] for r in p["changes"]["redeployments"]) == 2, p["changes"]
assert all(r["to_branch_name"] == "Lindon" and r["from_branch_name"] == "St George" for r in p["changes"]["redeployments"])
assert p["changes"]["disbanded"] == [], p["changes"]                   # all surplus redeployed, none downsized
assert p["changes"]["surplus_idle"] == [], p["changes"]                # superseded
assert p["branches"]["stg"]["crews_after"] == {"two": 0, "three": 1}, p["branches"]["stg"]  # disbanded 1×2p+1×3p

# more surplus (3) than additions (1) -> 1 redeployed, 2 pure-downsized, 0 new
p2 = _mk_plan([{"branch_name": "Lindon", "size": 2, "count": 1}], fleet_before=32, fleet_after=33)
_redeploy_surplus(p2, {"stg": {"two": 1, "three": 2}}, BN2, 110000)
assert p2["totals"]["new_crews"] == 0, p2["totals"]
assert p2["totals"]["net_capital_usd"] == 0, p2["totals"]
assert p2["totals"]["fleet_after"] == 30, p2["totals"]                 # 32 + 1 - 3 disbanded
assert sum(r["count"] for r in p2["changes"]["redeployments"]) == 1, p2["changes"]
assert sum(d["count"] for d in p2["changes"]["disbanded"]) == 2, p2["changes"]
assert p2["changes"]["additions"] == [], p2["changes"]

# no surplus -> no-op (additions and capital unchanged)
p3 = _mk_plan([{"branch_name": "Lindon", "size": 2, "count": 4}], fleet_before=32, fleet_after=36)
_redeploy_surplus(p3, {}, BN2, 110000)
assert p3["totals"]["new_crews"] == 4 and p3["totals"]["net_capital_usd"] == 440000, p3["totals"]
assert sum(a["count"] for a in p3["changes"]["additions"]) == 4, p3["changes"]
assert p3["changes"]["redeployments"] == [] and p3["changes"]["disbanded"] == [], p3["changes"]

# surplus but NO additions -> all surplus pure-downsized, 0 new, fleet shrinks
p4 = _mk_plan([], fleet_before=32, fleet_after=32)
_redeploy_surplus(p4, {"stg": {"two": 1, "three": 1}}, BN2, 110000)
assert p4["totals"]["new_crews"] == 0 and p4["totals"]["net_capital_usd"] == 0, p4["totals"]
assert p4["totals"]["fleet_after"] == 30, p4["totals"]            # 32 + 0 additions - 2 disbanded
assert p4["changes"]["redeployments"] == [], p4["changes"]
assert sum(d["count"] for d in p4["changes"]["disbanded"]) == 2, p4["changes"]
assert p4["branches"]["stg"]["crews_after"] == {"two": 0, "three": 1}, p4["branches"]["stg"]

print("check_recommend_plan: PASS")
