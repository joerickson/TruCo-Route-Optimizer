# Capital-Aware Crew Recommender + What-If Schedule Preview — Design Spec

**Date:** 2026-05-27
**Status:** Approved (design)
**Supersedes:** the from-scratch bin-pack recommender and its artifact-driven add loop.

## 0. Summary

Reframe the crew-mix recommender from "design an ideal fleet from scratch and
brute-force-add crews until nothing is unassigned" to a **capital-aware fleet-change
planner**: given the **current** crews + branches + demand, recommend the
**cheapest set of changes** to bring every branch within a sustainable workload
ceiling, where each genuinely new crew carries ~**$110k** of equipment capex (truck,
mower, trailer) and that figure is **editable in the UI**. Then **persist the
resulting schedule** as a read-only "what-if" optimization run linked from
`/recommend`, so the user can see the day-by-day schedule the recommended fleet
produces — without touching the live Crews table.

This fixes the observed bug (St George 78 h/wk → 5 crews @ 21%; Dallas 77 h/wk → 5 @
14%): the old loop added a crew for any per-day routing artifact and only trimmed
when global unassigned was empty.

## 1. Cost model & levers

A crew's $110k is **equipment** (one rig per crew). Headcount is labor, not capex.
So levers, cheapest first:

1. **Relocate** an idle crew from an over-provisioned branch to a short branch — **$0**.
2. **Upsize** a 2-person crew at a short branch to 3-person — **labor only**
   (~+42.5 clock-h/wk of capacity), **no capex**.
3. **Buy** a new crew — **capex = `capex_usd`** (default 110000); +85 person-h/wk
   (2-person) or +127.5 (3-person, when a property exceeds a 2-person crew's weekly
   capacity).

The planner exhausts cheaper levers before resorting to dearer ones.

## 2. Constants

`solver/api/index.py` (mirror the workload bands; the lever order + caps are also
mirrored conceptually in `src/lib/unassigned-fix.ts` — keep documented, see §7):

```
_REC_SUSTAINABLE_CLOCK_PER_WEEK = 50.0   # band reference (display)
_REC_TIGHT_CLOCK_PER_WEEK       = 55.0   # add-trigger ceiling (deferred-capex band)
_REC_USABLE_FRACTION            = 0.85
_REC_OVER_PROVISIONED_CLOCK     = 40.0   # a crew under this is idle / a relocation source
_REC_CAP2  = 0.85*50*2 = 85.0            # sustainable weekly person-hours, 2-person
_REC_CAP3  = 0.85*50*3 = 127.5           # sustainable, 3-person
_REC_CAP2_TIGHT = 0.85*55*2 = 93.5       # capacity used for the add-trigger, 2-person
_REC_CAP3_TIGHT = 0.85*55*3 = 140.25     # add-trigger, 3-person
_REC_DEFAULT_CREW_CAPEX_USD = 110_000    # default; overridden by payload capex_usd
```

## 3. Algorithm (`run_recommendation`, solver, backgrounded)

Inputs (payload): `branches`, `properties`, **`crews`** (current active crews:
id, name, crew_size, home_branch_id), **`capex_usd`** (number),
**`target_week`** (Monday ISO date), `recommendation_id`.

1. **Attribute demand to branches** (`_attribute_to_branches`, unchanged):
   `preferred_branch_id` if active else nearest active geocoded branch. `demand_B`
   = Σ `est_labor_hours` of B's attributed properties.
2. **Baseline validate:** run `run_optimization` on the **current** fleet to get the
   actual per-crew clock-hours (drive-aware) → `util_before`. A crew is **idle** if
   its clock `< 40`. Short/deficit is decided purely by **capacity vs demand** (next
   step), *not* by baseline unassigned — unassigned at a within-capacity branch is a
   routing artifact and must not trigger a buy. The baseline run also supplies
   `util_before` for the before→after display and identifies idle relocation sources.
