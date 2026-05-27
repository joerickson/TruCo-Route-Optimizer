# Unassigned-Fix: Diagnose + Apply — Design Spec

**Date:** 2026-05-27
**Status:** Approved (design)
**Scope:** On a completed run with unassigned properties, show a concrete **fix
plan** (relocate idle crews to short branches, then add crews for any remaining
deficit) and an **Apply** action that edits the live Crews table and re-optimizes.
Turns the existing "N properties unassigned…" message into an actionable fix.

## 1. Goal

The unassigned-surfacing banner tells the user *that* work is unscheduled and the
likely cause; it doesn't tell them *what to do*. This adds:
1. a plain-language **fix plan** ("move these idle crews to branch X; add 1
   three-person crew at X; re-optimize"), and
2. an **Apply fix & re-optimize** button that applies the plan to the real fleet and
   launches a fresh optimization the user lands on.

Because the dominant cause (idle crews while work is unassigned) is a **branch
mismatch** — idle crews can't reach work near a different, maxed branch, and
cross-day rebalance only moves work across days, not branches — the fix is fleet
re-allocation: relocate idle crews to the short branch first (free), then add crews
only for what's left.

### Out of scope
- Property-side fixes (reassign a property's branch, geocode, split) — the banner
  case is "not a property problem"; deferred.
- Provably-optimal fleet design — that's the (separate) crew-mix recommender, which
  redesigns the whole fleet. This is a **minimal incremental** gap-closer for one run.
- Solver changes / migration — none. Reuses the optimize flow + existing tables.
- Undo of an applied fix beyond the normal Crews-page editing (relocations/additions
  are visible there and reversible by hand).

## 2. Background / current state

- A completed `optimization_runs` row has `unassigned_property_ids` (property-level)
  and `crew_utilization` (per crew: `crew_id`, `crew_name`, `clock_hours`). The run
  page already renders an "Unassigned" card + banner (`run-unassigned.tsx`) and a
  `loadUnassignedSummary` helper that fetches the unassigned properties.
- `properties` have `est_labor_hours`, `preferred_branch_id`, lat/lng. `branches`
  have lat/lng, is_active. `crews` have `home_branch_id`, `crew_size`,
  `max_clock_hours_per_day`, `works_*`, `is_active`.
- `src/lib/distance.ts::haversineMiles` (nearest-branch). Crew-mix recommender
  capacity model (TS mirror): 2-person ≈ 85 ph/wk, 3-person ≈ 127.5
  (`USABLE_FRACTION 0.85 × SUSTAINABLE_CLOCK_PER_WEEK 50 × size`).
- `src/app/optimize/actions.ts::startOptimization` creates an `optimization_runs`
  row (active crews/branches/properties) and fires the solver fire-and-forget. The
  Apply action reuses this flow for the re-run.
- Sustainable floor for "idle/under-utilized": `< 40` clock-hrs/wk (the
  over-provisioned band).

## 3. Model

Tunable constants (mirror the recommender; `src/lib/unassigned-fix.ts`):
`CAP2 = 85`, `CAP3 = 127.5`, `UNDERUTILIZED_CLOCK = 40`.

### 3.1 Inputs
- `unassignedProps: {id, name, est_labor_hours, preferred_branch_id, lat, lng}[]` —
  the run's unassigned properties.
- `branches: {id, name, lat, lng}[]` — active geocoded.
- `crews: {id, name, crew_size, home_branch_id, clock_hours}[]` — active crews joined
  with this run's per-crew weekly `clock_hours` (0 if a crew got no work).

### 3.2 `planUnassignedFix(unassignedProps, branches, crews) → FixPlan` (pure)
1. **Deficit per branch:** attribute each unassigned property to a branch
   (`preferred_branch_id` if active, else nearest active by Haversine); sum
   `est_labor_hours` → `deficit[branch]`. Branches with deficit > 0 are "short."
2. **Relocatable idle crews:** crews with `clock_hours < UNDERUTILIZED_CLOCK` whose
   **home branch has no deficit** (don't strip a branch that needs them). Each offers
   capacity `crew_size == 3 ? CAP3 : CAP2`.
3. **Relocate:** for each short branch (largest deficit first), pull idle crews
   (largest-capacity first) and reassign to it, subtracting their capacity from the
   branch's deficit, until the deficit is ≤ 0 or idle crews are exhausted. Record
   `relocations: [{crew_id, crew_name, from_branch_id, from_branch_name, to_branch_id,
   to_branch_name, crew_size}]`.
4. **Add for remaining deficit:** for each branch still short, repeatedly add a crew
   until `deficit <= 0`. Track that branch's unassigned properties with
   `est_labor_hours > CAP2` ("big jobs") that aren't yet covered: if any remain, add a
   **3-person** crew (capacity `CAP3`) and mark one big job covered; otherwise add a
   **2-person** crew (capacity `CAP2`). Subtract the added crew's capacity from the
   deficit each time. Aggregate into `additions: [{branch_id, branch_name, size,
   count}]` (counts per branch/size).
5. **Residual:** if no idle crews and (for the "relocate-only" exhaustion) … the plan
   always closes deficits via additions, so residual is only reported if a branch has
   deficit but **no** active branch to attribute/serve it (degenerate) — surface as
   `unresolved_branches`. Also expose `had_idle_crews: bool` so the UI can say "no
   idle crews to relocate — adding crews."

Return:
```ts
interface FixPlan {
  relocations: Relocation[];
  additions: Addition[];        // {branch_id, branch_name, size: 2|3, count}
  hadIdleCrews: boolean;
  unresolvedBranches: string[];  // branch ids with deficit but unservable (rare)
  summary: { relocatedCrews: number; addedCrews: number; shortBranches: number };
}
```
Empty plan (no relocations + no additions) when there's nothing to do.

### 3.3 Determinism
Sort branches by deficit desc, idle crews by capacity desc then name, so the plan is
stable run-to-run.

## 4. UI (run page, under the Unassigned card)

A **`UnassignedFix`** server component rendered when `unassigned_property_ids` is
non-empty (the run page computes the plan via `planUnassignedFix` using data it
already loads for the unassigned card + a crews join):
- **"Suggested fix"** heading + plain-language lines:
  - per relocation: "Move **{crew}** from {from} → {to}."
  - per addition: "Add **{count} {size}-person} crew(s)** at {branch}."
  - if `!hadIdleCrews`: a lead line "No under-utilized crews to relocate — this needs
    added capacity."
  - if `unresolvedBranches`: a note that some work can't be served from any branch.
- An **`ApplyFixButton`** (client, `useTransition`) → `applyUnassignedFix(runId)`;
  on success redirects to the new run (`/runs/<newId>`); on error shows it. Disabled
  with "Applying…" while pending. Subtext: "Relocates/adds crews on the Crews page
  and re-optimizes — reversible there."
- If the plan is empty (shouldn't happen when unassigned > 0, but e.g. all
  unresolved), show "No automatic fix available" instead of the button.

## 5. Apply action — `src/app/runs/[runId]/fix-actions.ts`

`applyUnassignedFix(runId: string): Promise<{ ok: true; run_id: string } | { ok: false; error: string }>`:
1. Load the run (`unassigned_property_ids`, `crew_utilization`), the unassigned
   properties, active branches, and active crews (with `home_branch_id`, `crew_size`).
2. Build the crew list with per-crew `clock_hours` from `crew_utilization` (0 if
   absent). **Recompute** `planUnassignedFix` server-side (don't trust any client
   input).
3. If the plan is empty → `{ ok: false, error: 'No fix to apply' }`.
4. **Relocate:** for each relocation, `UPDATE crews SET home_branch_id = to_branch_id
   WHERE id = crew_id`.
5. **Add:** for each addition (expanded to `count` crews), `INSERT` crews:
   `{ name: "{branch} crew (added by fix)", crew_size, home_branch_id: branch_id,
   max_clock_hours_per_day: 10, works_monday..friday: true, sat/sun: false,
   is_active: true }`.
6. **Re-optimize:** reuse `startOptimization`'s core — gather active crews/branches/
   geocoded-properties, insert an `optimization_runs` row (name e.g. "Re-run after
   fix"), fire the solver fire-and-forget (same as optimize). Return the new run id.
   (Refactor `startOptimization` to expose a shared helper, or call a small extracted
   `launchOptimization(name)`; avoid duplicating the solver-invoke logic.)
7. `revalidatePath('/crews')` + return `{ ok: true, run_id }`.

Uses `getServiceClient` (server-only writes). All wrapped in try/catch → structured
error.

## 6. Testing

vitest on `src/lib/unassigned-fix.ts` (pure):
- **deficit attribution:** preferred-else-nearest; per-branch sums.
- **relocate:** idle crew at a no-deficit branch is moved to the short branch; an
  idle crew whose own branch has a deficit is NOT taken; capacity subtracted; covers
  deficit when enough idle capacity exists.
- **add:** remaining deficit after relocation → correct count/size (3-person when a
  big unassigned property is present; 2-person otherwise); deficit fully closed.
- **no idle crews** → `hadIdleCrews=false`, additions only.
- **mixed** → relocations + additions; summary counts; deterministic ordering.
- **empty** (no unassigned) → empty plan.

The apply action (DB mutations + re-run) and end-to-end are verified manually
(needs the solver + live data). Page render verified manually. typecheck/lint/build.

## 7. Risks / notes

- **Analytical, solver-validated:** the plan estimates capacity (CAP2/CAP3) and
  ignores intra-branch routing; the re-run is the real test. If unassigned persists,
  re-diagnose (rare; flagged as a true shortfall). State this in the UI footnote.
- **Mutates real crews:** relocations/additions edit the live Crews table. Mitigated
  by: the plan is shown before applying, changes are visible/editable on the Crews
  page, and additions are clearly named "(added by fix)". No destructive deletes.
- **Re-run race:** Apply both mutates crews and starts a run; if the user double-
  clicks, two runs start (harmless, the latest wins on the run list). The button
  disables while pending.
- **Reuse, don't duplicate:** the Apply re-run must share `startOptimization`'s
  solver-invoke + run-insert logic (extract a helper) rather than copy it.
- **Constants** (`CAP2/CAP3/UNDERUTILIZED_CLOCK`) mirror the recommender; keep them
  consistent if the recommender's are tuned.
