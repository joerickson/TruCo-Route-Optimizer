'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { geocodeAddress } from '@/lib/geocoding';

export async function createBranch(formData: FormData) {
  const name = String(formData.get('name') ?? '').trim();
  const address = String(formData.get('address') ?? '').trim();
  const city = String(formData.get('city') ?? '').trim();
  const state = String(formData.get('state') ?? 'UT').trim();
  const postal = String(formData.get('postal_code') ?? '').trim() || null;

  if (!name || !address || !city) return { ok: false, error: 'Name, address, and city are required' };

  let lat: number | null = null;
  let lng: number | null = null;
  try {
    const geo = await geocodeAddress(`${address}, ${city}, ${state}`);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Geocode failed' };
  }
  if (lat == null || lng == null) return { ok: false, error: 'Could not geocode this address' };

  const supabase = getServiceClient();
  const { error } = await supabase.from('branches').insert({
    name,
    address,
    city,
    state,
    postal_code: postal,
    lat,
    lng,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/branches');
  revalidatePath('/crews');
  return { ok: true };
}

export async function deactivateBranch(id: string) {
  const supabase = getServiceClient();
  const { error } = await supabase.from('branches').update({ is_active: false }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/branches');
  return { ok: true };
}
