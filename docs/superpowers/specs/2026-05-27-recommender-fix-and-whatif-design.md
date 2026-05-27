# Recommender Logic Fix + What-If Schedule Preview — Design Spec

**Date:** 2026-05-27
**Status:** Proposed (design)
**Scope:** Two related changes to the crew-mix recommender:
1. **Demand-anchor the crew count** so it stops over-provisioning small branches
   (the bug: St George 78 h/wk → 5 crews @ 21%, Dallas 77 h/wk → 5 @ 14%).
2. **Persist the recommender's final validated schedule** as a viewable, read-only
   "what-if" optimization run, linked from `/recommend`, so the user can see the
   day-by-day schedule the recommended mix produces — without touching the live fleet.

Both ship together (one solver redeploy + one migration).

## 1. Problem

`run_recommendation` seeds an analytical fleet (bin-pack each branch's demand into
2-/3-person crews), then runs a bounded validate-and-adjust loop calling
`run_optimization` and applying `_recommend_adjustments`. Two flaws make it
over-provision small branches:

- **Adds are artifact-driven, not capacity-driven.** `_recommend_adjustments`
  (`solver/api/index.py:413-415`) adds a crew to any branch with *any* unassigned
  property after a validate run. At a small branch, unassigned is almost always a
  per-day VRP/day-packing artifact (a property landing on a day the lone crew can't
  reach, same-day-of-week soft constraint), **not** a capacity gap — 78 h of demand
  vs ~85 h of one crew's capacity is plenty. The loop adds a crew anyway, every
  round, up to `_REC_MAX_RUNS=5` → 1 seed + 4 adds = 5 crews at ~20% util. More idle
  crews never resolve a routing artifact.
- **Trim is globally gated.** The trim path only fires `if not unassigned_ids:`
  (`index.py:418`) — i.e. only when *zero* properties are unassigned *anywhere*. One
  genuinely hard property elsewhere (e.g. Canyon Park) keeps the global list
  non-empty forever, so over-provisioned small branches are never trimmed.

## 2. Fix #1 — demand-anchored add/trim (`_recommend_adjustments`)

Constants (unchanged): `CAP2≈85`, `CAP3≈127.5` person-h/wk, sustainable `50`,
over-provisioned floor `_REC_OVER_PROVISIONED_CLOCK=40`.

Per branch B, define from the last validate result:
- `capacity_B = Σ (CAP3 if crew is 3-person else CAP2)` over B's crews.
- `demand_B = Σ est_labor_hours` of B's attributed properties.
- `maxclock_B = max(clock_hours)` over B's crews (0 if none); `busy` ⇔ `maxclock_B ≥
  _REC_SUSTAINABLE_CLOCK_PER_WEEK (50)`; `idle` ⇔ every crew at B `< 40`.

**Add** a crew to B (only when B has unassigned attributed work) **iff** B is
genuinely capacity-short:
- `capacity_B < demand_B` (raw shortage), **or**
- `busy` (B's crews are actually near the sustainable ceiling, so capacity is the
  binding constraint).

If B has unassigned work but is **not** capacity-short and **not** busy (its crews
sit under 40 h while work is unassigned) → **do not add**; it's a routing artifact,
left as residual. Size of an added crew: 3-person iff any *uncovered* property at B
exceeds `CAP2`, else 2-person (unchanged rule).

**Trim** one crew from B (independent of global unassigned) **iff**: B has `>1` crew,
B is `idle` (all crews `< 40`), **and** dropping the least-utilized crew keeps
`capacity_B − dropped_cap ≥ demand_B`. Remove the least-utilized crew. (The
40↔50 gap gives hysteresis so add/trim can't oscillate.)

Loop still terminates on "no adds and no removes," `_REC_MAX_RUNS`, or
`_REC_TIME_CAP_SECONDS`. Result on the user's data: St George and Dallas converge to
**1 crew each**; SLC HQ / Lindon are unchanged.

## 3. Fix #2 — what-if schedule preview

The final validate already produces a complete optimization result (routes,
per-crew utilization, totals, capacity band, unassigned) for the recommended fleet.
We persist it as a read-only run and link to it.

### 3.1 Synthetic crews readable on the run page
`_make_rec_crew` names become `"{Branch name} · {size}p #{k}"` (e.g. "Lindon Branch
· 3p #1") so the schedule's per-crew rows read sensibly. (Branch name is available
in `run_recommendation`.)

### 3.2 Persist the run (solver)
After the loop settles on the final fleet, `run_recommendation`:
1. Runs one final `validate(final_fleet)` (so the persisted run matches the
   recommended mix exactly).
2. **INSERTs an `optimization_runs` row** via REST (new `_supabase_insert` helper,
   mirror of `_supabase_patch`) with: `name = "What-if: {rec name}"`,
   `run_kind = 'what_if'`, `target_week_start_date` (from payload; see 3.4),
   `status = 'completed'`, `active_branch_ids` = real branch ids,
   `active_crew_ids = null` (synthetic), `active_property_ids` = property ids, and
   all result fields from the validate (`routes_jsonb`, `crew_utilization`, totals,
   `capacity_recommendation`, `recommendation_text`, `unassigned_property_ids`,
   `solver_runtime_seconds`), `started_at`/`completed_at`/`created_at = now`.
   Capture the returned `id`.
3. PATCHes `crew_recommendations` with `optimization_run_id = <that id>` (in addition
   to the existing completed-status patch).

If the run insert fails, the recommendation still completes (the link is best-effort;
`optimization_run_id` stays null and the page just omits the link).

### 3.3 Migration
```sql
alter table public.crew_recommendations
  add column if not exists optimization_run_id uuid references public.optimization_runs(id) on delete set null;

