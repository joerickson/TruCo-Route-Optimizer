'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { geocodeAddress } from '@/lib/geocoding';
import type { ServiceType } from '@/lib/types';

export type PropertyActionResult =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

interface PropertyFields {
  name: string;
  address: string;
  city: string;
  state: string;
  postal_code: string | null;
  service_type: ServiceType;
  est_labor_hours: number;
  contract_start_date: string | null;
  contract_end_date: string | null;
  notes: string | null;
}

const VALID_SERVICES: ServiceType[] = ['weekly', 'biweekly', 'monthly'];

function readFields(formData: FormData): PropertyFields | { error: string } {
  const name = String(formData.get('name') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();
  const city = String(formData.get('city') ?? '').trim();
  const state = String(formData.get('state') ?? 'UT').trim() || 'UT';
  const postal = String(formData.get('postal_code') ?? '').trim() || null;
  const service_type_raw = String(formData.get('service_type') ?? '').trim();
  const est = parseFloat(String(formData.get('est_labor_hours') ?? '0'));
  const start = String(formData.get('contract_start_date') ?? '').trim() || null;
  const end = String(formData.get('contract_end_date') ?? '').trim() || null;
  const notes = String(formData.get('notes') ?? '').trim() || null;

  if (!name) return { error: 'Name is required' };
  if (!address) return { error: 'Address is required' };
  if (!city) return { error: 'City is required' };
  if (!VALID_SERVICES.includes(service_type_raw as ServiceType)) {
    return { error: `Service type must be one of: ${VALID_SERVICES.join(', ')}` };
  }
  if (!Number.isFinite(est) || est <= 0) return { error: 'Est labor hours must be greater than zero' };

  return {
    name,
    address,
    city,
    state,
    postal_code: postal,
    service_type: service_type_raw as ServiceType,
    est_labor_hours: est,
    contract_start_date: start,
    contract_end_date: end,
    notes,
  };
}

export async function updateProperty(id: string, formData: FormData): Promise<PropertyActionResult> {
  try {
    const parsed = readFields(formData);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    const supabase = getServiceClient();

    const { data: existing, error: fetchErr } = await supabase
      .from('properties')
      .select('address, city, state')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) return { ok: false, error: fetchErr.message };
    if (!existing) return { ok: false, error: 'Property not found' };

    const addressChanged =
      existing.address !== parsed.address ||
      existing.city !== parsed.city ||
      existing.state !== parsed.state;

    const patch: Record<string, unknown> = { ...parsed };
    let warning: string | undefined;

    if (addressChanged) {
      try {
        const geo = await geocodeAddress(`${parsed.address}, ${parsed.city}, ${parsed.state}`);
        if (geo) {
          patch.lat = geo.lat;
          patch.lng = geo.lng;
          patch.postal_code = geo.postal_code ?? parsed.postal_code;
          patch.geocoded_at = new Date().toISOString();
        } else {
          patch.lat = null;
          patch.lng = null;
          patch.geocoded_at = null;
          warning = 'Address saved but geocoding returned no results — use Re-geocode or fix the address.';
        }
      } catch (e) {
        patch.lat = null;
        patch.lng = null;
        patch.geocoded_at = null;
        warning = `Address saved but geocoding failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const { error } = await supabase.from('properties').update(patch).eq('id', id);
    if (error) return { ok: false, error: error.message };

    revalidatePath(`/properties/${id}`);
    revalidatePath('/properties');
    return { ok: true, warning };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function regeocodeProperty(id: string): Promise<PropertyActionResult> {
  try {
    const supabase = getServiceClient();
    const { data: prop, error: fetchErr } = await supabase
      .from('properties')
      .select('address, city, state')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) return { ok: false, error: fetchErr.message };
    if (!prop) return { ok: false, error: 'Property not found' };

    const geo = await geocodeAddress(`${prop.address}, ${prop.city}, ${prop.state}`);
    if (!geo) return { ok: false, error: 'Geocoding returned no results for this address.' };

    const { error } = await supabase
      .from('properties')
      .update({
        lat: geo.lat,
        lng: geo.lng,
        postal_code: geo.postal_code,
        geocoded_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) return { ok: false, error: error.message };

    revalidatePath(`/properties/${id}`);
    revalidatePath('/properties');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
