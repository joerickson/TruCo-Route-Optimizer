'use server';
import { revalidatePath } from 'next/cache';
import { waitUntil } from '@vercel/functions';
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
    supabase
      .from('branches')
      .select('*')
      .eq('is_active', true)
      .not('lat', 'is', null)
      .not('lng', 'is', null),
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

  // Background call to Python solver. The solver writes the result back to
  // optimization_runs directly; the run-detail page polls for completion.
  //
  // waitUntil keeps the function instance alive until the fetch settles even
  // though we've already returned to the client. Without it, Vercel kills the
  // instance the moment we return — the in-flight fetch gets terminated and
  // the run sits in 'running' forever.
  waitUntil(
    invokeSolver(run.id, { crews, branches, properties }).catch(async (e) => {
      await supabase
        .from('optimization_runs')
        .update({
          status: 'failed',
          failure_reason: e instanceof Error ? e.message : String(e),
          completed_at: new Date().toISOString(),
        })
        .eq('id', run.id);
    })
  );

  revalidatePath('/optimize');
  return { ok: true, run_id: run.id };
}

async function invokeSolver(
  runId: string,
  payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }
) {
  // The Python solver runs in a separate Vercel project (Next.js + Python can't
  // coexist in one project — Next.js claims /api/* at the routing layer). Set
  // PYTHON_SOLVER_URL on this project to the full solver URL, e.g.
  //   https://truco-solver.vercel.app/api/solver
  if (!PYTHON_SOLVER_URL) {
    throw new Error(
      'PYTHON_SOLVER_URL is not configured. Set it on this Vercel project to the deployed Python solver URL (e.g. https://truco-solver.vercel.app/api/solver).'
    );
  }

  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, ...payload }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
