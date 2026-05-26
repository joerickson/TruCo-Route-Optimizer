# Shared Filterable Property Map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing property map a reusable, filterable component (by city, service type, and contract status), and embed it on the Overview page as well as `/properties`.

**Architecture:** Pure filter logic in a tested `src/lib/property-filters.ts`; a shared server data helper `src/app/properties/map-data.ts`; a presentational filter bar `map-filters.tsx`; the existing `properties-map.tsx` widened to apply the combined predicate and accept reuse props; the same lazy-loaded map embedded on Overview. All filtering is client-side over the already-loaded set.

**Tech Stack:** Next.js 14 App Router (server components), TypeScript, Mapbox GL JS, Supabase, vitest.

**Spec:** `docs/superpowers/specs/2026-05-25-property-map-filters-design.md`

**Deviations from spec (mechanics only):** (1) city multi-select is a self-contained popover — no `dropdown-menu` primitive exists in the repo; (2) data helper is at `src/app/properties/map-data.ts` (colocated with `MapProperty`/`MapBranch`), not `src/lib/`.

---

## File Structure

New:
- `src/lib/property-filters.ts` — pure: `contractStatusOf`, `distinctCities`, `matchesFilters`, types.
- `src/lib/property-filters.test.ts` — vitest tests.
- `src/app/properties/map-data.ts` — server helper `getPropertyMapData`.
- `src/app/properties/map-filters.tsx` — presentational filter bar + `SERVICE_COLORS`/`SERVICE_LABELS` (moved here).

Modified:
- `src/app/properties/properties-map.tsx` — apply combined filter; render `<MapFilters>`; add optional `heightClass`/`fullMapHref`; import service constants from `map-filters`.
- `src/app/properties/page.tsx` — use `getPropertyMapData`.
- `src/app/page.tsx` — add a map card via the shared loader.

`properties-map-loader.tsx` needs **no change** (it spreads `PropertiesMapProps`, which only gains optional fields).

---

## Task 1: Pure filter module — TDD

**Files:**
- Create: `src/lib/property-filters.ts`
- Test: `src/lib/property-filters.test.ts`

- [ ] **Step 1: Write the failing tests** — `src/lib/property-filters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  contractStatusOf,
  distinctCities,
  matchesFilters,
  type FilterState,
} from './property-filters';

const today = new Date('2026-05-25T12:00:00');

const allServices = { weekly: true, biweekly: true, monthly: true } as const;

describe('contractStatusOf', () => {
  it('active when today is within [start, end]', () => {
    expect(contractStatusOf({ contract_start_date: '2026-01-01', contract_end_date: '2026-12-31' }, today)).toBe('active');
  });
  it('inactive when expired (end before today)', () => {
    expect(contractStatusOf({ contract_start_date: '2025-01-01', contract_end_date: '2025-12-31' }, today)).toBe('inactive');
  });
  it('inactive when not yet started (start after today)', () => {
    expect(contractStatusOf({ contract_start_date: '2026-07-01', contract_end_date: null }, today)).toBe('inactive');
  });
  it('active with null start when today <= end', () => {
    expect(contractStatusOf({ contract_start_date: null, contract_end_date: '2026-12-31' }, today)).toBe('active');
  });
  it('active with null end when today >= start', () => {
    expect(contractStatusOf({ contract_start_date: '2026-01-01', contract_end_date: null }, today)).toBe('active');
  });
  it('active when both dates null', () => {
    expect(contractStatusOf({ contract_start_date: null, contract_end_date: null }, today)).toBe('active');
  });
  it('inclusive: active when today equals start or end', () => {
    expect(contractStatusOf({ contract_start_date: '2026-05-25', contract_end_date: '2026-05-25' }, today)).toBe('active');
  });
});

describe('distinctCities', () => {
  it('returns cities with counts, sorted by name, ignoring empties', () => {
    const result = distinctCities([
      { city: 'Provo' }, { city: 'Lehi' }, { city: 'Provo' }, { city: '' },
    ]);
    expect(result).toEqual([
      { city: 'Lehi', count: 1 },
      { city: 'Provo', count: 2 },
    ]);
  });
});

describe('matchesFilters', () => {
  const base = { city: 'Provo', service_type: 'weekly' as const, contract_start_date: '2026-01-01', contract_end_date: '2026-12-31' };

  it('passes when all filters are permissive (cities null, all services, contract all)', () => {
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(true);
  });
  it('cities null or empty means all cities pass', () => {
    expect(matchesFilters(base, { cities: null, services: { ...allServices }, contract: 'all' }, today)).toBe(true);
    expect(matchesFilters(base, { cities: [], services: { ...allServices }, contract: 'all' }, today)).toBe(true);
  });
  it('filters out a city not in the selection', () => {
    const state: FilterState = { cities: ['Lehi'], services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
  it('keeps a city in the selection', () => {
    const state: FilterState = { cities: ['Provo'], services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(true);
  });
  it('filters out a disabled service type', () => {
    const state: FilterState = { cities: null, services: { ...allServices, weekly: false }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
  it('contract=active excludes an expired property', () => {
    const expired = { ...base, contract_start_date: '2025-01-01', contract_end_date: '2025-12-31' };
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'active' };
    expect(matchesFilters(expired, state, today)).toBe(false);
  });
  it('contract=inactive excludes an active property', () => {
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'inactive' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they FAIL**

Run: `npm test`
Expected: FAIL — module/exports do not exist yet.

- [ ] **Step 3: Implement `src/lib/property-filters.ts`**

```ts
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
```

- [ ] **Step 4: Run tests, verify they PASS**

Run: `npm test`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/property-filters.ts src/lib/property-filters.test.ts
git commit -m "feat: pure property-filters module (city, service, contract status)"
```

