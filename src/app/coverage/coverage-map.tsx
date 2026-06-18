'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef, useState } from 'react';
import type { MapBranch, MapProperty } from '../properties/properties-map';

export interface CoverageMapProps {
  properties: MapProperty[];
  branches: MapBranch[];
  selectedBranchIds: string[];
  radiusMiles: number;
  matchedIds: Set<string>;
  heightClass?: string;
}

const MATCH_COLOR = '#10b981'; // emerald-500
const DIM_COLOR = '#cbd5e1'; // slate-300
const BRANCH_COLOR = '#ef4444'; // red-500
const CIRCLE_COLOR = '#6366f1'; // indigo-500
const EARTH_RADIUS_MI = 3958.8;

// Approximate a geographic circle of `radiusMiles` as a geodesic polygon ring.
function circleFeature(lng: number, lat: number, radiusMiles: number, points = 64): GeoJSON.Feature {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const angularDistance = radiusMiles / EARTH_RADIUS_MI;
  const latRad = toRad(lat);
  const lngRad = toRad(lng);
  const coords: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const bearing = (i / points) * 2 * Math.PI;
    const pointLat = Math.asin(
      Math.sin(latRad) * Math.cos(angularDistance) +
        Math.cos(latRad) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const pointLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latRad),
        Math.cos(angularDistance) - Math.sin(latRad) * Math.sin(pointLat)
      );
    coords.push([toDeg(pointLng), toDeg(pointLat)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} };
}

function propertiesGeoJSON(properties: MapProperty[], matchedIds: Set<string>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: properties.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, name: p.name, city: p.city, matched: matchedIds.has(p.id) ? 1 : 0 },
    })),
  };
}

function branchesGeoJSON(branches: MapBranch[], selected: Set<string>): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: branches.map((b) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
      properties: { id: b.id, name: b.name, selected: selected.has(b.id) ? 1 : 0 },
    })),
  };
}

function circlesGeoJSON(branches: MapBranch[], selected: Set<string>, radiusMiles: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: branches
      .filter((b) => selected.has(b.id) && radiusMiles > 0)
      .map((b) => circleFeature(b.lng, b.lat, radiusMiles)),
  };
}

export default function CoverageMap({
  properties,
  branches,
  selectedBranchIds,
  radiusMiles,
  matchedIds,
  heightClass = 'h-[560px]',
}: CoverageMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const fittedKeyRef = useRef<string | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  // Init once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;
    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-111.891, 40.7608],
      zoom: 8,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      map.addSource('cov-circles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'cov-circles-fill',
        type: 'fill',
        source: 'cov-circles',
        paint: { 'fill-color': CIRCLE_COLOR, 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'cov-circles-line',
        type: 'line',
        source: 'cov-circles',
        paint: { 'line-color': CIRCLE_COLOR, 'line-width': 1.5, 'line-dasharray': [2, 1] },
      });

      map.addSource('cov-properties', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'cov-properties',
        type: 'circle',
        source: 'cov-properties',
        paint: {
          'circle-color': ['case', ['==', ['get', 'matched'], 1], MATCH_COLOR, DIM_COLOR],
          'circle-radius': ['case', ['==', ['get', 'matched'], 1], 5, 3],
          'circle-opacity': ['case', ['==', ['get', 'matched'], 1], 0.9, 0.4],
          'circle-stroke-width': ['case', ['==', ['get', 'matched'], 1], 1, 0],
          'circle-stroke-color': '#fff',
        },
      });

      map.addSource('cov-branches', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'cov-branches',
        type: 'circle',
        source: 'cov-branches',
        paint: {
          'circle-color': BRANCH_COLOR,
          'circle-radius': 7,
          'circle-opacity': ['case', ['==', ['get', 'selected'], 1], 1, 0.4],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      });

      const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false });
      map.on('mouseenter', 'cov-properties', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const f = e.features?.[0];
        if (!f) return;
        const props = f.properties as { name?: string; city?: string };
        const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        popup.setLngLat(coords).setHTML(`<strong>${props.name ?? ''}</strong><br/>${props.city ?? ''}`).addTo(map);
      });
      map.on('mouseleave', 'cov-properties', () => {
        map.getCanvas().style.cursor = '';
        popup.remove();
      });

      setStyleReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [token]);

  // Push data whenever inputs change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const selected = new Set(selectedBranchIds);
    (map.getSource('cov-properties') as mapboxgl.GeoJSONSource | undefined)?.setData(
      propertiesGeoJSON(properties, matchedIds)
    );
    (map.getSource('cov-branches') as mapboxgl.GeoJSONSource | undefined)?.setData(
      branchesGeoJSON(branches, selected)
    );
    (map.getSource('cov-circles') as mapboxgl.GeoJSONSource | undefined)?.setData(
      circlesGeoJSON(branches, selected, radiusMiles)
    );
  }, [styleReady, properties, branches, selectedBranchIds, radiusMiles, matchedIds]);

  // Fit when the selected branch set changes, but not for radius-only edits.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const selected = branches.filter((b) => selectedBranchIds.includes(b.id));
    if (selected.length === 0) return;
    const fitKey = selected.map((b) => `${b.id}:${b.lat}:${b.lng}`).join('|');
    if (fitKey === fittedKeyRef.current) return;
    fittedKeyRef.current = fitKey;
    const bounds = new mapboxgl.LngLatBounds();
    const padDeg = radiusMiles > 0 ? radiusMiles / 60 : 0.2;
    for (const b of selected) {
      bounds.extend([b.lng - padDeg, b.lat - padDeg]);
      bounds.extend([b.lng + padDeg, b.lat + padDeg]);
    }
    map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 400 });
  }, [styleReady, branches, selectedBranchIds, radiusMiles]);

  if (!token) {
    return (
      <div className={`flex ${heightClass} w-full items-center justify-center rounded-md border bg-muted/30 p-6 text-center text-sm text-muted-foreground`}>
        Map unavailable — <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> is not set in this environment.
      </div>
    );
  }

  return <div ref={containerRef} className={`${heightClass} w-full overflow-hidden rounded-md border`} />;
}
