# Unassigned-Fix (diagnose + apply) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a completed run with unassigned properties, show a concrete fix plan (relocate idle crews to short branches, then add crews) and an "Apply fix & re-optimize" button that edits the live Crews table and launches a fresh optimization.

**Architecture:** A pure `planUnassignedFix` lib computes the plan from the run's unassigned set + crew utilization. The run page renders the plan + an Apply button. `applyUnassignedFix` recomputes server-side, mutates crews, and re-optimizes via a `launchOptimization` helper extracted from `startOptimization`. Web + existing solver only.

**Tech Stack:** Next.js App Router (server components, server actions), TypeScript, Supabase. Pure planner unit-tested with vitest; the apply action + re-run verified manually (needs solver + live data).

---

## File Structure

- `src/lib/unassigned-fix.ts` — **Create:** pure `planUnassignedFix` + types + constants.
- `src/lib/unassigned-fix.test.ts` — **Create:** vitest.
- `src/app/optimize/actions.ts` — **Modify:** extract `launchOptimization(name, targetWeek)`; `startOptimization` delegates.
- `src/app/runs/[runId]/fix-actions.ts` — **Create:** `applyUnassignedFix(runId)`.
- `src/app/runs/[runId]/run-unassigned.tsx` — **Modify:** add `UnassignedFix` server component (plan display).
- `src/app/runs/[runId]/apply-fix-button.tsx` — **Create:** client Apply button.
- `src/app/runs/[runId]/page.tsx` — **Modify:** `loadFixPlan` + render `UnassignedFix` under the unassigned card.

No solver change, no migration.

---

## Task 1: `planUnassignedFix` pure planner (TDD)