alter table public.optimization_runs drop constraint if exists optimization_runs_run_kind_check;
alter table public.optimization_runs
  add constraint optimization_runs_run_kind_check check (run_kind in ('optimized','baseline','what_if'));
```
(The `run_kind` check is recreated to allow `'what_if'`; the exact existing
constraint name is verified against `20260526000000_run_kind.sql` during planning.)

### 3.4 target_week
The recommendation is peak-week-agnostic, but `optimization_runs.target_week_start_date`
is required. The web passes `target_week` (the current week's Monday, computed in the
action) in the recommend payload; the solver uses it for the persisted run.

### 3.5 Web
- `src/lib/types.ts`: add `optimization_run_id: string | null` to `CrewRecommendation`;
  add `'what_if'` to `OptimizationRun.run_kind`.
- `src/app/recommend/actions.ts`: include `target_week` in the recommend payload.
- `src/app/recommend/page.tsx` / `recommend-table.tsx`: when
  `rec.optimization_run_id` is set, render a link **"View optimized schedule for this
  fleet →"** to `/runs/<id>`.
- `src/app/runs/[runId]/page.tsx`: for `run_kind === 'what_if'`, **skip the
  unassigned-fix card** (`loadFixPlan`) — synthetic crew ids don't match the live
  Crews table, so a fix plan would be bogus. Show a small banner: "What-if preview of
  a recommended fleet — these crews aren't in your Crews table." The crew-meta chip
  ("SLC · 3p") already degrades to name-only when a crew id isn't found; verify it
  doesn't throw. Day tabs, per-crew util, map, CSV export work unchanged off
  `routes_jsonb` / `crew_utilization`.

## 4. Out of scope
- Applying the recommended fleet to the live Crews table (the rejected option; the
  unassigned-fix Apply already covers an apply-and-optimize flow if wanted later).
- Per-property reassignment, geography/routing improvements to reduce residual
  unassigned (the recommender reports residual honestly; routing is the optimizer's
  job).
- Changing the analytical seed / bin-pack (it's correct; only the loop's add/trim
  rules change).

## 5. Testing
- **Solver pure helpers** (no OR-Tools needed): a `check_recommend_adjustments.py`
  standalone script exercising `_recommend_adjustments` with crafted
  fleet/util/unassigned inputs:
  - under-utilized branch with unassigned work + capacity ≥ demand → **no add**.
  - capacity-short branch (capacity < demand) with unassigned → **add** (size 3 if a
    big uncovered property, else 2).
  - busy branch (crew ≥ 50) with unassigned + capacity ≥ demand → **add**.
  - over-provisioned branch (`>1` crew, all < 40, capacity−least ≥ demand) → **trim**
    least-utilized, regardless of global unassigned.
  - no oscillation: a branch at 1 crew, idle, capacity ≥ demand → neither add nor trim.
- **Solver name change**: `check` script asserts `_make_rec_crew` name format.
- **VRP end-to-end** (recommend produces a sane mix + a linked what-if run that opens
  on the run page) is a **post-deploy manual gate** (OR-Tools runs only on the
  deployed solver).
- **Web**: typecheck/lint/build; existing vitest stays green; run-page `what_if`
  branch verified manually post-deploy.

## 6. Risks / notes
- **Residual unassigned may rise** for small branches (we no longer brute-force-add
  crews to clear routing artifacts). That's intended and honest; the what-if schedule
  shows exactly which properties are unrouted so the user sees it's a routing/geography
  issue, not a fleet-size one.
- **Synthetic crews on the run page**: gated by `run_kind === 'what_if'`; the fix card
  is suppressed and the page must not assume every crew id exists in the Crews table.
- **Migration + solver redeploy required** before the web change is useful; deploy
  order: run migration → redeploy solver → push web (per deploy-workflow memory).
- **Constants** stay shared with `src/lib/unassigned-fix.ts` (CAP2/CAP3/floor); keep
  consistent if tuned.
