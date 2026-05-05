'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { ServiceType } from '@/lib/types';

export interface MapProperty {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  service_type: ServiceType;
  est_labor_hours: number;
  contract_start_date: string | null;
  contract_end_date: string | null;
}

export interface MapBranch {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
}

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

const BRANCH_COLOR = '#ef4444'; // red-500

export interface PropertiesMapProps {
  properties: MapProperty[];
  branches: MapBranch[];
  pendingCount: number;
}

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

  const stats = useMemo(() => computeStats(filtered), [filtered]);

  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;

    mapboxgl.accessToken = token;

    const initial = bestInitialView(properties, branches);

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: initial.center,
      zoom: initial.zoom,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      // Properties source w/ clustering
      map.addSource('properties', {
        type: 'geojson',
        data: toPropertiesGeoJSON(filtered),
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 50,
      });

      map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'properties',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#475569',
          'circle-opacity': 0.85,
          'circle-radius': ['step', ['get', 'point_count'], 16, 25, 22, 75, 28],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      });

      map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'properties',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-size': 12,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': '#fff' },
      });

      map.addLayer({
        id: 'property-points',
        type: 'circle',
        source: 'properties',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': [
            'match',
            ['get', 'service_type'],
            'weekly', SERVICE_COLORS.weekly,
            'biweekly', SERVICE_COLORS.biweekly,
            'monthly', SERVICE_COLORS.monthly,
            '#9ca3af',
          ],
          'circle-radius': 7,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
        },
      });

      // Branches
      map.addSource('branches', {
        type: 'geojson',
        data: toBranchesGeoJSON(branches),
      });

      map.addLayer({
        id: 'branch-points',
        type: 'circle',
        source: 'branches',
        paint: {
          'circle-color': BRANCH_COLOR,
          'circle-radius': 11,
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
        },
      });

      // Click → popup on a property
      map.on('click', 'property-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const props = f.properties as Record<string, string | number | null>;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(propertyPopupHtml(props))
          .addTo(map);
      });

      // Click → zoom into cluster
      map.on('click', 'clusters', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (clusterId == null) return;
        const source = map.getSource('properties') as mapboxgl.GeoJSONSource;
        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err || features[0].geometry.type !== 'Point') return;
          map.easeTo({
            center: features[0].geometry.coordinates as [number, number],
            zoom: zoom ?? map.getZoom() + 1,
          });
        });
      });

      // Click → branch popup
      map.on('click', 'branch-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const props = f.properties as Record<string, string | null>;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(branchPopupHtml(props))
          .addTo(map);
      });

      // Cursor affordance
      const cursorOn = () => (map.getCanvas().style.cursor = 'pointer');
      const cursorOff = () => (map.getCanvas().style.cursor = '');
      for (const layer of ['clusters', 'property-points', 'branch-points']) {
        map.on('mouseenter', layer, cursorOn);
        map.on('mouseleave', layer, cursorOff);
      }

      // Auto-fit to data
      const bounds = boundsOf(properties, branches);
      if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });

      setStyleReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // We deliberately omit `properties`, `branches`, `filtered` — the map should init exactly once.
    // Subsequent data updates flow through the source.setData effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Push filter changes to the source.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const source = map.getSource('properties') as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(toPropertiesGeoJSON(filtered));
  }, [filtered, styleReady]);

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Map unavailable</CardTitle>
          <CardDescription>
            <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> is not set in this environment.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
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
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div ref={containerRef} className="h-[640px] w-full overflow-hidden rounded-md border" />
        <StatsPanel stats={stats} />
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <Legend color={SERVICE_COLORS.weekly} label="Weekly" />
          <Legend color={SERVICE_COLORS.biweekly} label="Bi-Weekly" />
          <Legend color={SERVICE_COLORS.monthly} label="Monthly" />
          <Legend color={BRANCH_COLOR} label="Branches" outline />
        </div>
      </CardContent>
    </Card>
  );
}

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

function Legend({ color, label, outline }: { color: string; label: string; outline?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-3 w-3 rounded-full"
        style={{ background: color, boxShadow: outline ? '0 0 0 2px #fff inset, 0 0 0 1px #94a3b8' : undefined }}
      />
      {label}
    </span>
  );
}

interface Stats {
  count: number;
  bbox: { nsMiles: number; ewMiles: number } | null;
  centroid: { lat: number; lng: number } | null;
}

