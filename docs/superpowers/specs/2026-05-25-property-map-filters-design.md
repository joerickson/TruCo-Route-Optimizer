# Shared Filterable Property Map — Design Spec

**Date:** 2026-05-25
**Status:** Approved (design)
**Scope:** Make the existing property map a reusable, filterable component; add
richer filters (city, contract status) alongside the existing service-type filter;
and embed the same map on the Overview page.

This is **Feature A** of three planned (A: property map filters · B: calendar/week
view · C: coach). B and C are separate spec → plan → build cycles and are NOT in
this spec.

## 1. Goal & scope

- One reusable, filterable property-map component, used on **both** the Overview
  page (`/`) and the Properties map view (`/properties?view=map`).
- Filters, all backed by real data: **City** (multi-select), **Service type**
  (existing, kept), **Contract status** (active / inactive / all).
- Filtering is **client-side**: the full geocoded set (~570 properties) is already
  loaded for clustering, so filters apply instantly with no server round-trips and
  the single-map-init model is preserved.

### Out of scope

- **State filter** — every imported property has `state = 'UT'` (hardcoded in
  `src/lib/csv-import.ts:120`); a state filter would be single-valued. Dropped.
- **Branch filter** — `properties.preferred_branch_id` is never populated (only the
  type references it); a branch filter would be empty. Dropped.
- **Crew filter** — crews aren't stored on properties (assignments live only in a
  run's `routes_jsonb`); crew visualization stays on the routes map. Dropped here.
- **Geocode as a plottable filter** — ungeocoded properties have null coordinates
  and cannot be placed on a map. Handled as the existing informational badge
  ("N pending geocode (not on map)"). Actually plotting them requires the deferred
  city-centroid fallback — not in this spec.
- Calendar/week view and coach (separate features).

## 2. Background / current state

- `src/app/properties/properties-map.tsx` is a self-contained client component:
  Mapbox init keyed on `NEXT_PUBLIC_MAPBOX_TOKEN`, GeoJSON sources with clustering,
  service-type `Switch` filters, popups (via `escapeHtml`), a `StatsPanel`
  (count / bbox / centroid), a legend, and fit-bounds. Data updates flow through
  `source.setData`.
- `src/app/properties/properties-map-loader.tsx` lazy-loads it
  (`dynamic(import, { ssr: false })`).
- `src/app/properties/page.tsx` fetches slim map data when `view === 'map'`:
  properties (`id, name, address, city, lat, lng, service_type, est_labor_hours,
  contract_start_date, contract_end_date`), branches (`id, name, address, city,
  lat, lng`), and a `pendingCount` (active properties with null `lat`).
- `MapProperty` already carries `city`, `service_type`, `contract_start_date`, and
  `contract_end_date` — so **no prop-shape change** is needed for the new filters.
- `src/app/page.tsx` (Overview) currently shows three stat cards + a "latest run"
  card. No map.

## 3. Architecture & data flow

1. A pure module `src/lib/property-filters.ts` holds all filter logic (no React,
   no Mapbox): contract-status classification, distinct-city extraction, and the
   combined predicate.
2. A server helper `src/lib/property-map-data.ts` fetches the slim properties +
   branches + pending count once, so both pages share identical queries (DRY).
3. The map component (`properties-map.tsx`) holds filter **state** (selected
   cities, service toggles, contract status), renders a filter bar
   (`map-filters.tsx`), applies `matchesFilters` to produce the visible set, and
   pushes that set to the GeoJSON source via `setData` — exactly the existing
   pattern, with the predicate widened.
4. Both `/properties` (map view) and `/` (Overview) call `getPropertyMapData` and
   render `<PropertiesMapLoader …>`. Overview uses a shorter map height and shows a
   "View all in Properties" link.

## 4. Files

New:
- `src/lib/property-filters.ts` — pure filter logic.
- `src/lib/property-filters.test.ts` — vitest unit tests.
- `src/lib/property-map-data.ts` — server data helper.
- `src/app/properties/map-filters.tsx` — presentational filter bar.

Modified:
- `src/app/properties/properties-map.tsx` — widen filtering; render `MapFilters`;
  add optional `heightClass` and optional `fullMapHref` props for reuse.
- `src/app/properties/properties-map-loader.tsx` — pass through the new optional
  props.
- `src/app/properties/page.tsx` — use `getPropertyMapData`; behavior unchanged.
- `src/app/page.tsx` — add a map card via the shared loader + `getPropertyMapData`.

## 5. Pure filter module (`property-filters.ts`)

Types and functions (no React/Mapbox/IO):