**Files:** Create `src/lib/unassigned-fix.ts`; Create `src/lib/unassigned-fix.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/lib/unassigned-fix.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planUnassignedFix, FIX_CAP2, FIX_CAP3 } from './unassigned-fix';
import type { FixUnassignedProp, FixBranch, FixCrew } from './unassigned-fix';

const branches: FixBranch[] = [
  { id: 'slc', name: 'SLC', lat: 40.76, lng: -111.89 },
  { id: 'provo', name: 'Provo', lat: 40.23, lng: -111.66 },
];
function prop(id: string, hrs: number, pref: string | null, lat = 40.24, lng = -111.65): FixUnassignedProp {
  return { id, name: id, est_labor_hours: hrs, preferred_branch_id: pref, lat, lng };
}
function crew(id: string, size: number, home: string, clock: number): FixCrew {
  return { id, name: id, crew_size: size, home_branch_id: home, clock_hours: clock };
}

describe('planUnassignedFix', () => {
  it('relocates an idle crew from a no-deficit branch to the short branch', () => {
    // Deficit at provo (one 50-hr unassigned prop, preferred provo). SLC crew idle (10h), SLC has no deficit.
    const plan = planUnassignedFix(
      [prop('p1', 50, 'provo')],
      branches,
      [crew('slc-1', 2, 'slc', 10), crew('provo-1', 2, 'provo', 50)],
    );
    expect(plan.relocations).toHaveLength(1);
    expect(plan.relocations[0]).toMatchObject({ crew_id: 'slc-1', from_branch_id: 'slc', to_branch_id: 'provo' });
    expect(plan.additions).toHaveLength(0); // 50 <= CAP2(85), one relocated 2-person covers it
    expect(plan.hadIdleCrews).toBe(true);
  });

  it('does NOT take an idle crew whose own branch has a deficit', () => {
    // Both branches short; the only idle crew is at provo which itself has deficit -> not relocatable.
    const plan = planUnassignedFix(
      [prop('a', 40, 'slc'), prop('b', 40, 'provo')],
      branches,
      [crew('provo-1', 2, 'provo', 10)],
    );
    expect(plan.relocations).toHaveLength(0);
    expect(plan.hadIdleCrews).toBe(false);
    // both branches get an added 2-person crew (40 <= CAP2)
    expect(plan.additions.reduce((s, a) => s + a.count, 0)).toBe(2);
  });

  it('adds a 3-person crew when a big job (> CAP2) is unassigned, else 2-person', () => {
    const plan = planUnassignedFix(
      [prop('big', 120, 'slc')], // 85 < 120 <= 127.5 -> needs a 3-person
      branches,
      [], // no idle crews
    );
    expect(plan.hadIdleCrews).toBe(false);
    expect(plan.additions).toEqual([{ branch_id: 'slc', branch_name: 'SLC', size: 3, count: 1 }]);
  });

  it('attributes by nearest branch when no preferred', () => {
    const plan = planUnassignedFix(
      [prop('n', 40, null, 40.76, -111.89)], // nearest = slc
      branches,
      [],
    );
    expect(plan.additions[0].branch_id).toBe('slc');
  });

  it('returns an empty plan when nothing is unassigned', () => {
    const plan = planUnassignedFix([], branches, [crew('slc-1', 2, 'slc', 10)]);
    expect(plan.relocations).toHaveLength(0);
    expect(plan.additions).toHaveLength(0);
    expect(plan.summary.shortBranches).toBe(0);
  });

  it('relocates first, then adds for the remainder', () => {
    // provo deficit 200; one idle 2-person at slc (cap 85) relocates; remainder ~115 -> 2x 2-person (85+85>=115)
    const plan = planUnassignedFix(
      [prop('p', 200, 'provo')],
      branches,
      [crew('slc-1', 2, 'slc', 5)],
    );
    expect(plan.relocations).toHaveLength(1);
    const added = plan.additions.reduce((s, a) => s + a.count, 0);
    expect(added).toBeGreaterThanOrEqual(1);
    // total capacity (relocated + added) covers 200
    const cap = 85 + plan.additions.reduce((s, a) => s + a.count * (a.size === 3 ? FIX_CAP3 : FIX_CAP2), 0);
    expect(cap).toBeGreaterThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/unassigned-fix.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** — `src/lib/unassigned-fix.ts`:

```ts
// Pure planner: turn a completed run's unassigned properties into a concrete fix
// (relocate idle crews to short branches, then add crews for the remainder). No IO.
import { haversineMiles } from './distance';

// Sustainable weekly capacities (mirror the crew-mix recommender) + idle threshold.
export const FIX_CAP2 = 85; // 2-person person-hours/wk
export const FIX_CAP3 = 127.5; // 3-person
export const FIX_UNDERUTILIZED_CLOCK = 40; // a crew under this weekly clock is idle

