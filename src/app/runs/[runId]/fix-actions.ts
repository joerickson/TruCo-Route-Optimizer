'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { launchOptimization } from '@/app/optimize/actions';
import { planUnassignedFix, type FixUnassignedProp, type FixBranch, type FixCrew } from '@/lib/unassigned-fix';
import type { OptimizationRun, CrewUtilization } from '@/lib/types';
import { getActiveScenarioId } from '@/lib/scenario';

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

    const [{ data: propRows }, { data: branchRows }, { data: crewRows }] = await Promise.all([
      supabase.from('properties').select('id, name, est_labor_hours, preferred_branch_id, lat, lng').in('id', unassignedIds),
      supabase.from('branches').select('id, name, lat, lng').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('crews').select('id, name, crew_size, home_branch_id').eq('is_active', true),
    ]);

    const unassigned: FixUnassignedProp[] = (
      (propRows ?? []) as Array<{
        id: string; name: string; est_labor_hours: number | string | null;
        preferred_branch_id: string | null; lat: number | string | null; lng: number | string | null;
      }>
    ).map((p) => ({
      id: p.id,
      name: p.name,
      est_labor_hours: Number(p.est_labor_hours) || 0,
      preferred_branch_id: p.preferred_branch_id ?? null,
      lat: p.lat == null ? null : Number(p.lat),
      lng: p.lng == null ? null : Number(p.lng),
    }));
    const branches: FixBranch[] = (
      (branchRows ?? []) as Array<{ id: string; name: string; lat: number | string; lng: number | string }>
    ).map((b) => ({ id: b.id, name: b.name, lat: Number(b.lat), lng: Number(b.lng) }));

    const clockByCrew: Record<string, number> = {};
    for (const u of (run.crew_utilization ?? []) as CrewUtilization[]) clockByCrew[u.crew_id] = u.clock_hours;
    const crews: FixCrew[] = (
      (crewRows ?? []) as Array<{ id: string; name: string; crew_size: number | string | null; home_branch_id: string }>
    ).map((c) => ({
      id: c.id,
      name: c.name,
      crew_size: Number(c.crew_size) || 2,
      home_branch_id: c.home_branch_id,
      clock_hours: clockByCrew[c.id] ?? 0,
    }));

    const plan = planUnassignedFix(unassigned, branches, crews);
    if (plan.relocations.length === 0 && plan.additions.length === 0) {
      return { ok: false, error: 'No fix to apply (no idle crews to relocate and nothing to add)' };
    }

    for (const r of plan.relocations) {
      const { error } = await supabase.from('crews').update({ home_branch_id: r.to_branch_id }).eq('id', r.crew_id);
      if (error) throw new Error(`Relocate ${r.crew_name}: ${error.message}`);
    }

    const newCrews: Array<Record<string, unknown>> = [];
    if (plan.additions.length > 0) {
      const scenarioId = await getActiveScenarioId();
      if (!scenarioId) throw new Error('No scenario selected');

      for (const a of plan.additions) {
        for (let i = 0; i < a.count; i++) {
          newCrews.push({
            name: `${a.branch_name} crew (added by fix)`,
            crew_size: a.size,
            home_branch_id: a.branch_id,
            max_clock_hours_per_day: REC_MAX_HOURS_PER_DAY,
            works_monday: true,
            works_tuesday: true,
            works_wednesday: true,
            works_thursday: true,
            works_friday: true,
            works_saturday: false,
            works_sunday: false,
            is_active: true,
            scenario_id: scenarioId,
          });
        }
      }
    }
    if (newCrews.length > 0) {
      const { error } = await supabase.from('crews').insert(newCrews);
      if (error) throw new Error(`Add crews: ${error.message}`);
    }

    revalidatePath('/crews');

    const launched = await launchOptimization(`Re-run after fix · ${run.name}`, targetWeek);
    if (!launched.ok) return { ok: false, error: `Crews updated, but re-run failed: ${launched.error}` };
    return { ok: true, run_id: launched.run_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
