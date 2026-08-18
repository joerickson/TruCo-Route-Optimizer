'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface SnowMapProperty {
  id: string;
  name: string;
  address: string;
  city: string;
  lat: number;
  lng: number;
  tier: string | null;
  has_sidewalk: boolean;
}

export interface SnowMapBranch {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface SnowMapProps {
  properties: SnowMapProperty[];
  branches: SnowMapBranch[];
  heightClass?: string;
}

const BRANCH_COLOR = '#ef4444';
// Tier priority palette (1 = highest). Unrated falls through to gray.
const TIER_COLORS: Record<string, string> = { '1': '#dc2626', '2': '#f59e0b', '3': '#2563eb' };
const UNRATED_COLOR = '#9ca3af';
const SIDEWALK_RING = '#0f172a';

export default function SnowMap({ properties, branches, heightClass = 'h-[560px]' }: SnowMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [, setStyleReady] = useState(false);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

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
      map.addSource('properties', {
        type: 'geojson',
        data: toGeoJSON(properties),
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
            ['get', 'tier'],
            '1', TIER_COLORS['1'],
            '2', TIER_COLORS['2'],
            '3', TIER_COLORS['3'],
            UNRATED_COLOR,
          ],
          'circle-radius': 7,
          // A dark ring marks properties with sidewalks (sidewalk-fleet stops).
          'circle-stroke-width': ['case', ['get', 'has_sidewalk'], 2.5, 1.2],
          'circle-stroke-color': ['case', ['get', 'has_sidewalk'], SIDEWALK_RING, '#fff'],
        },
      });

      map.addSource('branches', { type: 'geojson', data: toBranchGeoJSON(branches) });
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

      map.on('click', 'property-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(popupHtml((f.properties ?? {}) as Record<string, unknown>))
          .addTo(map);
      });
      map.on('click', 'clusters', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        const clusterId = features[0]?.properties?.cluster_id;
        if (clusterId == null) return;
        const source = map.getSource('properties') as mapboxgl.GeoJSONSource;
        source.getClusterExpansionZoom(clusterId, (err, zoom) => {
          if (err || features[0].geometry.type !== 'Point') return;
          map.easeTo({ center: features[0].geometry.coordinates as [number, number], zoom: zoom ?? map.getZoom() + 1 });
        });
      });

      const cursorOn = () => (map.getCanvas().style.cursor = 'pointer');
      const cursorOff = () => (map.getCanvas().style.cursor = '');
      for (const layer of ['clusters', 'property-points', 'branch-points']) {
        map.on('mouseenter', layer, cursorOn);
        map.on('mouseleave', layer, cursorOff);
      }

      const bounds = boundsOf(properties, branches);
      if (bounds) map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 0 });
      setStyleReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Init once; snow data is static per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

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
        <CardTitle>Property map — by tier</CardTitle>
        <CardDescription>{properties.length} geocoded properties · a dark ring marks sidewalks.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div ref={containerRef} className={cn(heightClass, 'w-full overflow-hidden rounded-md border')} />
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <Legend color={TIER_COLORS['1']} label="Tier 1" />
          <Legend color={TIER_COLORS['2']} label="Tier 2" />
          <Legend color={TIER_COLORS['3']} label="Tier 3" />
          <Legend color={UNRATED_COLOR} label="Unrated" />
          <Legend color={BRANCH_COLOR} label="Branches" outline />
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded-full bg-white"
              style={{ boxShadow: `0 0 0 2.5px ${SIDEWALK_RING}` }}
            />
            Has sidewalks
          </span>
        </div>
      </CardContent>
    </Card>
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

function toGeoJSON(props: SnowMapProperty[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
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
        tier: p.tier ?? '',
        has_sidewalk: p.has_sidewalk,
      },
    })),
  };
}

function toBranchGeoJSON(branches: SnowMapBranch[]): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: branches.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: { id: b.id, name: b.name },
    })),
  };
}

function bestInitialView(
  properties: SnowMapProperty[],
  branches: SnowMapBranch[],
): { center: [number, number]; zoom: number } {
  const all: Array<[number, number]> = [
    ...properties.map((p): [number, number] => [p.lng, p.lat]),
    ...branches.map((b): [number, number] => [b.lng, b.lat]),
  ];
  if (all.length === 0) return { center: [-111.89, 40.76], zoom: 9 };
  const lngs = all.map((c) => c[0]);
  const lats = all.map((c) => c[1]);
  return {
    center: [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2],
    zoom: 9,
  };
}

function boundsOf(properties: SnowMapProperty[], branches: SnowMapBranch[]): mapboxgl.LngLatBounds | null {
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
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function popupHtml(props: Record<string, unknown>): string {
  const name = String(props.name ?? '');
  const address = String(props.address ?? '');
  const city = String(props.city ?? '');
  const tier = String(props.tier ?? '');
  const tierLabel = tier ? `Tier ${tier}` : 'Unrated';
  const color = TIER_COLORS[tier] ?? UNRATED_COLOR;
  const sidewalk = props.has_sidewalk === true || props.has_sidewalk === 'true';
  return `
    <div style="font-family:inherit;min-width:210px;line-height:1.45">
      <div style="font-weight:600;margin-bottom:2px">${escapeHtml(name)}</div>
      <div style="font-size:12px;color:#64748b;margin-bottom:8px">${escapeHtml(address)}, ${escapeHtml(city)}</div>
      <div style="display:flex;align-items:center;gap:6px;font-size:12px">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
        <span>${escapeHtml(tierLabel)}${sidewalk ? ' · has sidewalks' : ''}</span>
      </div>
    </div>`;
}
