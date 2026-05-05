'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseAspireFile } from '@/lib/csv-import';
import { geocodeAddress } from '@/lib/geocoding';

export async function importAspireCsv(formData: FormData) {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded' };
  }
  const buffer = await file.arrayBuffer();
  const { rows, errors } = parseAspireFile(file.name, buffer);

  if (rows.length === 0) {
    return { ok: false, error: `No valid rows. ${errors.length} parse errors.`, errors: errors.slice(0, 10) };
  }

  const supabase = getServiceClient();

  // Upsert by external_id when present, otherwise insert.
  const withExt = rows.filter((r) => r.external_id);
  const noExt = rows.filter((r) => !r.external_id);

  let inserted = 0;
  let upserted = 0;

  if (withExt.length > 0) {
    const { error, count } = await supabase
      .from('properties')
      .upsert(withExt, { onConflict: 'external_id', count: 'exact' });
    if (error) return { ok: false, error: error.message };
    upserted = count ?? withExt.length;
  }

  if (noExt.length > 0) {
    const { error, count } = await supabase.from('properties').insert(noExt, { count: 'exact' });
    if (error) return { ok: false, error: error.message };
    inserted = count ?? noExt.length;
  }

  revalidatePath('/properties');
  return {
    ok: true,
    inserted,
    upserted,
    errorCount: errors.length,
    sampleErrors: errors.slice(0, 5),
  };
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
