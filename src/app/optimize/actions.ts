'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import type { Branch, Crew, Property } from '@/lib/types';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export async function startOptimization(formData: FormData) {
  const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim() || `Run ${new Date().toISOString().slice(0, 16)}`;
  if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };

  const supabase = getServiceClient();

  const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
    supabase.from('crews').select('*').eq('is_active', true),
    supabase.from('branches').select('*').eq('is_active', true),
    supabase
      .from('properties')
      .select('*')
      .eq('is_active', true)
      .not('lat', 'is', null)
      .not('lng', 'is', null),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Branch[];
  const properties = (propsData ?? []) as Property[];

  if (crews.length === 0) return { ok: false, error: 'No active crews configured' };
  if (branches.length === 0) return { ok: false, error: 'No active branches configured' };
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

  // Fire-and-forget call to Python solver. The solver POSTs back the result.
  // We deliberately do not await — the Optimize UI polls /api/optimize/[runId]/status.
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

async function invokeSolver(
  runId: string,
  payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }
) {
  const url = PYTHON_SOLVER_URL || '/api/python/optimize';
  const fullUrl = url.startsWith('http')
    ? url
    : `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}${url}`;

  const res = await fetch(fullUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, ...payload }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