```ts
export type ContractStatus = 'active' | 'inactive';
export type ContractFilter = 'all' | 'active' | 'inactive';

export interface FilterState {
  cities: string[] | null;          // null or [] => all cities
  services: Record<ServiceType, boolean>;
  contract: ContractFilter;
}

// A property is "active" if today is within [start, end], treating a null start
// as -infinity and a null end as +infinity. Otherwise "inactive" (expired or
// not-yet-started).
export function contractStatusOf(
  p: { contract_start_date: string | null; contract_end_date: string | null },
  today: Date
): ContractStatus;

// Distinct cities with counts, sorted by name. Used to build the city multi-select.
export function distinctCities(
  props: Array<{ city: string }>
): Array<{ city: string; count: number }>;

// Combined predicate: city ∈ selection (or all), service type enabled, contract
// status matches the contract filter.
export function matchesFilters(
  p: { city: string; service_type: ServiceType; contract_start_date: string | null; contract_end_date: string | null },
  state: FilterState,
  today: Date
): boolean;
```

`today` is injected (not read inside) so the logic is deterministic and testable;
the component passes `new Date()`.

## 6. Filter bar (`map-filters.tsx`)

A presentational component (props in, callbacks out) rendering:
- **Service type:** the existing three `Switch`es (weekly / biweekly / monthly) with
  color dots — moved here unchanged.
- **City:** a multi-select using the existing `dropdown-menu` primitive — a
  checkbox item per city with its count, plus "All" / "None". Label shows
  "All cities" or "N cities".
- **Contract:** a small segmented control (three buttons): All / Active / Inactive.

It owns no state; the map component passes current values + setters.

## 7. Map component changes (`properties-map.tsx`)

- Replace the inline service-toggle markup with `<MapFilters …>`.
- Filter state: `cities: string[] | null`, the existing `services` record, and
  `contract: ContractFilter` (default `'all'`).
- `filtered = useMemo(() => properties.filter((p) => matchesFilters(p, state, today)))`
  where `today = useMemo(() => new Date(), [])`.
- City options from `distinctCities(properties)`.
- Stats panel, legend, clustering, popups, fit-bounds: unchanged (they already
  operate on `filtered`).
- New optional props:
  - `heightClass?: string` (default `'h-[640px]'`) — Overview passes a shorter value.
  - `fullMapHref?: string` — when set, render a "View all in Properties →" link in
    the card header (used on Overview).
- The "showing X of Y" description and the pending-geocode badge stay.

## 8. Server data helper (`property-map-data.ts`)

```ts
export async function getPropertyMapData(
  supabase: SupabaseClient,
  opts?: { q?: string }
): Promise<{ properties: MapProperty[]; branches: MapBranch[]; pendingCount: number }>;
```

Encapsulates the three queries currently inline in `properties/page.tsx`
(geocoded active properties with the slim column set + optional name `ilike`;
active branches; head-count of active properties with null `lat`), returning the
already-coerced `MapProperty`/`MapBranch` shapes. `properties/page.tsx` is
refactored to call it (no behavior change). Overview calls it with no `q`.

## 9. Overview integration (`page.tsx`)

Add a map card below the stat cards:
- Server-side: call `getPropertyMapData(supabase)`.
- Render `<PropertiesMapLoader properties branches pendingCount heightClass="h-[460px]" fullMapHref="/properties?view=map" />`.
- If the Supabase fetch fails, the existing error card path covers it; the map card
  is simply omitted when there's no data.

## 10. Testing

- vitest on `property-filters.ts`:
  - `contractStatusOf`: today before start → inactive; today after end → inactive;
    today within → active; null start (open-started) → active if today ≤ end;
    null end (open-ended) → active if today ≥ start; both null → active; today
    exactly equal to start and to end → active (inclusive bounds).
  - `distinctCities`: counts and sort order; handles duplicates.
  - `matchesFilters`: city selection (null/empty = all; specific list), service
    toggle off excludes, contract filter all/active/inactive, and combinations.
- Map/React/Mapbox layer and the Overview embed are verified manually (filters
  apply, city multiselect works, contract segmented switches the set, Overview map
  renders and the link navigates, token-missing guard shows).

## 11. Risks / notes

- **Many cities:** at ~570 Utah properties the distinct-city list is modest
  (tens). The dropdown checkbox list handles that comfortably; no virtualization
  needed.
- **"today" semantics:** contract status uses the client's current date. Acceptable
  for a planning tool; documented and injected for testability.
- **Geocode honesty:** ungeocoded properties remain off the map (badge only),
  consistent with current behavior; not a regression.
- **No solver or DB changes**; purely web-app additive work.
