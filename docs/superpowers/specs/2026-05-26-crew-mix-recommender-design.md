# Crew-Mix Recommender (solver-in-the-loop) — Design Spec

**Date:** 2026-05-26
**Status:** Approved (design)
**Scope:** Recommend **how many crews per branch and the 2-/3-person mix** that covers
the whole property portfolio at sustainable utilization for the lowest cost. An
**analytical seed** proposes a fleet; the **existing solver validates it with real
drive/routing** and a bounded loop adjusts crews until coverage + sustainable
utilization are met. Inverts the model: today crews are fixed inputs; this
recommends the fleet to run.

## 1. Goal

Per branch, output **N two-person + M three-person crews** such that every
property's labor is covered, every crew sits in the sustainable band, at the fewest
people — with the crew **count grounded in real drive time** (via the solver), not a
flat approximation, and the **mix** driven by per-property weekly capacity (a
property above a 2-person crew's weekly ceiling needs a 3-person crew).

Success: a recommendation a planner can act on, validated by the same routing engine
that runs day-to-day, with residual unassigned work (if any) flagged as a true
capacity limit.

### Out of scope
- Provably-global optimum. This is a good analytical seed + bounded solver-validated
  local search (the honest tradeoff vs a full ~50× sweep).
- Frequency-weighting demand (v1 counts every active property weekly, matching the
  solver's representative-week model; documented iterate point).
- "Suggest new branch location" (separate deferred item).
- Changing `optimize`/`evaluate` solver behavior (only an additive `time_limit`
  param, default-preserving) or the web's existing pages.

## 2. Background / current state

- Solver (`solver/api/index.py`): `run_optimization(payload{crews,branches,properties})`
  routes a representative peak week (crew-size-aware, chunked, cross-day rebalance),
  returning `crew_utilization` (per-crew weekly `clock_hours`, `util_pct`,
  `props_assigned`) + `unassigned_property_ids`. `do_POST` dispatches on
  `payload["mode"]` (`optimize` default, `evaluate`). `_crews_for_day` reads crew
  `works_<day>`, `home_branch_id`, `max_clock_hours_per_day`, `crew_size`.
  `_aggregate_result` derives `max_weekly` from `works_*` × `max_clock_hours_per_day`.
- `distance_matrix.py` has `haversine_miles(lat1,lng1,lat2,lng2)`.
- Schema: `branches`(lat/lng,is_active), `properties`(est_labor_hours, service_type,
  lat/lng, preferred_branch_id), `crews`(crew_size, max_clock_hours_per_day, works_*,
  home_branch_id). Web triggers the solver via `PYTHON_SOLVER_URL`, fire-and-forget,
  polling the result row (see `optimize/actions.ts`).
- Sustainable band (CLAUDE.md): `40–50` sustainable · `50–55` tight · `>55` add crews.

## 3. Architecture

A new **`recommend` solver mode** does the whole job in one background job; the web
triggers + polls + renders, mirroring optimization runs.

```
/recommend page → startRecommendation action:
   insert crew_recommendations row (status 'running')
   fire-and-forget POST PYTHON_SOLVER_URL {recommendation_id, mode:'recommend', branches, properties}
        (no crews — the solver synthesizes them)
        ↓ solver run_recommendation():
            seed fleet (analytical bin-pack)  →  synthetic crews
            loop (≤ MAX_RECOMMEND_RUNS, time cap):
                run_optimization({synthetic crews, branches, properties}, time_limit=REC)
                adjust crews per branch from unassigned + utilization; stop if converged
            PATCH crew_recommendations row with the final fleet + validated metrics
   page polls the row → renders recommendation
```

## 4. Solver: `recommend` mode (`solver/api/index.py`)

`do_POST` adds `mode == "recommend" → run_recommendation(payload)`.

### 4.1 Analytical seed — `_seed_fleet(properties, branches)` (pure)
- **Attribute** each active geocoded property to a branch: `preferred_branch_id` if
  that branch is active, else nearest active geocoded branch by `haversine_miles`.
  No-coords-and-no-preferred → collected as `unattributable` (excluded; surfaced).
- **Capacities** (named constants): `SUSTAINABLE_CLOCK_PER_WEEK = 50`,
  `USABLE_FRACTION = 0.85`, `REC_MAX_HOURS_PER_DAY = 10`, `REC_DAYS = 5`.
  `cap2 = USABLE_FRACTION × SUSTAINABLE_CLOCK_PER_WEEK × 2` (≈85 ph/wk);
  `cap3 = … × 3` (≈127.5).
- **Bin-pack per branch** (first-fit-decreasing, weekly_labor = est_labor_hours):
  property `> cap3` → `ceil(labor/cap3)` dedicated 3-person crews (split); `cap2 <
  labor ≤ cap3` → a 3-person crew seeded with it; `≤ cap2` → FFD into open bins (fill
  3-person bins first, else open 2-person bins). Bin type ⇒ crew size.
- Emit **synthetic crew dicts** consumable by `run_optimization`: `{id:
  f"rec-{branch_id}-{k}", name, crew_size, home_branch_id: branch_id,
  max_clock_hours_per_day: REC_MAX_HOURS_PER_DAY, works_monday..works_friday: True,
  works_saturday/sunday: False}`.

### 4.2 Validate
`run_optimization({"crews": synthetic, "branches": branches, "properties":
properties}, time_limit_seconds=REC_VALIDATE_SECONDS)`. Add an **optional
`time_limit_seconds` param to `run_optimization`** (default 8 → optimize/evaluate
unchanged) threaded through `_solve_days`→`solve_day`; recommend mode passes a
smaller value (e.g. `REC_VALIDATE_SECONDS = 5`) since we need coverage/util, not
perfect routes. Result gives per-crew `clock_hours`/`util_pct` and
`unassigned_property_ids`.

### 4.3 Adjust loop (`run_recommendation`)
Constants: `MAX_RECOMMEND_RUNS = 5`, `REC_TIME_CAP_SECONDS = 600`,
`OVER_PROVISIONED_CLOCK = 40` (a crew under this weekly is under-used).

```
fleet = _seed_fleet(properties, branches)            # synthetic crews
result = validate(fleet)
for _round in range(MAX_RECOMMEND_RUNS):
    if elapsed > REC_TIME_CAP_SECONDS: break
    unassigned_by_branch = group unassigned_property_ids → their attributed branch
    changed = False
    # 1) ADD where work is uncovered
    for branch with unassigned work:
        size = 3 if any unassigned property at that branch has labor > cap2 else 2
        append a synthetic crew of that size at the branch; changed = True
    # 2) TRIM over-provisioned branches (only when fully covered there)
    if no unassigned anywhere:
        for branch whose crews are all < OVER_PROVISIONED_CLOCK and has >1 crew:
            remove its least-loaded crew (tentative); changed = True
    if not changed: break
    result = validate(fleet)
    # guard: if a trim caused new unassigned, the next ADD step restores it; the
    #        round cap bounds oscillation.
final → per-branch counts + metrics
```

Converges to: full coverage with crews loaded ≥ sustainable floor where possible, or
the run/time cap. Residual `unassigned_property_ids` after the cap = a true capacity
limit the branch geography can't absorb (reported, not hidden).

### 4.4 Result written to `crew_recommendations`
`result_jsonb`:
```
{
  branches: [ { branch_id, branch_name, two_person, three_person, total_people,
                demand_hours, scheduled_hours, avg_util_pct,
                drivers_three_person: [property names that forced 3-person],
                split_properties: [names needing >1 crew] } ],
  totals: { two_person, three_person, total_crews, total_people, demand_hours },
  unattributable_property_ids: [...],
  residual_unassigned: { count, labor_hours },
}
```
plus `iterations`, `solver_runtime_seconds`. PATCH via the existing `_supabase_patch`
helper (extended to target `crew_recommendations`), status `completed`/`failed`.

## 5. Storage — migration (new table)

```sql
create table if not exists crew_recommendations (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  active_branch_ids uuid[],
  active_property_ids uuid[],
  config_snapshot jsonb,
  result_jsonb jsonb,
  iterations int,
  solver_runtime_seconds numeric,
  failure_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now()
);
create index if not exists crew_recommendations_created_idx
  on crew_recommendations(created_at desc);
```
Never auto-applied — paste-ready SQL ships in the implementation response; run via
`supabase db push` before deploy.

## 6. Web (`src/app/recommend/`)

- `actions.ts::startRecommendation` — insert the row (status 'running', active branch/
  property id snapshots), fire-and-forget POST to `PYTHON_SOLVER_URL` with
  `mode:'recommend'` + active branches + active geocoded properties; mirrors
  `optimize/actions.ts` (incl. failure-marking catch).
- `page.tsx` — a "Recommend fleet" button + the latest recommendation; polls while
  `running` (reuse the `RunRefresher` pattern); renders the per-branch table +
  portfolio summary + residual/unattributable notes when `completed`.
- `recommend-form.tsx` (client, useTransition) + `recommend-table.tsx`
  (presentational). Add a `Recommend` link to `top-nav.tsx`.
- A new `OptimizationRun`-like `CrewRecommendation` type in `src/lib/types.ts`.

## 7. Testing

Pure Python checks (no OR-Tools, via a `solver/api/check_recommend.py` script):
- `_attribute_to_branches`: preferred honored, else nearest by haversine,
  unattributable collected.
- seed bin-pack: all-small → only 2-person crews, all labor covered; a `cap2<labor≤
  cap3` property → a 3-person crew; oversize (Canyon Park 132.6 > cap3) → split into
  `ceil` 3-person crews; synthetic crew dicts have the fields `run_optimization`
  needs (`works_*`, `home_branch_id`, `crew_size`, `max_clock_hours_per_day`).
- the per-round adjust decision (pure helper): given unassigned-by-branch +
  per-crew utilization, decides correct add (size) / trim per branch.
The validate loop (calls `run_optimization`→OR-Tools) and end-to-end are **post-deploy**
gates (OR-Tools not installed locally) — parse-check + the pure checks locally.
Web: typecheck/lint/build; page + poll verified manually post-deploy.

## 8. Risks / iterate points

- **Runtime:** ≤ `MAX_RECOMMEND_RUNS` (5) full solves at `REC_VALIDATE_SECONDS` (5)
  per day ⇒ ~5–12 min. Background job; UI says "this takes several minutes." Bounded
  by run count + `REC_TIME_CAP_SECONDS`.
- **Capacity constants** (`SUSTAINABLE_CLOCK_PER_WEEK`, `USABLE_FRACTION`,
  `OVER_PROVISIONED_CLOCK`) — tune against real recommendations; centralized.
- **Weekly demand** counts every property weekly (conservative; matches solver).
  Frequency-weighting is the likely first iteration.
- **Local search, not global optimum** — good seed + bounded adjust; could miss a
  cheaper mix. Acceptable for a planning recommendation; documented.
- **Trim oscillation** — removing a crew may reintroduce unassigned, which the next
  round re-adds; the round cap bounds it, final state always reflects the last
  validate (so a bad trim can't ship as "covered" unless re-validated clean).
- **New table + solver redeploy + migration** — three deploy steps; surface clearly.
