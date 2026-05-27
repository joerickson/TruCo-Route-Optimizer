'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import type { Branch, Crew, Property } from '@/lib/types';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export type RecommendActionResult = { ok: true; recommendation_id: string } | { ok: false; error: string };

export async function startRecommendation(formData: FormData): Promise<RecommendActionResult> {
  try {
    const name =
      String(formData.get('name') ?? '').trim() || `Fleet recommendation ${new Date().toISOString().slice(0, 16)}`;
    const supabase = getServiceClient();

    const [{ data: branchesData }, { data: propsData }, { data: crewsData }] = await Promise.all([
      supabase.from('branches').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('properties').select('*').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('crews').select('*').eq('is_active', true),
    ]);
    const branches = (branchesData ?? []) as Branch[];
    const properties = (propsData ?? []) as Property[];
    const crews = (crewsData ?? []) as Crew[];
    if (branches.length === 0) return { ok: false, error: 'No active geocoded branches' };
    if (properties.length === 0) return { ok: false, error: 'No active geocoded properties' };

    const capexRaw = Number(formData.get('capex'));
    const capex_usd = Number.isFinite(capexRaw) && capexRaw >= 0 ? capexRaw : 110000;

    const now = new Date();
    const dow = (now.getUTCDay() + 6) % 7; // 0=Mon
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
    const target_week = monday.toISOString().slice(0, 10);

    const { data: rec, error: recErr } = await supabase
      .from('crew_recommendations')
      .insert({
        name,
        status: 'running',
        active_branch_ids: branches.map((b) => b.id),
        active_property_ids: properties.map((p) => p.id),
        config_snapshot: { branch_count: branches.length, property_count: properties.length, capex_usd },
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (recErr || !rec) return { ok: false, error: recErr?.message ?? 'Could not create recommendation' };

    // Fire-and-forget solver call in recommend mode (same pattern as optimize).
    void invokeRecommend(rec.id, { branches, properties, crews, capex_usd, target_week, name }).catch(async (e) => {
      await supabase
        .from('crew_recommendations')
        .update({
          status: 'failed',
          failure_reason: e instanceof Error ? e.message : String(e),
          completed_at: new Date().toISOString(),
        })
        .eq('id', rec.id);
    });

    revalidatePath('/recommend');
    return { ok: true, recommendation_id: rec.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function invokeRecommend(
  recId: string,
  payload: { branches: Branch[]; properties: Property[]; crews: Crew[]; capex_usd: number; target_week: string; name: string },
) {
  if (!PYTHON_SOLVER_URL) throw new Error('PYTHON_SOLVER_URL is not configured.');
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ recommendation_id: recId, mode: 'recommend', ...payload }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
