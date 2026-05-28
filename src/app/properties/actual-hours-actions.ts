'use server';

import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseActualHoursFile } from '@/lib/actual-hours-import';

export interface ActualHoursUploadResult {
  ok: boolean;
  error?: string;
  parsed?: number; // rows with a usable value
  updated?: number; // properties matched + updated
  skippedRows?: number; // malformed rows in the file
  unmatched?: string[]; // identifiers with no matching active property
}

export async function uploadActualHours(formData: FormData): Promise<ActualHoursUploadResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'No file selected' };

  let result;
  try {
    result = parseActualHoursFile(file.name, await file.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `Could not read file: ${e instanceof Error ? e.message : String(e)}` };
  }
  const { rows, skipped } = result;

  const supabase = getServiceClient();
  const { data: props, error: loadErr } = await supabase
    .from('properties')
    .select('id, external_id, name')
    .eq('is_active', true);
  if (loadErr) return { ok: false, error: `Could not load properties: ${loadErr.message}` };

  const byExt = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of (props ?? []) as Array<{ id: string; external_id: string | null; name: string }>) {
    if (p.external_id) byExt.set(p.external_id, p.id);
    byName.set(p.name.trim().toLowerCase(), p.id);
  }

  const updates: { id: string; value: number }[] = [];
  const unmatched: string[] = [];
  for (const r of rows) {
    const id = r.byExternalId ? byExt.get(r.identifier) : byName.get(r.identifier.trim().toLowerCase());
    if (!id) {
      unmatched.push(r.identifier);
      continue;
    }
    updates.push({ id, value: r.actual_hours_per_week });
  }

  // Apply in bounded-concurrency chunks (a portfolio is a few hundred rows).
  let updated = 0;
  const CHUNK = 25;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const results = await Promise.all(
      updates.slice(i, i + CHUNK).map((u) =>
        supabase.from('properties').update({ actual_hours_per_week: u.value }).eq('id', u.id)
      )
    );
    updated += results.filter((r) => !r.error).length;
  }

  revalidatePath('/properties');
  return { ok: true, parsed: rows.length, updated, skippedRows: skipped.length, unmatched };
}
