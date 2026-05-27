# Disband + Redeploy Surplus Assets — Design

**Status:** Approved 2026-05-27. Recommender + web.

## Goal
Jon: "the solver can recommend shutting down a crew and redeploying the assets, not the employees — perfectly reasonable." So instead of buying every addition new at $110k, fund it with a **disbanded surplus crew's asset** ($0, cross-cluster — only the truck moves). Decisions already made: disband **pure** surplus too (downsize even with no redeploy target); pool = the existing `surplus_idle` set; fund **all** additions (planner deficit-buys + coverage-loop buys) before buying new.

## Approach — post-pass on the assembled plan
A new pure `_redeploy_surplus(plan, surplus_detail, branch_name, capex_usd)` runs in `run_recommendation` **after** `_apply_extra_additions` (so it sees all additions) and **before** `_build_recommendation`.

### Solver changes (`solver/api/index.py`)
1. **`_plan_fleet_changes`**: while computing `surplus`, also record the **sizes** of the removable idle crews → `surplus_detail: {bid: {"two": n, "three": m}}`; add it to the returned plan. (`surplus_idle` output shape unchanged.)
2. **`_redeploy_surplus(plan, surplus_detail, branch_name, capex_usd)`** — mutates plan in place:
   - Flatten `surplus_detail` → disbandable assets `[(bid, size)]`; flatten `changes.additions` → addition units `[(dest_branch_name, size)]`.
   - Match 1:1 (`n = min(assets, additions)` — any asset funds any addition; capital saved is identical). Each match: record a redeployment `{from_branch_name, to_branch_name, size=dest_size, count}`; **disband the source crew** (decrement `plan["branches"][src_bid]["crews_after"][src_size]`).
   - Leftover surplus assets (no addition) → **pure downsize**: decrement source `crews_after`, record `disbanded {branch_name, count}`.
   - Remaining addition units (no asset) stay as **new-buys** → rebuild `changes.additions`.
   - Set `changes.redeployments`, `changes.disbanded`; clear `changes.surplus_idle` (superseded).
   - Recompute totals: `new_crews = additions − n`; `net_capital_usd = new_crews × capex`; `fleet_after = fleet_before + total_additions − total_surplus_disbanded`.
3. Wire into `run_recommendation`: `_redeploy_surplus(plan, plan["surplus_detail"], branch_name, capex_usd)` after the `_apply_extra_additions` call.

### Types (`src/lib/types.ts`) — `RecommendationChanges`
Add `redeployments: { from_branch_name; to_branch_name; size: 2|3; count }[]` and `disbanded: { branch_name; count }[]`. Keep `surplus_idle` (now usually empty; back-compat for old rows).

### Web (`src/app/recommend/recommend-table.tsx`)
Add two sections after Additions: **"Disband & redeploy"** (`Disband N crew(s) at <from> → redeploy asset to <to> · $0`) and **"Disband (downsize)"** (`Disband N surplus crew(s) at <branch> · frees the asset`). Guard old rows: `c.redeployments ?? []`, `c.disbanded ?? []`. Update `noChanges` to include them.

## Example (current data)
St George shows 2 surplus; Lindon buys (say) 5. → "Disband 2 at St George → redeploy to Lindon ($0)" + "buy 3 new at Lindon", net capital drops 5×110k → 3×110k, St George crews_after 3→1.

## Known limitation
`util_after_pct` and the linked what-if run are computed on the pre-disband proposed fleet (the validate happens before the redeploy post-pass), so a disbanded-down branch's util% is shown slightly low. Crew **counts** and **capital** (the decision-relevant numbers) are correct. Acceptable; revisit only if it confuses.

## Tests (pure — `check_recommend_plan.py`, no OR-Tools)
- surplus funds additions → redeployments recorded, additions shrink, `new_crews`/`net_capital` drop, source `crews_after` decremented, `fleet_after` correct.
- surplus > additions → extra surplus pure-downsized (`disbanded`), `new_crews = 0`.
- additions > surplus → all surplus redeployed, remaining additions stay as buys.
- no surplus → no-op (additions unchanged); no additions but surplus → all downsized.

## Deploy ordering
Solver writes the new fields; web must render them. Redeploy the **solver** app, then the web app (web guards `?? []` so order is forgiving). No schema change.

## Out of scope
Cluster-level deficit sizing; branch filter on schedule views; actual-hours upload.
