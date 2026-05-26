'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseAspireFile, type AspireImportRow } from '@/lib/csv-import';
import { geocodeAddress } from '@/lib/geocoding';
import { resolveCrewId, parseDayOfWeek } from '@/lib/schedule-import';

export interface ImportSummary {
  ok: true;
  import_run_id: string;
  inserted: number;
  updated: number;
  skipped: number;
}

export type ImportActionResult = ImportSummary | { ok: false; error: string };

export async function importAspireCsv(formData: FormData): Promise<ImportActionResult> {
  // Wrap everything: any throw from the parser, Supabase, or applyRows should come back
  // as a structured error rather than crashing the server function (which surfaces as
  // ERR_CONNECTION_CLOSED in the browser).
  try {
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

    // Path A: if the export carried crew/day columns, resolve + apply assignments.
    const withAssignment = rows.filter((r) => r.assigned_crew_name && r.assigned_day_raw && r.external_id);
    if (withAssignment.length > 0) {
      const { data: crewRows } = await supabase.from('crews').select('id, name').eq('is_active', true);
      const crewsByName = new Map<string, string>();
      for (const c of (crewRows ?? []) as Array<{ id: string; name: string }>) crewsByName.set(c.name.trim().toLowerCase(), c.id);
      // Bucket by (crew_id, day) → one update per distinct assignment, not per row.
      const buckets = new Map<string, { crewId: string; day: number; externalIds: string[] }>();
      for (const r of withAssignment) {
        const crewId = resolveCrewId(r.assigned_crew_name!, crewsByName);
        const day = parseDayOfWeek(r.assigned_day_raw);
        if (!crewId || !day) continue;
        const key = `${crewId}::${day}`;
        const bucket = buckets.get(key) ?? { crewId, day, externalIds: [] };
        bucket.externalIds.push(r.external_id!);
        buckets.set(key, bucket);
      }
      for (const { crewId, day, externalIds } of buckets.values()) {
        const { error: assignErr } = await supabase
          .from('properties')
          .update({ assigned_crew_id: crewId, assigned_day_of_week: day })
          .in('external_id', externalIds);
        if (assignErr) console.error('Failed to apply schedule assignment:', assignErr.message);
      }
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
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Dedup logic:
//   1. external_id present → upsert by external_id (single round-trip)
//   2. else → match against existing properties by (lower(name), lower(address))
//      - found: bulk upsert by id (single round-trip — was N sequential UPDATEs)
//      - not found: bulk insert
//
// The previous implementation did one UPDATE per matched row, which on a 564-row
// re-import meant ~80s of round-trips and timed out. Bulk upsert collapses each
// branch to a single PostgREST call.
async function applyRows(rows: AspireImportRow[]): Promise<{ inserted: number; updated: number }> {
  const supabase = getServiceClient();

  let inserted = 0;
  let updated = 0;

  const withExt = rows.filter((r) => r.external_id);
  const noExt = rows.filter((r) => !r.external_id);

  if (withExt.length > 0) {
    const ids = withExt.map((r) => r.external_id!);
    const { data: existing, error: existingErr } = await supabase
      .from('properties')
      .select('external_id')
      .in('external_id', ids);
    if (existingErr) throw new Error(existingErr.message);

    const existingSet = new Set((existing ?? []).map((e: { external_id: string | null }) => e.external_id));
    inserted += withExt.filter((r) => !existingSet.has(r.external_id)).length;
    updated += withExt.filter((r) => existingSet.has(r.external_id)).length;

    const { error } = await supabase.from('properties').upsert(
      withExt.map((r) => ({ external_id: r.external_id, ...toDbRow(r) })),
      { onConflict: 'external_id' },
    );
    if (error) throw new Error(error.message);
  }

  if (noExt.length > 0) {
    // Pull existing (id, name, address) so we can match in-app. With ~600 rows this is fine.
    const { data: existing, error: fetchErr } = await supabase
      .from('properties')
      .select('id, name, address');
    if (fetchErr) throw new Error(fetchErr.message);

    const keyOf = (n: string, a: string) => `${n.trim().toLowerCase()}::${a.trim().toLowerCase()}`;
    const idByKey = new Map<string, string>();
    for (const p of (existing ?? []) as Array<{ id: string; name: string; address: string }>) {
      idByKey.set(keyOf(p.name, p.address), p.id);
    }

    const toInsert: AspireImportRow[] = [];
    const toUpdate: Array<AspireImportRow & { id: string }> = [];
    for (const r of noExt) {
      const id = idByKey.get(keyOf(r.name, r.address));
      if (id) toUpdate.push({ ...r, id });
      else toInsert.push(r);
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('properties').insert(
        toInsert.map((r) => toDbRow(r)),
      );
      if (error) throw new Error(error.message);
      inserted += toInsert.length;
    }

    if (toUpdate.length > 0) {
      // Bulk upsert by primary key — single round-trip update for all matched rows.
      // Important: omit external_id from the payload. Otherwise each AspireImportRow's
      // null external_id would null out any existing external_id on the matched DB row.
      const updatePayload = toUpdate.map((r) => ({ id: r.id, ...toDbRow(r) }));
      const { error } = await supabase.from('properties').upsert(updatePayload, { onConflict: 'id' });
      if (error) throw new Error(error.message);
      updated += toUpdate.length;
    }
  }

  return { inserted, updated };
}

// The DB column subset of an AspireImportRow (excludes external_id/id and the
// non-column assignment fields). Used by all three insert/upsert payloads so a
// future column addition only has to be made once.
function toDbRow(r: AspireImportRow) {
  return {
    name: r.name,
    address: r.address,
    city: r.city,
    state: r.state,
    service_type: r.service_type,
    est_labor_hours: r.est_labor_hours,
    contract_start_date: r.contract_start_date,
    contract_end_date: r.contract_end_date,
    notes: r.notes,
  };
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
