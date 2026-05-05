'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { geocodeAddress } from '@/lib/geocoding';

export type BranchActionResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string; assignedCrews?: Array<{ id: string; name: string }> };

interface BranchFields {
  name: string;
  address: string;
  city: string;
  state: string;
  postal_code: string | null;
  is_active: boolean;
}

function readFields(formData: FormData): BranchFields | { error: string } {
  const name = String(formData.get('name') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();
  const city = String(formData.get('city') ?? '').trim();
  const state = String(formData.get('state') ?? 'UT').trim() || 'UT';
  const postal = String(formData.get('postal_code') ?? '').trim() || null;
  const is_active = formData.get('is_active') === 'on' || formData.get('is_active') === 'true';

  if (!name) return { error: 'Name is required' };
  if (!address) return { error: 'Address is required' };
  if (!city) return { error: 'City is required' };

  return { name, address, city, state, postal_code: postal, is_active };
}

async function tryGeocode(
  fields: Pick<BranchFields, 'address' | 'city' | 'state'>
): Promise<{ lat: number; lng: number } | { failed: true; reason: string }> {
  try {
    const geo = await geocodeAddress(`${fields.address}, ${fields.city}, ${fields.state}`);
    if (!geo) return { failed: true, reason: 'No geocoding result for this address' };
    return { lat: geo.lat, lng: geo.lng };
  } catch (e) {
    return { failed: true, reason: e instanceof Error ? e.message : 'Geocoding error' };
  }
}

const GEOCODE_FAIL_WARNING =
  'Geocoding failed — branch will not appear on the map or be usable for optimization until the address is corrected.';

export async function createBranch(formData: FormData): Promise<BranchActionResult> {
  const parsed = readFields(formData);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const fields = parsed;
  const geo = await tryGeocode(fields);
  const supabase = getServiceClient();

  const insertRow = {
    name: fields.name,
    address: fields.address,
    city: fields.city,
    state: fields.state,
    postal_code: fields.postal_code,
    is_active: fields.is_active,
    lat: 'failed' in geo ? null : geo.lat,
    lng: 'failed' in geo ? null : geo.lng,
  };

  const { error } = await supabase.from('branches').insert(insertRow);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/branches');
  revalidatePath('/crews');
  return { ok: true, warning: 'failed' in geo ? GEOCODE_FAIL_WARNING : undefined };
}

export async function updateBranch(id: string, formData: FormData): Promise<BranchActionResult> {
  const parsed = readFields(formData);
  if ('error' in parsed) return { ok: false, error: parsed.error };

  const fields = parsed;
  const supabase = getServiceClient();

  // Re-geocode only if address/city/state changed.
  const { data: existing, error: fetchErr } = await supabase
    .from('branches')
    .select('address, city, state')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) return { ok: false, error: fetchErr.message };
  if (!existing) return { ok: false, error: 'Branch not found' };

  const addressChanged =
    existing.address !== fields.address || existing.city !== fields.city || existing.state !== fields.state;

  let coords: { lat: number | null; lng: number | null } = {} as never;
  let warning: string | undefined;

  if (addressChanged) {
    const geo = await tryGeocode(fields);
    if ('failed' in geo) {
      coords = { lat: null, lng: null };
      warning = GEOCODE_FAIL_WARNING;
    } else {
      coords = { lat: geo.lat, lng: geo.lng };
    }
  }

  const patch: Record<string, unknown> = {
    name: fields.name,
    address: fields.address,
    city: fields.city,
    state: fields.state,
    postal_code: fields.postal_code,
    is_active: fields.is_active,
  };
  if (addressChanged) {
    patch.lat = coords.lat;
    patch.lng = coords.lng;
  }

  const { error } = await supabase.from('branches').update(patch).eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/branches');
  revalidatePath('/crews');
  return { ok: true, warning };
}

export async function deleteBranch(id: string): Promise<BranchActionResult> {
  const supabase = getServiceClient();

  // Block delete if any crew (active or inactive) references this branch.
  // Reactivating a crew whose branch was deleted would leave it orphaned.
  const { data: crews, error: crewErr } = await supabase
    .from('crews')
    .select('id, name, is_active')
    .eq('home_branch_id', id);
  if (crewErr) return { ok: false, error: crewErr.message };

  if (crews && crews.length > 0) {
    return {
      ok: false,
      error: `Cannot delete: ${crews.length} crew${crews.length === 1 ? '' : 's'} ${crews.length === 1 ? 'is' : 'are'} based here. Reassign them to another branch first.`,
      assignedCrews: crews.map((c) => ({ id: c.id, name: c.name })),
    };
  }

  const { error } = await supabase.from('branches').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/branches');
  revalidatePath('/crews');
  return { ok: true };
}