3. **Plan deltas — cheapest lever first** (deterministic ordering):
   - **Sources** = idle crews at non-short branches (sorted capacity desc, then name).
   - For each short branch B (largest deficit first; `deficit_B = demand_B − tight_capacity_B`):
     a. **Relocate** sources into B (largest capacity first), subtracting tight
        capacity, until `deficit_B ≤ 0` or sources exhausted.
     b. Else **upsize** B's 2-person crews to 3-person, each adding
        `CAP3_TIGHT − CAP2_TIGHT` (~+46.75), until `deficit_B ≤ 0` or none left.
     c. Else **buy** crews: 3-person if any uncovered attributed property `> CAP2`
        (a 2-person crew can't do it in a sustainable week), else 2-person; subtract
        tight capacity until `deficit_B ≤ 0`.
   - Leftover idle crews not relocated → `redeploy_flags` (branch, count) — surfaced,
     **never auto-removed** (capex is sunk; this just flags idle rigs).
4. **Validate the proposed fleet** (current ± relocations/upsizes/adds) with
   `run_optimization` → `util_after` + routes. **Bounded refine:** if a branch's crews
   still sustain `> 55` clock-h (genuine shortfall, not a one-property artifact),
   apply one more cheapest lever at that branch and re-validate; cap at
   `_REC_MAX_RUNS` rounds / `_REC_TIME_CAP_SECONDS`. Refine **does not** chase residual
   unassigned that leaves all of a branch's crews under 40 (that's a routing artifact;
   leave as residual).
5. **Persist the what-if run** (see §4) and **build the result payload** (see §5).

The whole thing runs in the existing daemon-thread background job (acks immediately).

## 4. What-if schedule preview

The final proposed-fleet validate already produces a complete optimization result.
Persist it as a read-only run and link to it.

- **Synthetic crew names** read sensibly: `_make_rec_crew` → `"{Branch} · {size}p #{k}"`;
  relocated/upsized crews keep their real names (annotated in the changes list, not
  the run).
- **Insert an `optimization_runs` row** via a new `_supabase_insert` helper (mirror of
  `_supabase_patch`): `name = "What-if: {rec name}"`, `run_kind = 'what_if'`,
  `target_week_start_date = target_week`, `status='completed'`,
  `active_branch_ids` = real branch ids, `active_crew_ids = null`,
  `active_property_ids` = property ids, plus all result fields (`routes_jsonb`,
  `crew_utilization`, totals, `capacity_recommendation`, `recommendation_text`,
  `unassigned_property_ids`, `solver_runtime_seconds`), `started_at/completed_at/
  created_at = now`. Capture the returned `id`.
- **PATCH** `crew_recommendations` with `optimization_run_id = <id>` alongside the
  completed-status patch. If the run insert fails, the recommendation still completes;
  `optimization_run_id` stays null and the page omits the link (best-effort).

## 5. Result payload (`result_jsonb`)

```jsonc
{
  "branches": [{
    "branch_id", "branch_name",
    "demand_hours",
    "crews_before": { "two": int, "three": int },
    "crews_after":  { "two": int, "three": int },
    "util_before_pct", "util_after_pct",
    "relocated_in":  [crew_name, ...],   // crews moved into this branch
    "upsized":       int,                // 2->3 upsizes here
    "added":         { "two": int, "three": int },
    "drivers_three_person": [prop_name],  // props CAP2<labor<=CAP3
    "split_properties":     [prop_name]   // props > CAP3
  }],
  "changes": {
    "relocations": [{ "crew_name", "from_branch_name", "to_branch_name" }],
    "upsizes":     [{ "branch_name", "count" }],
    "additions":   [{ "branch_name", "size": 2|3, "count" }],
    "redeploy_flags": [{ "branch_name", "count" }]
  },
  "totals": {
    "fleet_before": int, "fleet_after": int,
    "new_crews": int,
    "capex_usd": number,                 // the input figure echoed
    "net_capital_usd": int,              // new_crews * capex_usd
    "demand_hours": number
  },
  "unattributable_property_ids": [id],
  "residual_unassigned": { "count": int, "labor_hours": number }
}
```

## 6. Migration

```sql
-- link the recommendation to its what-if run
alter table public.crew_recommendations
  add column if not exists optimization_run_id uuid
    references public.optimization_runs(id) on delete set null;

-- allow the new run_kind (existing inline check is auto-named *_run_kind_check)
alter table public.optimization_runs drop constraint if exists optimization_runs_run_kind_check;
alter table public.optimization_runs
  add constraint optimization_runs_run_kind_check
    check (run_kind in ('optimized','baseline','what_if'));
```

Paste-ready SQL included in the delivering response; run before redeploying the
solver (per deploy-workflow).

## 7. Web changes

- `src/lib/types.ts`: extend `RecommendationResult` to the §5 shape; add
  `optimization_run_id: string | null` to `CrewRecommendation`; add `'what_if'` to
  `OptimizationRun.run_kind`.
