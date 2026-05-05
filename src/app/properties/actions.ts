'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseAspireFile, type AspireImportRow, type SkippedRow } from '@/lib/csv-import';
import { geocodeAddress } from '@/lib/geocoding';

export interface ImportSummary {
  ok: true;
  import_run_id: string;
  inserted: number;
  updated: number;
  skipped: number;
}

export type ImportActionResult = ImportSummary | { ok: false; error: string };

export async function importAspireCsv(formData: FormData): Promise<ImportActionResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded' };
  }
  const buffer = await file.arrayBuffer();
  const { rows, skipped } = parseAspireFile(file.name, buffer);
  const totalRows = rows.length + skipped.length;

  if (totalRows === 0) {
    return { ok: false, error: 'No rows found in file' };
  }

  const supabase = getServiceClient();

  const { data: importRun, error: runErr } = await supabase
    .from('import_runs')
    .insert({
      filename: file.name,
      total_rows: totalRows,
      skipped_count: skipped.length,
    })
    .select('id')
    .single();

  if (runErr || !importRun) {
    return { ok: false, error: runErr?.message ?? 'Could not create import run' };
  }

  if (skipped.length > 0) {
    const skippedRecords = skipped.map((s) => ({
      import_run_id: importRun.id,
      row_number: s.row_number,
      property_name: s.property_name,
      city: s.city,
      reason: s.reason,
      raw_data: serializeRaw(s.raw),
    }));
    const { error: skipErr } = await supabase.from('import_skipped_rows').insert(skippedRecords);
    if (skipErr) {
      // Don't abort — the property data is more important than the audit trail.
      console.error('Failed to persist skipped rows:', skipErr.message);
    }
  }

  let inserted = 0;
  let updated = 0;

  if (rows.length > 0) {
    const result = await applyRows(rows);
    inserted = result.inserted;
    updated = result.updated;
  }

  await supabase
    .from('import_runs')
    .update({ inserted_count: inserted, updated_count: updated })
    .eq('id', importRun.id);

  revalidatePath('/properties');
  return {
    ok: true,
    import_run_id: importRun.id,
    inserted,
    updated,
    skipped: skipped.length,
  };
}

// Dedup logic:
//   1. external_id present → upsert by external_id
//   2. else → match against existing properties by (lower(name), lower(address))
//      - found: update fields
//      - not found: insert
async function applyRows(rows: AspireImportRow[]): Promise<{ inserted: number; updated: number }> {
  const supabase = getServiceClient();

  let inserted = 0;
  let updated = 0;

  const withExt = rows.filter((r) => r.external_id);
  const noExt = rows.filter((r) => !r.external_id);

  if (withExt.length > 0) {
    // Determine inserts vs updates by checking which external_ids already exist.
    const ids = withExt.map((r) => r.external_id!);
    const { data: existing } = await supabase
      .from('properties')
      .select('external_id')
      .in('external_id', ids);
    const existingSet = new Set((existing ?? []).map((e: { external_id: string | null }) => e.external_id));
    const updates = withExt.filter((r) => existingSet.has(r.external_id));
    const inserts = withExt.filter((r) => !existingSet.has(r.external_id));

    const { error } = await supabase.from('properties').upsert(withExt, { onConflict: 'external_id' });
    if (error) throw new Error(error.message);
    inserted += inserts.length;
    updated += updates.length;
  }

  if (noExt.length > 0) {
    // Pull existing (id, name, address) so we can match in-app. With ~600 rows this is fine.
    const { data: existing, error: fetchErr } = await supabase
      .from('properties')
      .select('id, name, address');
    if (fetchErr) throw new Error(fetchErr.message);

    const keyOf = (n: string, a: string) => `${n.trim().toLowerCase()}::${a.trim().toLowerCase()}`;
    const idByKey = new Map<string, string>();
    for (const p of existing ?? []) {
      idByKey.set(keyOf(p.name, p.address), p.id);
    }

    const toInsert: AspireImportRow[] = [];
    const toUpdate: Array<{ id: string; row: AspireImportRow }> = [];
    for (const r of noExt) {
      const id = idByKey.get(keyOf(r.name, r.address));
      if (id) toUpdate.push({ id, row: r });
      else toInsert.push(r);
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('properties').insert(toInsert);
      if (error) throw new Error(error.message);
      inserted += toInsert.length;
    }

    // Update one at a time — Supabase PostgREST doesn't bulk-update with per-row patches in one call.
    for (const u of toUpdate) {
      const { error } = await supabase.from('properties').update(u.row).eq('id', u.id);
      if (error) throw new Error(error.message);
      updated += 1;
    }
  }

  return { inserted, updated };
}

// Convert any Date values in raw row data to ISO strings so they round-trip through jsonb.
function serializeRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    out[k] = v instanceof Date ? (isNaN(v.getTime()) ? String(v) : v.toISOString().slice(0, 10)) : v;
  }
  return out;
}

export async function geocodePending(limit = 100) {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('properties')
    .select('id, address, city, state')
    .is('lat', null)
    .eq('is_active', true)
    .limit(limit);

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: true, processed: 0, failed: 0 };

  let processed = 0;
  let failed = 0;
  for (const row of data) {
    const result = await geocodeAddress(`${row.address}, ${row.city}, ${row.state}`);
    if (result) {
      await supabase
        .from('properties')
        .update({
          lat: result.lat,
          lng: result.lng,
          postal_code: result.postal_code,
          geocoded_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      processed++;
    } else {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 20));
  }

  revalidatePath('/properties');
  return { ok: true, processed, failed };
}

export async function deactivateProperty(id: string) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('properties').update({ is_active: false }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/properties');
  return { ok: true };
}
