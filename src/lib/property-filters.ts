// Pure property-filter logic for the property map. No React, no Mapbox, no IO.
import type { ServiceType } from './types';

export type ContractStatus = 'active' | 'inactive';
export type ContractFilter = 'all' | 'active' | 'inactive';

export interface FilterState {
  cities: string[] | null; // null or [] => all cities
  services: Record<ServiceType, boolean>;
  contract: ContractFilter;
}

interface ContractDates {
  contract_start_date: string | null;
  contract_end_date: string | null;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Active if today is within [start, end] inclusive, treating null start as
// open-started and null end as open-ended. ISO 'YYYY-MM-DD' strings compare
// chronologically as plain strings, sidestepping timezone parsing.
export function contractStatusOf(p: ContractDates, today: Date): ContractStatus {
  const t = ymd(today);
  if (p.contract_start_date && p.contract_start_date.slice(0, 10) > t) return 'inactive';
  if (p.contract_end_date && p.contract_end_date.slice(0, 10) < t) return 'inactive';
  return 'active';
}

export function distinctCities(props: Array<{ city: string }>): Array<{ city: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of props) {
    const c = p.city;
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => a.city.localeCompare(b.city));
}

interface FilterableProperty extends ContractDates {
  city: string;
  service_type: ServiceType;
}

export function matchesFilters(p: FilterableProperty, state: FilterState, today: Date): boolean {
  if (state.cities && state.cities.length > 0 && !state.cities.includes(p.city)) return false;
  if (!state.services[p.service_type]) return false;
  if (state.contract !== 'all' && contractStatusOf(p, today) !== state.contract) return false;
  return true;
}
