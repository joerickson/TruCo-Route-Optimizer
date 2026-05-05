'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';

export async function updateCrew(id: string, patch: Record<string, unknown>) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').update(patch).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/crews');
  return { ok: true };
}

export async function createCrew(input: {
  name: string;
  crew_size: number;
  home_branch_id: string;
}) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').insert({
    name: input.name,
    crew_size: input.crew_size,
    home_branch_id: input.home_branch_id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/crews');
  return { ok: true };
}

export async function deactivateCrew(id: string) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').update({ is_active: false }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/crews');
  return { ok: true };
}
