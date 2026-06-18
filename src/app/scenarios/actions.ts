'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { getServiceClient } from '@/lib/supabase';
import { ACTIVE_SCENARIO_COOKIE } from '@/lib/scenario';

type Result = { ok: true } | { ok: false; error: string };

export async function setActiveScenario(id: string): Promise<Result> {
  cookies().set(ACTIVE_SCENARIO_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function createScenario(formData: FormData): Promise<Result> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  if (!name) return { ok: false, error: 'Name is required' };
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('scenarios')
    .insert({ name, description, is_default: false })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create scenario' };
  // Switch into the new (empty) scenario immediately.
  await setActiveScenario(data.id);
  revalidatePath('/scenarios');
  return { ok: true };
}

export async function deleteScenario(formData: FormData): Promise<Result> {
  const id = String(formData.get('id') ?? '');
  if (!id) return { ok: false, error: 'id required' };
  const supabase = getServiceClient();
  const { data: scn } = await supabase.from('scenarios').select('is_default').eq('id', id).single();
  if (scn?.is_default) return { ok: false, error: 'The default scenario cannot be deleted' };
  // Cascade removes the scenario's properties/crews/branches/runs (FK on delete cascade).
  const { error } = await supabase.from('scenarios').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  // If we just deleted the active scenario, the resolver falls back to default.
  cookies().delete(ACTIVE_SCENARIO_COOKIE);
  revalidatePath('/scenarios');
  revalidatePath('/', 'layout');
  return { ok: true };
}
