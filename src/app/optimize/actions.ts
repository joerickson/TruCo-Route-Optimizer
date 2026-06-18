'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';
import { filterPropertiesWithinRadius } from '@/lib/property-radius';
import type { Branch, Crew, Property } from '@/lib/types';
import { withEffectiveLabor } from '@/lib/effective-labor';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export async function startOptimization(
  formData: FormData
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim() || `Run ${new Date().toISOString().slice(0, 16)}`;
  if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };
  const anchorBranchId = String(formData.get('anchor_branch_id') ?? '').trim() || null;
  const radiusRaw = String(formData.get('radius_miles') ?? '').trim();
  const radiusMiles = radiusRaw ? Number(radiusRaw) : null;
  if (radiusMiles != null && (!Number.isFinite(radiusMiles) || radiusMiles <= 0)) {
    return { ok: false, error: 'Radius must be a positive number' };
  }
  return launchOptimization(name, targetWeek, { anchorBranchId, radiusMiles });
}

export async function launchOptimization(
  name: string,
  targetWeek: string,
  filter?: { anchorBranchId: string | null; radiusMiles: number | null }
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const supabase = getServiceClient();
  const scenarioId = await getActiveScenarioId();
  if (!scenarioId) return { ok: false, error: 'No scenario selected' };

  const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
    supabase.from('crews').select('*').eq('is_active', true).eq('scenario_id', scenarioId),
    supabase.from('branches').select('*').eq('is_active', true).eq('scenario_id', scenarioId).not('lat', 'is', null).not('lng', 'is', null),
    supabase.from('properties').select('*').eq('is_active', true).eq('scenario_id', scenarioId).not('lat', 'is', null).not('lng', 'is', null),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Branch[];
  let properties = (propsData ?? []) as Property[];

  if (crews.length === 0) return { ok: false, error: 'No active crews in this scenario' };
  if (branches.length === 0) return { ok: false, error: 'No active geocoded branches in this scenario' };

  let appliedFilter: { anchor_branch_id: string; anchor_branch_name: string; radius_miles: number } | null = null;
  if (filter?.anchorBranchId && filter.radiusMiles != null) {
    const anchor = branches.find((b) => b.id === filter.anchorBranchId);
    if (!anchor) return { ok: false, error: 'Anchor branch not found in scenario' };
    properties = filterPropertiesWithinRadius(properties, { lat: anchor.lat, lng: anchor.lng }, filter.radiusMiles);
    appliedFilter = { anchor_branch_id: anchor.id, anchor_branch_name: anchor.name, radius_miles: filter.radiusMiles };
  }

  if (properties.length === 0) {
    return { ok: false, error: appliedFilter ? 'No geocoded properties within that radius' : 'No geocoded active properties in this scenario' };
  }

  const { data: run, error: runErr } = await supabase
    .from('optimization_runs')
    .insert({
      name,
      scenario_id: scenarioId,
      target_week_start_date: targetWeek,
      active_branch_ids: branches.map((b) => b.id),
      active_crew_ids: crews.map((c) => c.id),
      active_property_ids: properties.map((p) => p.id),
      config_snapshot: { crew_count: crews.length, property_count: properties.length, property_filter: appliedFilter },
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runErr || !run) return { ok: false, error: runErr?.message ?? 'Could not create run' };

  // Background call to Python solver. The solver writes the result back to
  // optimization_runs directly; the run-detail page polls for completion.
  //
  // Fire-and-forget: we don't await this. On Coolify the Node process is
  // long-lived, so the in-flight fetch keeps running after we return to the
  // client. (On Vercel this needed waitUntil() to stop the serverless instance
  // being frozen the moment we returned — not a concern off Vercel.)
  void invokeSolver(run.id, { crews, branches, properties }).catch(async (e) => {
    await supabase
      .from('optimization_runs')
      .update({ status: 'failed', failure_reason: e instanceof Error ? e.message : String(e), completed_at: new Date().toISOString() })
      .eq('id', run.id);
  });

  revalidatePath('/optimize');
  return { ok: true, run_id: run.id };
}

async function invokeSolver(
  runId: string,
  payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }
) {
  // The Python solver runs as a separate Coolify app. Set PYTHON_SOLVER_URL on
  // this project to the full solver URL.
  if (!PYTHON_SOLVER_URL) {
    throw new Error('PYTHON_SOLVER_URL is not configured. Set it on this project to the deployed Python solver URL.');
  }
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, ...payload, properties: withEffectiveLabor(payload.properties) }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