function computeStats(props: MapProperty[]): Stats {
  if (props.length === 0) return { count: 0, bbox: null, centroid: null };
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  let sumLat = 0, sumLng = 0;
  for (const p of props) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    sumLat += p.lat;
    sumLng += p.lng;
  }
  const avgLat = sumLat / props.length;
  const avgLng = sumLng / props.length;
  const nsMiles = (maxLat - minLat) * 69;
  const ewMiles = (maxLng - minLng) * Math.cos((avgLat * Math.PI) / 180) * 69;
  return {
    count: props.length,
    bbox: { nsMiles, ewMiles },
    centroid: { lat: avgLat, lng: avgLng },
  };
}

function StatsPanel({ stats }: { stats: Stats }) {
  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3 text-sm sm:grid-cols-3">
      <Stat label="Properties on map" value={stats.count.toLocaleString()} />
      <Stat
        label="Bounding box"
        value={
          stats.bbox
            ? `${stats.bbox.nsMiles.toFixed(0)} mi N–S × ${stats.bbox.ewMiles.toFixed(0)} mi E–W`
            : '—'
        }
      />
      <Stat
        label="Centroid"
        value={stats.centroid ? `${stats.centroid.lat.toFixed(4)}, ${stats.centroid.lng.toFixed(4)}` : '—'}
        mono
      />
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{value}</div>
    </div>
  );
}

function toPropertiesGeoJSON(props: MapProperty[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: props.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: {
        id: p.id,
        name: p.name,
        address: p.address,
        city: p.city,
        service_type: p.service_type,
        est_labor_hours: p.est_labor_hours,
        contract_start_date: p.contract_start_date,
        contract_end_date: p.contract_end_date,
      },
    })),
  };
}

function toBranchesGeoJSON(branches: MapBranch[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: branches.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: { id: b.id, name: b.name, address: b.address, city: b.city },
    })),
  };
}

function bestInitialView(properties: MapProperty[], branches: MapBranch[]): { center: [number, number]; zoom: number } {
  const all: Array<[number, number]> = [
    ...properties.map((p): [number, number] => [p.lng, p.lat]),
    ...branches.map((b): [number, number] => [b.lng, b.lat]),
  ];
  if (all.length === 0) return { center: [-111.89, 40.76], zoom: 9 }; // SLC fallback
  const lngs = all.map((c) => c[0]);
  const lats = all.map((c) => c[1]);
  return {
    center: [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2],
    zoom: 9,
  };
}

function boundsOf(properties: MapProperty[], branches: MapBranch[]): mapboxgl.LngLatBounds | null {
  const all: Array<[number, number]> = [
    ...properties.map((p): [number, number] => [p.lng, p.lat]),
    ...branches.map((b): [number, number] => [b.lng, b.lat]),
  ];
  if (all.length === 0) return null;
  const bounds = new mapboxgl.LngLatBounds();
  for (const c of all) bounds.extend(c);
  return bounds;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

function propertyPopupHtml(props: Record<string, string | number | null>): string {
  const name = String(props.name ?? '');
  const address = String(props.address ?? '');
  const city = String(props.city ?? '');
  const svc = String(props.service_type ?? '') as ServiceType;
  const hours = props.est_labor_hours == null ? '—' : `${Number(props.est_labor_hours).toFixed(1)}h`;
  const start = props.contract_start_date ? String(props.contract_start_date) : null;
  const end = props.contract_end_date ? String(props.contract_end_date) : null;
  const label = SERVICE_LABELS[svc] ?? svc;
  const color = SERVICE_COLORS[svc] ?? '#9ca3af';
  const dates = start || end ? `${start ?? '—'} → ${end ?? '—'}` : 'No contract dates';
  const detailsHref = `/properties?q=${encodeURIComponent(name)}`;

  return `
    <div style="font-family:inherit;min-width:220px;line-height:1.45">
      <div style="font-weight:600;margin-bottom:2px">${escapeHtml(name)}</div>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">${escapeHtml(address)}, ${escapeHtml(city)}</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
        <span>${escapeHtml(label)} · ${escapeHtml(hours)}</span>
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:8px">${escapeHtml(dates)}</div>
      <a href="${detailsHref}" style="font-size:12px;color:#16a34a;text-decoration:none;font-weight:500">View in list →</a>
    </div>`;
}

function branchPopupHtml(props: Record<string, string | null>): string {
  const name = String(props.name ?? '');
  const address = String(props.address ?? '');
  const city = String(props.city ?? '');
  return `
    <div style="font-family:inherit;min-width:200px;line-height:1.45">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${BRANCH_COLOR};box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px #cbd5e1"></span>
        <span style="font-weight:600">${escapeHtml(name)}</span>
      </div>
      <div style="font-size:12px;color:#64748b">${escapeHtml(address)}, ${escapeHtml(city)}</div>
      <div style="font-size:11px;color:#64748b;margin-top:4px">Branch / depot</div>
    </div>`;
}