---

## Task 2: Shared server data helper

**Files:**
- Create: `src/app/properties/map-data.ts`
- Modify: `src/app/properties/page.tsx`

- [ ] **Step 1: Create `src/app/properties/map-data.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Property } from '@/lib/types';
import type { MapBranch, MapProperty } from './properties-map';

// Fetches the slim data the property map needs: all geocoded active properties
// (optionally name-filtered), active branches, and a count of active properties
// still awaiting geocode. Shared by the Properties map view and the Overview map.
export async function getPropertyMapData(
  supabase: SupabaseClient,
  opts: { q?: string } = {}
): Promise<{ properties: MapProperty[]; branches: MapBranch[]; pendingCount: number }> {
  const q = (opts.q ?? '').trim();

  let propsQuery = supabase
    .from('properties')
    .select('id, name, address, city, lat, lng, service_type, est_labor_hours, contract_start_date, contract_end_date')
    .eq('is_active', true)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .limit(2000);
  if (q) propsQuery = propsQuery.ilike('name', `%${q}%`);

  const branchesQuery = supabase
    .from('branches')
    .select('id, name, address, city, lat, lng')
    .eq('is_active', true);

  const pendingQuery = supabase
    .from('properties')
    .select('*', { count: 'exact', head: true })
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
```

- [ ] **Step 2: Refactor `src/app/properties/page.tsx` to use the helper — edit the imports**

Replace this import line:
```tsx
import type { MapBranch, MapProperty } from './properties-map';
```
with:
```tsx
import { getPropertyMapData } from './map-data';
```
(`MapBranch`/`MapProperty` are no longer referenced directly in this file; `Property` stays for the list.)

- [ ] **Step 3: Replace the inline map queries + mapping block**

Find the block that begins with the comment `// Map query (all geocoded, slim columns) — only fired when needed.` and ends at the construction of `mapBranches` (the `.map(...)` producing `mapBranches`). Replace that ENTIRE block with:

```tsx
  const lastImportP = supabase
    .from('import_runs')
    .select('id, filename, inserted_count, updated_count, skipped_count, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const [{ data, count, error }, { data: lastImport }, mapData] = await Promise.all([
    listQuery,
    lastImportP,
    view === 'map'
      ? getPropertyMapData(supabase, { q })
      : Promise.resolve({ properties: [], branches: [], pendingCount: 0 }),
  ]);

  const properties = (data ?? []) as Property[];
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const ungeocoded = properties.filter((p) => p.lat == null).length;

  const mapProperties = mapData.properties;
  const mapBranches = mapData.branches;
  const pendingCount = mapData.pendingCount;
```

