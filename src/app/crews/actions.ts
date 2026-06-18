'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';

export type CrewActionResult = { ok: true } | { ok: false; error: string };

interface CrewFields {
  name: string;
  crew_size: number;
  home_branch_id: string;
  max_clock_hours_per_day: number;
  is_active: boolean;
  notes: string | null;
  works_monday: boolean;
  works_tuesday: boolean;
  works_wednesday: boolean;
  works_thursday: boolean;
  works_friday: boolean;
  works_saturday: boolean;
  works_sunday: boolean;
}

function bool(v: FormDataEntryValue | null): boolean {
  return v === 'on' || v === 'true';
}

function readFields(formData: FormData): CrewFields | { error: string } {
  const name = String(formData.get('name') ?? '').trim();
  const crew_size = parseInt(String(formData.get('crew_size') ?? '2'), 10);
  const home_branch_id = String(formData.get('home_branch_id') ?? '').trim();
  const max_clock_hours_per_day = parseFloat(String(formData.get('max_clock_hours_per_day') ?? '8'));
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (!name) return { error: 'Name is required' };
  if (!home_branch_id) return { error: 'Home branch is required' };
  if (!Number.isFinite(crew_size) || crew_size < 1) return { error: 'Crew size must be at least 1' };
  if (!Number.isFinite(max_clock_hours_per_day) || max_clock_hours_per_day <= 0) {
    return { error: 'Max hours/day must be greater than zero' };
  }

  return {
    name,
    crew_size,
    home_branch_id,
    max_clock_hours_per_day,
    is_active: bool(formData.get('is_active')),
    notes,
    works_monday: bool(formData.get('works_monday')),
    works_tuesday: bool(formData.get('works_tuesday')),
    works_wednesday: bool(formData.get('works_wednesday')),
    works_thursday: bool(formData.get('works_thursday')),
    works_friday: bool(formData.get('works_friday')),
    works_saturday: bool(formData.get('works_saturday')),
    works_sunday: bool(formData.get('works_sunday')),
  };
}

export async function createCrew(formData: FormData): Promise<CrewActionResult> {
  const parsed = readFields(formData);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const scenarioId = await getActiveScenarioId();
  if (!scenarioId) return { ok: false, error: 'No scenario selected' };

  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').insert({ ...parsed, scenario_id: scenarioId });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/crews');
  return { ok: true };
}

export async function updateCrew(id: string, formData: FormData): Promise<CrewActionResult> {
  const parsed = readFields(formData);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').update(parsed).eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/crews');
  return { ok: true };
}

// Soft delete only — hard delete would break historical optimization_runs that
// reference crew_id, plus properties.assigned_crew_id (ON DELETE SET NULL would
// strip useful state from completed runs).
export async function deactivateCrew(id: string): Promise<CrewActionResult> {
  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').update({ is_active: false }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/crews');
  return { ok: true };
}

export async function reactivateCrew(id: string): Promise<CrewActionResult> {
  const supabase = getServiceClient();
  const { error } = await supabase.from('crews').update({ is_active: true }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/crews');
  return { ok: true };
}
