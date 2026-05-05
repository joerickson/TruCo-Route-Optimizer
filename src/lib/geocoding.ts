// Google Geocoding API wrapper.
// Used both at import time (server actions) and via a manual "regeocode" trigger.

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';

export interface GeocodeResult {
  lat: number;
  lng: number;
  formatted_address: string;
  postal_code: string | null;
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  if (!GOOGLE_KEY) throw new Error('GOOGLE_MAPS_API_KEY not configured');

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', GOOGLE_KEY);

  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status: string;
    results: Array<{
      geometry: { location: { lat: number; lng: number } };
      formatted_address: string;
      address_components: Array<{ types: string[]; short_name: string; long_name: string }>;
    }>;
  };

  if (data.status !== 'OK' || data.results.length === 0) return null;

  const top = data.results[0];
  const postalComp = top.address_components.find((c) => c.types.includes('postal_code'));

  return {
    lat: top.geometry.location.lat,
    lng: top.geometry.location.lng,
    formatted_address: top.formatted_address,
    postal_code: postalComp?.short_name ?? null,
  };
}

// Best-effort batch geocoder. Sequential to avoid rate-limit bursts.
export async function geocodeBatch(
  items: Array<{ id: string; address: string; city: string; state: string }>,
  onProgress?: (done: number, total: number) => void
): Promise<Array<{ id: string; result: GeocodeResult | null }>> {
  const out: Array<{ id: string; result: GeocodeResult | null }> = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fullAddr = `${it.address}, ${it.city}, ${it.state}`;
    try {
      out.push({ id: it.id, result: await geocodeAddress(fullAddr) });
    } catch {
      out.push({ id: it.id, result: null });
    }
    onProgress?.(i + 1, items.length);
    // Polite throttle — Google free tier handles ~50 req/s, but be nice.
    await new Promise((r) => setTimeout(r, 20));
  }
  return out;
}