- `src/app/recommend/recommend-form.tsx`: add a **Capex per crew ($)** number input
  (default `110000`); name unchanged.
- `src/app/recommend/actions.ts`: gather **active crews** (id, name, crew_size,
  home_branch_id) in addition to branches/properties; parse `capex_usd` (default
  110000, guard ≥ 0); compute `target_week` = current week's Monday (ISO); include
  `crews`, `capex_usd`, `target_week` in the payload.
- `src/app/recommend/recommend-table.tsx`: render the delta view — a **headline**
  ("Net new capital: $110k · fleet 30 → 31"), a **changes** list (relocations $0,
  upsizes labor-only, additions $110k each, redeploy flags), a per-branch
  **before → after** util/crew table, residual unassigned, and — when
  `rec.optimization_run_id` is set — a link **"View optimized schedule for this
  fleet →"** to `/runs/<id>`.
- `src/app/runs/[runId]/page.tsx`: for `run_kind === 'what_if'`, **skip** the
  unassigned-fix card (`loadFixPlan`) — synthetic crew ids don't match the Crews
  table — and show a small banner: "What-if preview of a recommended fleet — these
  crews aren't in your Crews table." Verify the crew-meta chip degrades to name-only
  (doesn't throw) when a crew id isn't found. Day tabs / per-crew util / map / CSV
  export work unchanged off `routes_jsonb` + `crew_utilization`.
- **Mirror note:** add a comment in both `solver/api/index.py` (recommender) and
  `src/lib/unassigned-fix.ts` pointing at each other: same lever order
  (relocate → upsize → buy) and caps, mirrored across the Python/TS boundary on
  purpose (recommender needs the solver's background-job loop; unassigned-fix is a
  fast single-plan in the web). Not literally shared code.

## 8. Testing

- **Solver pure helpers** via a standalone `check_recommend_plan.py` (OR-Tools not
  needed — the planner is pure; `solve_day` import is guarded):
  - **no over-provisioning:** branch with `demand ≤ tight_capacity` and idle crews +
    unassigned routing artifact → **no add, no upsize** (St George/Dallas case).
  - **relocate-first:** a short branch with an idle crew available elsewhere → crew
    **relocated** ($0), no buy.
  - **upsize-before-buy:** short branch, no sources, has a 2-person crew → **upsize**
    (labor-only) chosen before a buy; deficit closed.
  - **buy-last:** short branch, no sources, no upsizable crews → **buy** (3-person if
    a `>CAP2` property present, else 2-person); `new_crews`/`net_capital_usd` correct.
  - **redeploy flag:** over-provisioned branch with idle crews none of which are
    needed elsewhere → `redeploy_flags` set; not removed.
  - **capex echo:** `capex_usd` from payload flows to `net_capital_usd = new_crews ×
    capex_usd`; determinism (stable ordering) across runs.
  - **name format:** `_make_rec_crew` → `"{Branch} · {size}p #{k}"`.
- **VRP end-to-end** (sane mix on real data + a linked what-if run that opens on the
  run page) — **post-deploy manual gate** (OR-Tools runs only on the deployed solver).
- **Web:** typecheck/lint/build; existing vitest stays green; `what_if` run-page
  branch + recommend form/table verified manually post-deploy.

## 9. Out of scope
- Applying the recommended fleet to the live Crews table (the unassigned-fix Apply
  flow already covers apply-and-optimize if wanted later).
- Auto-removing/selling over-provisioned crews (capex sunk; only flagged).
- Routing/geography improvements to reduce residual unassigned (the optimizer's job;
  residual is reported honestly).
- Multi-week / seasonal capex amortization, financing, ROI vs revenue — the tool
  reports capital required, not payback.

## 10. Risks / notes
- **Residual unassigned may rise** at small branches (we stop padding idle crews to
  clear routing artifacts). Intended and honest; the what-if schedule shows exactly
  which properties are unrouted.
- **Baseline + proposed validates** mean ≥2 solver runs per recommendation (plus
  bounded refine) — already within the backgrounded job's time budget
  (`_REC_TIME_CAP_SECONDS`), which acks immediately so no proxy timeout.
- **Synthetic crews on the run page** gated by `run_kind === 'what_if'`.
- **Deploy order:** run migration → redeploy solver → push web.