This removes the old `mapPropsP` / `branchesP` / `pendingCountP` definitions, the old `Promise.all([...])` destructuring, and the old `mapProperties`/`mapBranches` mapping (now inside the helper). The JSX further down that references `mapProperties`, `mapBranches`, and `pendingCount` is unchanged.

- [ ] **Step 4: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass; `/properties` still listed. (If lint flags an unused `Property` import, confirm `Property` is still used by the list cast `as Property[]` — it is — so keep it.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/properties/map-data.ts" "src/app/properties/page.tsx"
git commit -m "refactor: extract shared getPropertyMapData helper"
```

---

## Task 3: Filter bar component

**Files:**
- Create: `src/app/properties/map-filters.tsx`

- [ ] **Step 1: Create `src/app/properties/map-filters.tsx`**

```tsx
'use client';
import { useEffect, useRef, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { ServiceType } from '@/lib/types';
import type { ContractFilter } from '@/lib/property-filters';

export const SERVICE_COLORS: Record<ServiceType, string> = {
  weekly: '#10b981', // emerald-500
  biweekly: '#f59e0b', // amber-500
  monthly: '#3b82f6', // blue-500
};

export const SERVICE_LABELS: Record<ServiceType, string> = {
  weekly: 'Weekly MT',
  biweekly: 'Bi-Weekly',
  monthly: 'Monthly MT',
};

export interface MapFiltersProps {
  services: Record<ServiceType, boolean>;
  onServiceChange: (st: ServiceType, v: boolean) => void;
  cityOptions: Array<{ city: string; count: number }>;
  selectedCities: string[] | null;
  onCitiesChange: (cities: string[] | null) => void;
  contract: ContractFilter;
  onContractChange: (c: ContractFilter) => void;
}

const CONTRACT_OPTIONS: Array<{ value: ContractFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

export function MapFilters({
  services,
  onServiceChange,
  cityOptions,
  selectedCities,
  onCitiesChange,
  contract,
  onContractChange,
}: MapFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <CityMultiSelect options={cityOptions} selected={selectedCities} onChange={onCitiesChange} />

      <div className="inline-flex rounded-md border p-0.5 text-sm">
        {CONTRACT_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => onContractChange(o.value)}
            className={cn(
              'rounded px-2.5 py-1 transition-colors',
              contract === o.value
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {(['weekly', 'biweekly', 'monthly'] as ServiceType[]).map((st) => {
          const id = `svc-${st}`;
          return (
            <div key={st} className="flex items-center gap-2">
              <Switch id={id} checked={services[st]} onCheckedChange={(v) => onServiceChange(st, v)} />
              <Label htmlFor={id} className="flex cursor-pointer items-center gap-1.5">
                <span className="inline-block h-3 w-3 rounded-full" style={{ background: SERVICE_COLORS[st] }} />
                {SERVICE_LABELS[st]}
              </Label>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CityMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: Array<{ city: string; count: number }>;
  selected: string[] | null;
  onChange: (cities: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allCities = options.map((o) => o.city);
  const isAll = selected === null;
  const isChecked = (city: string) => isAll || selected.includes(city);
  const label = isAll ? 'All cities' : `${selected.length} ${selected.length === 1 ? 'city' : 'cities'}`;

  const toggleCity = (city: string) => {
    const current = isAll ? allCities : selected;
    const next = current.includes(city) ? current.filter((c) => c !== city) : [...current, city];
    onChange(next.length === allCities.length ? null : next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
      >
        City: <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-60 overflow-auto rounded-md border bg-background p-2 shadow-md">
          <div className="mb-2 flex gap-2 border-b pb-2">
            <button onClick={() => onChange(null)} className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              All
            </button>
            <button onClick={() => onChange([])} className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">
              None
            </button>
          </div>
          {options.length === 0 && <div className="px-1 py-2 text-xs text-muted-foreground">No cities</div>}
          {options.map((o) => (
            <label key={o.city} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
              <input
                type="checkbox"
                checked={isChecked(o.city)}
                onChange={() => toggleCity(o.city)}
                className="h-3.5 w-3.5"
              />
              <span className="flex-1">{o.city}</span>
              <span className="text-xs text-muted-foreground">{o.count}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: pass (component not yet imported anywhere; that's fine).

- [ ] **Step 3: Commit**

```bash
git add "src/app/properties/map-filters.tsx"
git commit -m "feat: property map filter bar (city multiselect, contract, service)"
```

---

## Task 4: Wire filters into the map component

**Files:**
- Modify: `src/app/properties/properties-map.tsx`

- [ ] **Step 1: Update imports** — replace the existing service-constant definitions and add new imports.

Add these imports near the top (after the existing `import type { ServiceType } from '@/lib/types';` line):
```tsx
import { cn } from '@/lib/utils';
import { MapFilters, SERVICE_COLORS, SERVICE_LABELS } from './map-filters';
import { distinctCities, matchesFilters, type ContractFilter } from '@/lib/property-filters';
```

Then DELETE the now-duplicated local constant declarations in this file:
```tsx
const SERVICE_COLORS: Record<ServiceType, string> = {
  weekly: '#10b981', // emerald-500
  biweekly: '#f59e0b', // amber-500
  monthly: '#3b82f6', // blue-500
};

const SERVICE_LABELS: Record<ServiceType, string> = {
  weekly: 'Weekly MT',
  biweekly: 'Bi-Weekly',
  monthly: 'Monthly MT',
};
```
(`BRANCH_COLOR` stays. `SERVICE_COLORS`/`SERVICE_LABELS` now come from `./map-filters`.)

- [ ] **Step 2: Add reuse props to `PropertiesMapProps`**

Find:
```tsx
export interface PropertiesMapProps {
  properties: MapProperty[];
  branches: MapBranch[];
  pendingCount: number;
}
```
Replace with:
```tsx
export interface PropertiesMapProps {
  properties: MapProperty[];
  branches: MapBranch[];
  pendingCount: number;
  heightClass?: string;
  fullMapHref?: string;
}
```

- [ ] **Step 3: Update component signature + filter state**

Find:
```tsx
export default function PropertiesMap({ properties, branches, pendingCount }: PropertiesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  const [filters, setFilters] = useState<Record<ServiceType, boolean>>({
    weekly: true,
    biweekly: true,
    monthly: true,
  });

  const filtered = useMemo(
    () => properties.filter((p) => filters[p.service_type]),
    [properties, filters]
  );
```
Replace with:
```tsx
export default function PropertiesMap({
  properties,
  branches,
  pendingCount,
  heightClass = 'h-[640px]',
  fullMapHref,
}: PropertiesMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  const [services, setServices] = useState<Record<ServiceType, boolean>>({
    weekly: true,
    biweekly: true,
    monthly: true,
  });
  const [selectedCities, setSelectedCities] = useState<string[] | null>(null);
  const [contract, setContract] = useState<ContractFilter>('all');

  const today = useMemo(() => new Date(), []);
  const cityOptions = useMemo(() => distinctCities(properties), [properties]);

  const filtered = useMemo(
    () => properties.filter((p) => matchesFilters(p, { cities: selectedCities, services, contract }, today)),
    [properties, selectedCities, services, contract, today]
  );
```

- [ ] **Step 4: Replace the inline service-toggle markup in the header with `<MapFilters>`**

Find this block inside the `CardHeader`:
```tsx
          <div className="flex flex-wrap items-center gap-4">
            {(['weekly', 'biweekly', 'monthly'] as ServiceType[]).map((st) => (
              <ServiceToggle
                key={st}
                color={SERVICE_COLORS[st]}
                label={SERVICE_LABELS[st]}
                checked={filters[st]}
                onChange={(v) => setFilters((prev) => ({ ...prev, [st]: v }))}
              />
            ))}
          </div>
```
Replace with:
```tsx
          <MapFilters
            services={services}
            onServiceChange={(st, v) => setServices((prev) => ({ ...prev, [st]: v }))}
            cityOptions={cityOptions}
            selectedCities={selectedCities}
            onCitiesChange={setSelectedCities}
            contract={contract}
            onContractChange={setContract}
          />
```

- [ ] **Step 5: Delete the now-unused local `ServiceToggle` component**

Find and DELETE this entire function (it has been replaced by `MapFilters`):
```tsx
function ServiceToggle({
  color,
  label,
  checked,
  onChange,
}: {
  color: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = `svc-${label.replace(/\s/g, '-').toLowerCase()}`;
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="flex cursor-pointer items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full" style={{ background: color }} />
        {label}
      </Label>
    </div>
  );
}
```
Also remove the now-unused `Switch`/`Label` imports IF they are no longer referenced elsewhere in this file (they are only used by `ServiceToggle`, so remove `import { Switch } from '@/components/ui/switch';` and `import { Label } from '@/components/ui/label';`). Verify with a search before deleting.

- [ ] **Step 6: Apply `heightClass` to the map container and add the optional full-map link**

Find:
```tsx
        <div ref={containerRef} className="h-[640px] w-full overflow-hidden rounded-md border" />
```
Replace with:
```tsx
        <div ref={containerRef} className={cn(heightClass, 'w-full overflow-hidden rounded-md border')} />
```

Then, to expose the optional "open full map" link, find the closing of the description `</CardDescription>` block within the first `<div>` of the `CardHeader` and add the link right after that `<div>` closes (i.e., as a sibling before the filter bar). Concretely, find:
```tsx
          <div>
            <CardTitle>Property map</CardTitle>
            <CardDescription>
              Showing <strong>{filtered.length}</strong> of {properties.length} geocoded properties
              {pendingCount > 0 && (
                <span className="ml-2 text-amber-700">
                  · {pendingCount} pending geocode (not on map)
                </span>
              )}
            </CardDescription>
          </div>
```
Replace with:
```tsx
          <div>
            <CardTitle>Property map</CardTitle>
            <CardDescription>
              Showing <strong>{filtered.length}</strong> of {properties.length} geocoded properties
              {pendingCount > 0 && (
                <span className="ml-2 text-amber-700">
                  · {pendingCount} pending geocode (not on map)
                </span>
              )}
            </CardDescription>
            {fullMapHref && (
              <a href={fullMapHref} className="text-xs font-medium text-primary hover:underline">
                View all in Properties →
              </a>
            )}
          </div>
```

- [ ] **Step 7: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass. (If lint reports unused `ServiceType` import — it is still used by the `services` state type and the `as ServiceType[]` cast inside `MapFilters`? No: that cast now lives in `map-filters.tsx`. `ServiceType` is still used in `properties-map.tsx` by `Record<ServiceType, boolean>` and the `SERVICE_COLORS`/`SERVICE_LABELS` typed imports and the GeoJSON `service_type` match expression — keep it.)

- [ ] **Step 8: Commit**

```bash
git add "src/app/properties/properties-map.tsx"
git commit -m "feat: city + contract filters on the property map; reuse props"
```

---

## Task 5: Embed the map on the Overview page

**Files:**
- Modify: `src/app/page.tsx` (full replacement)

- [ ] **Step 1: Replace `src/app/page.tsx` entirely with:**

```tsx
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { getPropertyMapData } from './properties/map-data';
import { PropertiesMapLoader } from './properties/properties-map-loader';

export const dynamic = 'force-dynamic';

async function getCounts() {
  const supabase = getServerClient();
  const [{ count: propCount }, { count: crewCount }, { count: branchCount }, { data: latestRun }, mapData] =
    await Promise.all([
      supabase.from('properties').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('crews').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('branches').select('*', { count: 'exact', head: true }).eq('is_active', true),
      supabase
        .from('optimization_runs')
        .select('id, name, status, created_at, capacity_recommendation')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      getPropertyMapData(supabase),
    ]);

  return {
    propCount: propCount ?? 0,
    crewCount: crewCount ?? 0,
    branchCount: branchCount ?? 0,
    latestRun,
    mapData,
  };
}

export default async function HomePage() {
  let data: Awaited<ReturnType<typeof getCounts>> | null = null;
  let error: string | null = null;
  try {
    data = await getCounts();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not connect to Supabase';
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">TruCo Route Optimizer</h1>
        <p className="mt-2 text-muted-foreground">
          Strategic routing analysis for the 30-crew landscape maintenance portfolio. Capacity planning and bid analysis.
        </p>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Supabase not connected</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code>,
            then run the migrations under <code>supabase/migrations/</code>.
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Properties" value={data.propCount} href="/properties" />
          <StatCard label="Crews" value={data.crewCount} href="/crews" />
          <StatCard label="Branches" value={data.branchCount} href="/branches" />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Latest optimization run</CardTitle>
          <CardDescription>Most recent solver result</CardDescription>
        </CardHeader>
        <CardContent>
          {data?.latestRun ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{data.latestRun.name}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(data.latestRun.created_at).toLocaleString()} · {data.latestRun.status}
                  {data.latestRun.capacity_recommendation && ` · ${data.latestRun.capacity_recommendation}`}
                </div>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/runs/${data.latestRun.id}`}>View</Link>
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">No optimization runs yet.</p>
              <Button asChild size="sm">
                <Link href="/optimize">Run optimization</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {data && data.mapData.properties.length > 0 && (
        <PropertiesMapLoader
          properties={data.mapData.properties}
          branches={data.mapData.branches}
          pendingCount={data.mapData.pendingCount}
          heightClass="h-[460px]"
          fullMapHref="/properties?view=map"
        />
      )}
    </div>
  );
}

function StatCard({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:border-primary/40">
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
        </CardHeader>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 2: Verify typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: all pass; `/` route still listed.

- [ ] **Step 3: Commit**

```bash
git add "src/app/page.tsx"
git commit -m "feat: embed filterable property map on the Overview page"
```

---

## Task 6: Verification + final review

**Files:** none (verification only).

- [ ] **Step 1: Full automated suite**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: tests pass (Task 1 module green), no type/lint errors, build compiles with `/` and `/properties` listed.

- [ ] **Step 2: Manual verification** — `npm run dev`, then:
  - On `/` (Overview): the property map renders below the latest-run card; "View all in Properties →" link navigates to `/properties?view=map`.
  - On `/properties?view=map`: the filter bar shows City / contract segmented / service toggles.
  - City multiselect: opens, All/None work, checking a subset narrows the map points + the "Showing X of Y" count; clicking outside closes it.
  - Contract All/Active/Inactive changes the visible set.
  - Service toggles still work.
  - With `NEXT_PUBLIC_MAPBOX_TOKEN` unset, the "Map unavailable" card shows.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: property map filter verification fixes"
```

---

## Self-Review

**Spec coverage:**
- Reusable component on both pages → Task 4 (props) + Task 5 (Overview) + existing `/properties`.
- City filter → Task 1 (`distinctCities`, `matchesFilters`) + Task 3 (`CityMultiSelect`) + Task 4 (wiring).
- Service type filter kept → Task 3 (`MapFilters`) + Task 4.
- Contract status filter → Task 1 (`contractStatusOf`) + Task 3 (segmented) + Task 4.
- Client-side filtering over loaded set → Task 4 (`filtered` useMemo).
- Shared server data helper → Task 2.
- Geocode handled as badge (not plottable) → unchanged in Task 4 (the pending-count badge stays).
- Dropped State/Branch/crew filters → not implemented (correct).
- vitest on pure module → Task 1.

**Placeholder scan:** none — all steps have complete code/edits and exact commands.

**Type consistency:** `FilterState` (Task 1) is consumed in Task 4 as `{ cities, services, contract }`. `ContractFilter` flows Task 1 → Task 3 (`MapFilters`/segmented) → Task 4 (`contract` state). `SERVICE_COLORS`/`SERVICE_LABELS` defined once in `map-filters.tsx` (Task 3), imported by `properties-map.tsx` (Task 4). `getPropertyMapData` return shape `{ properties, branches, pendingCount }` is consumed in Task 2 (`/properties`) and Task 5 (Overview) identically. `MapProperty`/`MapBranch` remain defined/exported in `properties-map.tsx` and imported by `map-data.ts`.
