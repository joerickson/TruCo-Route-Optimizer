import type { SupabaseClient } from '@supabase/supabase-js';
import type { Property } from '@/lib/types';
import type { MapBranch, MapProperty } from './properties-map';

// Fetches the slim data the property map needs: all geocoded active properties
// (optionally name-filtered), active branches, and a count of active properties
// still awaiting geocode. Shared by the Properties map view and the Overview map.
export async function getPropertyMapData(
  supabase: SupabaseClient,
  opts: { q?: string; scenarioId?: string } = {}
): Promise<{ properties: MapProperty[]; branches: MapBranch[]; pendingCount: number }> {
  const q = (opts.q ?? '').trim();
  const scenarioId = opts.scenarioId ?? '';

  let propsQuery = supabase
    .from('properties')
    .select('id, name, address, city, lat, lng, service_type, est_labor_hours, contract_start_date, contract_end_date')
    .eq('scenario_id', scenarioId)
    .eq('is_active', true)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .limit(2000);
  if (q) propsQuery = propsQuery.ilike('name', `%${q}%`);

  const branchesQuery = supabase
    .from('branches')
    .select('id, name, address, city, lat, lng')
    .eq('scenario_id', scenarioId)
    .eq('is_active', true);

  const pendingQuery = supabase
    .from('properties')
    .select('*', { count: 'exact', head: true })
    .eq('scenario_id', scenarioId)
    .eq('is_active', true)
    .is('lat', null);

  const [{ data: propsData }, { data: branchesData }, { count: pendingCount }] = await Promise.all([
    propsQuery,
    branchesQuery,
    pendingQuery,
  ]);

  const properties: MapProperty[] = ((propsData ?? []) as Property[])
    .filter((p): p is Property & { lat: number; lng: number } => p.lat != null && p.lng != null)
    .map((p) => ({
      id: p.id,
      name: p.name,
      address: p.address,
      city: p.city,
      lat: Number(p.lat),
      lng: Number(p.lng),
      service_type: p.service_type,
      est_labor_hours: Number(p.est_labor_hours),
      contract_start_date: p.contract_start_date,
      contract_end_date: p.contract_end_date,
    }));

  const branches: MapBranch[] = ((branchesData ?? []) as Array<{
    id: string;
    name: string;
    address: string;
    city: string;
    lat: number | string;
    lng: number | string;
  }>).map((b) => ({
    id: b.id,
    name: b.name,
    address: b.address,
    city: b.city,
    lat: Number(b.lat),
    lng: Number(b.lng),
  }));

  return { properties, branches, pendingCount: pendingCount ?? 0 };
}