export interface FixUnassignedProp {
  id: string;
  name: string;
  est_labor_hours: number;
  preferred_branch_id: string | null;
  lat: number | null;
  lng: number | null;
}
export interface FixBranch {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
export interface FixCrew {
  id: string;
  name: string;
  crew_size: number;
  home_branch_id: string;
  clock_hours: number;
}

export interface Relocation {
  crew_id: string;
  crew_name: string;
  crew_size: number;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
}
export interface Addition {
  branch_id: string;
  branch_name: string;
  size: 2 | 3;
  count: number;
}
export interface FixPlan {
  relocations: Relocation[];
  additions: Addition[];
  hadIdleCrews: boolean;
  unresolvedPropertyIds: string[];
  summary: { relocatedCrews: number; addedCrews: number; shortBranches: number };
}

function attributeBranch(
  p: FixUnassignedProp,
  branchById: Record<string, FixBranch>,
  branches: FixBranch[]
): string | null {
  if (p.preferred_branch_id && branchById[p.preferred_branch_id]) return p.preferred_branch_id;
  if (p.lat == null || p.lng == null || branches.length === 0) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of branches) {
    const d = haversineMiles({ lat: p.lat, lng: p.lng }, { lat: b.lat, lng: b.lng });
    if (d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
}

export function planUnassignedFix(
  unassigned: FixUnassignedProp[],
  branches: FixBranch[],
  crews: FixCrew[]
): FixPlan {
  const branchById: Record<string, FixBranch> = Object.fromEntries(branches.map((b) => [b.id, b]));

  // 1. Deficit per branch + count of big jobs (> CAP2) per branch.
  const deficit: Record<string, number> = {};
  const bigJobs: Record<string, number> = {};
  const unresolvedPropertyIds: string[] = [];
  for (const p of unassigned) {
    const bid = attributeBranch(p, branchById, branches);
    if (!bid) {
      unresolvedPropertyIds.push(p.id);
      continue;
    }
    deficit[bid] = (deficit[bid] ?? 0) + p.est_labor_hours;
    if (p.est_labor_hours > FIX_CAP2) bigJobs[bid] = (bigJobs[bid] ?? 0) + 1;
  }
  const shortBranches = Object.keys(deficit).filter((b) => deficit[b] > 1e-9);

  // 2. Idle crews whose home branch has NO deficit (don't strip a branch that needs them),
  //    largest-capacity first (then name) for determinism.
  const idle = crews
    .filter((c) => c.clock_hours < FIX_UNDERUTILIZED_CLOCK && !(deficit[c.home_branch_id] > 1e-9))
    .sort((a, b) => (b.crew_size - a.crew_size) || a.name.localeCompare(b.name));
  const hadIdleCrews = idle.length > 0;

  const remaining: Record<string, number> = { ...deficit };
  const relocations: Relocation[] = [];
  let idleIdx = 0;

  // 3. Relocate idle crews into short branches (largest deficit first).
  for (const bid of [...shortBranches].sort((a, b) => remaining[b] - remaining[a])) {
    while (remaining[bid] > 1e-9 && idleIdx < idle.length) {
      const c = idle[idleIdx++];
      relocations.push({
        crew_id: c.id,
        crew_name: c.name,
        crew_size: c.crew_size,
        from_branch_id: c.home_branch_id,
        from_branch_name: branchById[c.home_branch_id]?.name ?? c.home_branch_id,
        to_branch_id: bid,
        to_branch_name: branchById[bid].name,
      });
      remaining[bid] -= c.crew_size === 3 ? FIX_CAP3 : FIX_CAP2;
    }
  }

  // 4. Add crews for the remaining deficit (3-person while big jobs remain, else 2-person).
  const additions: Addition[] = [];
  for (const bid of shortBranches) {
    let bigLeft = bigJobs[bid] ?? 0;
    let two = 0;
    let three = 0;
    while (remaining[bid] > 1e-9) {
      if (bigLeft > 0) {
        three += 1;
        bigLeft -= 1;
        remaining[bid] -= FIX_CAP3;
      } else {
        two += 1;
        remaining[bid] -= FIX_CAP2;
      }
    }
    if (three > 0) additions.push({ branch_id: bid, branch_name: branchById[bid].name, size: 3, count: three });
    if (two > 0) additions.push({ branch_id: bid, branch_name: branchById[bid].name, size: 2, count: two });
  }

  return {
    relocations,
    additions,
    hadIdleCrews,
    unresolvedPropertyIds,
    summary: {
      relocatedCrews: relocations.length,
      addedCrews: additions.reduce((s, a) => s + a.count, 0),
      shortBranches: shortBranches.length,
    },
  };
}
```

- [ ] **Step 4: Run** — `npx vitest run src/lib/unassigned-fix.test.ts` → all pass. `npm run typecheck && npm run lint` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/unassigned-fix.ts src/lib/unassigned-fix.test.ts
git commit -m "feat: planUnassignedFix pure planner (relocate idle crews + add)"
```

---

## Task 2: Extract `launchOptimization` from `startOptimization`

**Files:** Modify `src/app/optimize/actions.ts`.

- [ ] **Step 1: Refactor** — replace `startOptimization` with a thin wrapper + an exported `launchOptimization(name, targetWeek)` carrying the gather/insert/fire-and-forget. The new top of the file:

```ts
export async function startOptimization(formData: FormData) {
  const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim() || `Run ${new Date().toISOString().slice(0, 16)}`;
  if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };
  return launchOptimization(name, targetWeek);
}

export async function launchOptimization(
  name: string,
  targetWeek: string
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const supabase = getServiceClient();

  const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
    supabase.from('crews').select('*').eq('is_active', true),
    supabase.from('branches').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
    supabase.from('properties').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Branch[];
  const properties = (propsData ?? []) as Property[];

  if (crews.length === 0) return { ok: false, error: 'No active crews configured' };
  if (branches.length === 0) return { ok: false, error: 'No active geocoded branches configured (check Branches page)' };
  if (properties.length === 0) return { ok: false, error: 'No geocoded active properties' };

  const { data: run, error: runErr } = await supabase
    .from('optimization_runs')
    .insert({
      name,
      target_week_start_date: targetWeek,
      active_branch_ids: branches.map((b) => b.id),
      active_crew_ids: crews.map((c) => c.id),
      active_property_ids: properties.map((p) => p.id),
      config_snapshot: { crew_count: crews.length, property_count: properties.length },
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runErr || !run) return { ok: false, error: runErr?.message ?? 'Could not create run' };

  void invokeSolver(run.id, { crews, branches, properties }).catch(async (e) => {
    await supabase
      .from('optimization_runs')
      .update({
        status: 'failed',
        failure_reason: e instanceof Error ? e.message : String(e),
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id);
  });

  revalidatePath('/optimize');
  return { ok: true, run_id: run.id };
}
```
Leave `invokeSolver` unchanged (still used by `launchOptimization`). The behavior of `startOptimization` is identical — it just delegates.

- [ ] **Step 2: Verify** — `npm run typecheck && npm run lint && npm run test` → clean/green. `npm run build` → compiles (the `/optimize` form still calls `startOptimization`).

- [ ] **Step 3: Commit**

```bash
git add src/app/optimize/actions.ts
git commit -m "refactor: extract launchOptimization(name, targetWeek) from startOptimization"
```

---

## Task 3: `applyUnassignedFix` action

**Files:** Create `src/app/runs/[runId]/fix-actions.ts`.

- [ ] **Step 1: Implement** — `src/app/runs/[runId]/fix-actions.ts`:

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { launchOptimization } from '@/app/optimize/actions';
import { planUnassignedFix, type FixUnassignedProp, type FixBranch, type FixCrew } from '@/lib/unassigned-fix';
import type { OptimizationRun, CrewUtilization } from '@/lib/types';

export type ApplyFixResult = { ok: true; run_id: string } | { ok: false; error: string };

const REC_MAX_HOURS_PER_DAY = 10;

export async function applyUnassignedFix(runId: string): Promise<ApplyFixResult> {
  try {
    const supabase = getServiceClient();

    const { data: runData, error: runErr } = await supabase
      .from('optimization_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();
    if (runErr || !runData) return { ok: false, error: runErr?.message ?? 'Run not found' };
    const run = runData as OptimizationRun;
    const targetWeek = run.target_week_start_date;
    const unassignedIds = run.unassigned_property_ids ?? [];
    if (unassignedIds.length === 0) return { ok: false, error: 'Nothing unassigned to fix' };

    // Load unassigned properties, active branches, active crews.
    const [{ data: propRows }, { data: branchRows }, { data: crewRows }] = await Promise.all([
      supabase.from('properties').select('id, name, est_labor_hours, preferred_branch_id, lat, lng').in('id', unassignedIds),
      supabase.from('branches').select('id, name, lat, lng').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('crews').select('id, name, crew_size, home_branch_id').eq('is_active', true),
    ]);

    const unassigned: FixUnassignedProp[] = ((propRows ?? []) as Array<{
      id: string; name: string; est_labor_hours: number | string | null; preferred_branch_id: string | null;
      lat: number | string | null; lng: number | string | null;
    }>).map((p) => ({
      id: p.id, name: p.name, est_labor_hours: Number(p.est_labor_hours) || 0,
      preferred_branch_id: p.preferred_branch_id ?? null,
      lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng),
    }));
    const branches: FixBranch[] = ((branchRows ?? []) as Array<{ id: string; name: string; lat: number | string; lng: number | string }>)
      .map((b) => ({ id: b.id, name: b.name, lat: Number(b.lat), lng: Number(b.lng) }));

    const clockByCrew: Record<string, number> = {};
    for (const u of (run.crew_utilization ?? []) as CrewUtilization[]) clockByCrew[u.crew_id] = u.clock_hours;
    const crews: FixCrew[] = ((crewRows ?? []) as Array<{ id: string; name: string; crew_size: number | string | null; home_branch_id: string }>)
      .map((c) => ({
        id: c.id, name: c.name, crew_size: Number(c.crew_size) || 2, home_branch_id: c.home_branch_id,
        clock_hours: clockByCrew[c.id] ?? 0,
      }));

    const plan = planUnassignedFix(unassigned, branches, crews);
    if (plan.relocations.length === 0 && plan.additions.length === 0) {
      return { ok: false, error: 'No fix to apply (no idle crews to relocate and nothing to add)' };
    }

    // Relocate: change home_branch_id for each relocated crew.
    for (const r of plan.relocations) {
      const { error } = await supabase.from('crews').update({ home_branch_id: r.to_branch_id }).eq('id', r.crew_id);
      if (error) throw new Error(`Relocate ${r.crew_name}: ${error.message}`);
    }

    // Add: insert new crews (expanded from aggregate counts).
    const newCrews: Array<Record<string, unknown>> = [];
    for (const a of plan.additions) {
      for (let i = 0; i < a.count; i++) {
        newCrews.push({
          name: `${a.branch_name} crew (added by fix)`,
          crew_size: a.size,
          home_branch_id: a.branch_id,
          max_clock_hours_per_day: REC_MAX_HOURS_PER_DAY,
          works_monday: true, works_tuesday: true, works_wednesday: true,
          works_thursday: true, works_friday: true, works_saturday: false, works_sunday: false,
          is_active: true,
        });
      }
    }
    if (newCrews.length > 0) {
      const { error } = await supabase.from('crews').insert(newCrews);
      if (error) throw new Error(`Add crews: ${error.message}`);
    }

    revalidatePath('/crews');

    // Re-optimize against the now-updated fleet, carrying the original target week.
    const launched = await launchOptimization(`Re-run after fix · ${run.name}`, targetWeek);
    if (!launched.ok) return { ok: false, error: `Crews updated, but re-run failed: ${launched.error}` };
    return { ok: true, run_id: launched.run_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 2: Verify** — `npm run typecheck && npm run lint` → clean. (`crews` table columns used — `home_branch_id`, `crew_size`, `works_*`, `max_clock_hours_per_day`, `is_active`, `name` — all exist per the init migration.)

- [ ] **Step 3: Commit**

```bash
git add src/app/runs/[runId]/fix-actions.ts
git commit -m "feat: applyUnassignedFix action (relocate/add crews + re-optimize)"
```

---

## Task 4: Run-page UI — fix plan + Apply button

**Files:** Create `src/app/runs/[runId]/apply-fix-button.tsx`; Modify `src/app/runs/[runId]/run-unassigned.tsx`; Modify `src/app/runs/[runId]/page.tsx`.

- [ ] **Step 1: `apply-fix-button.tsx` (client)**

```tsx
'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { applyUnassignedFix } from './fix-actions';

export function ApplyFixButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r = await applyUnassignedFix(runId);
            if (r.ok) router.push(`/runs/${r.run_id}`);
            else setError(r.error);
          })
        }
        disabled={pending}
      >
        {pending ? 'Applying…' : 'Apply fix & re-optimize'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Add `UnassignedFix` to `run-unassigned.tsx`**

Add the import at the top: `import { ApplyFixButton } from './apply-fix-button';` and `import type { FixPlan } from '@/lib/unassigned-fix';`. Then append this server component:

```tsx
export function UnassignedFix({ plan, runId }: { plan: FixPlan; runId: string }) {
  const nothing = plan.relocations.length === 0 && plan.additions.length === 0;
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle>Suggested fix</CardTitle>
        <CardDescription>
          {nothing
            ? 'No automatic fix available for this run.'
            : 'Relocate under-utilized crews to the short branch(es), then add crews where needed, and re-optimize.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!plan.hadIdleCrews && !nothing && (
          <p className="text-muted-foreground">No under-utilized crews to relocate — this needs added capacity.</p>
        )}
        <ul className="list-disc space-y-1 pl-5">
          {plan.relocations.map((r) => (
            <li key={r.crew_id}>
              Move <strong>{r.crew_name}</strong> ({r.crew_size}-person) from {r.from_branch_name} → {r.to_branch_name}.
            </li>
          ))}
          {plan.additions.map((a) => (
            <li key={`${a.branch_id}-${a.size}`}>
              Add <strong>{a.count} {a.size}-person crew{a.count === 1 ? '' : 's'}</strong> at {a.branch_name}.
            </li>
          ))}
        </ul>
        {plan.unresolvedPropertyIds.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {plan.unresolvedPropertyIds.length} unassigned propert
            {plan.unresolvedPropertyIds.length === 1 ? 'y' : 'ies'} couldn&rsquo;t be attributed to a branch and aren&rsquo;t covered by this fix.
          </p>
        )}
        {!nothing && <ApplyFixButton runId={runId} />}
        {!nothing && (
          <p className="text-xs text-muted-foreground">
            Applies these changes to the Crews page (reversible there) and starts a fresh optimization. The new run is
            the real test — capacity here is estimated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Wire into `page.tsx`** — add a `loadFixPlan` helper and render `UnassignedFix` after the `UnassignedCard` in `CompletedRun`.

Add imports:
```ts
import { UnassignedFix } from './run-unassigned';
import { planUnassignedFix, type FixPlan, type FixUnassignedProp, type FixBranch, type FixCrew } from '@/lib/unassigned-fix';
```
Add the loader (next to `loadUnassignedSummary`):
```ts
async function loadFixPlan(
  supabase: ReturnType<typeof getServerClient>,
  run: OptimizationRun
): Promise<FixPlan | null> {
  const unassignedIds = run.unassigned_property_ids ?? [];
  if (unassignedIds.length === 0) return null;

  const [{ data: propRows }, { data: branchRows }, { data: crewRows }] = await Promise.all([
    supabase.from('properties').select('id, name, est_labor_hours, preferred_branch_id, lat, lng').in('id', unassignedIds),
    supabase.from('branches').select('id, name, lat, lng').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
    supabase.from('crews').select('id, name, crew_size, home_branch_id').eq('is_active', true),
  ]);

  const unassigned: FixUnassignedProp[] = ((propRows ?? []) as Array<{
    id: string; name: string; est_labor_hours: number | string | null; preferred_branch_id: string | null;
    lat: number | string | null; lng: number | string | null;
  }>).map((p) => ({
    id: p.id, name: p.name, est_labor_hours: Number(p.est_labor_hours) || 0,
    preferred_branch_id: p.preferred_branch_id ?? null,
    lat: p.lat == null ? null : Number(p.lat), lng: p.lng == null ? null : Number(p.lng),
  }));
  const branches: FixBranch[] = ((branchRows ?? []) as Array<{ id: string; name: string; lat: number | string; lng: number | string }>)
    .map((b) => ({ id: b.id, name: b.name, lat: Number(b.lat), lng: Number(b.lng) }));
  const clockByCrew: Record<string, number> = {};
  for (const u of run.crew_utilization ?? []) clockByCrew[u.crew_id] = u.clock_hours;
  const crews: FixCrew[] = ((crewRows ?? []) as Array<{ id: string; name: string; crew_size: number | string | null; home_branch_id: string }>)
    .map((c) => ({ id: c.id, name: c.name, crew_size: Number(c.crew_size) || 2, home_branch_id: c.home_branch_id, clock_hours: clockByCrew[c.id] ?? 0 }));

  return planUnassignedFix(unassigned, branches, crews);
}
```
In `RunPage`, after `const unassignedSummary = ...`, add:
```ts
  const fixPlan = run.status === 'completed' ? await loadFixPlan(supabase, run) : null;
```
Pass it to `CompletedRun`: change `<CompletedRun run={run} crewMeta={crewMeta} unassigned={unassignedSummary} />` to `<CompletedRun run={run} crewMeta={crewMeta} unassigned={unassignedSummary} fixPlan={fixPlan} />`.
Update `CompletedRun`'s signature to add `fixPlan: FixPlan | null` and render the fix right after the existing `{unassigned && unassigned.count > 0 && <UnassignedCard summary={unassigned} />}` line:
```tsx
      {unassigned && unassigned.count > 0 && <UnassignedCard summary={unassigned} />}
      {fixPlan && <UnassignedFix plan={fixPlan} runId={run.id} />}
```

- [ ] **Step 4: Verify** — `npm run typecheck && npm run lint && npm run test && npm run build` → clean/green; `/runs/[runId]` compiles.

- [ ] **Step 5: Commit**

```bash
git add "src/app/runs/[runId]/apply-fix-button.tsx" "src/app/runs/[runId]/run-unassigned.tsx" "src/app/runs/[runId]/page.tsx"
git commit -m "feat(runs): show suggested unassigned-fix plan + Apply button"
```

---

## Task 5: Full verification + manual checklist

- [ ] **Step 1: Local** — `npm run test` (incl. the new unassigned-fix suite), `npm run typecheck`, `npm run lint`, `npm run build` → all clean/green.

- [ ] **Step 2: Manual (after deploy — web-only, no migration/solver change)**

On a completed run with unassigned properties:
1. The "Suggested fix" card appears under the Unassigned card with relocation/addition lines.
2. If idle crews exist at a no-deficit branch, they're listed as relocations; otherwise it says "needs added capacity" with additions.
3. Click "Apply fix & re-optimize" → redirected to a new running run; the Crews page shows the relocations (changed home branch) and "(added by fix)" crews.
4. When the new run completes, fewer (ideally zero) properties are unassigned. If some remain, the fix re-diagnoses on that run (a genuine shortfall).
5. Revert test: the added/relocated crews are editable on the Crews page.

- [ ] **Step 3: Commit any fixes from manual testing.**

---

## Notes for the executor

- **Web-only:** no solver change, no migration. The re-run uses the existing optimize flow.
- **Server-side recompute:** `applyUnassignedFix` recomputes the plan itself (never trusts client) — the displayed plan and applied plan come from the same `planUnassignedFix`, so they match.
- **DRY:** the re-run reuses the extracted `launchOptimization`; `loadFixPlan` (page) and the action both build the same `FixCrew[]`/`FixUnassignedProp[]` shapes — keep them identical.
- **Real edits, reversible:** relocations change `home_branch_id`; additions insert crews named "(added by fix)". Both visible/editable on `/crews`. No deletes.
- **Constants** (`FIX_CAP2/FIX_CAP3/FIX_UNDERUTILIZED_CLOCK`) mirror the recommender; keep consistent.
