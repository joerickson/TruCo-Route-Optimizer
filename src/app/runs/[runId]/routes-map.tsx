'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CrewDayRoute } from '@/lib/types';
import { dayName } from '@/lib/utils';
import {
  buildCrewTimeline,
  dayClockRange,
  formatClock,
  positionAt,
  type CrewTimeline,
} from '@/lib/route-playback';

export interface RoutesMapDepot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface RoutesMapUnassigned {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface RoutesMapCrew {
  crewId: string;
  name: string;
  color: string;
}

export interface RoutesMapProps {
  routes: CrewDayRoute[];
  depotsById: Record<string, RoutesMapDepot>;
  crewColors: Record<string, string>;
  crewOrder: RoutesMapCrew[];
  unassigned: RoutesMapUnassigned[];
  days: number[];
}

const UNASSIGNED_COLOR = '#dc2626'; // red-600
const DEPOT_COLOR = '#111827'; // gray-900
const SPEED = 1800; // sim-seconds advanced per real-second when playing (~1 work-hr ≈ 2s)
const DAY_PLAY_MS = 1500; // dwell per day when playing through the week

export default function RoutesMap(props: RoutesMapProps) {
  const { routes, depotsById, crewColors, crewOrder, unassigned, days } = props;
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [styleReady, setStyleReady] = useState(false);

  const [selectedDay, setSelectedDay] = useState<number>(days[0] ?? 1);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [solo, setSolo] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [playingDays, setPlayingDays] = useState(false);

  // Timelines for the selected day.
  const timelines = useMemo<CrewTimeline[]>(() => {
    const out: CrewTimeline[] = [];
    for (const r of routes) {
      if (r.day_of_week !== selectedDay) continue;
      const depot = depotsById[r.branch_id];
      if (!depot) continue;
      out.push(buildCrewTimeline(r, depot));
    }
    return out;
  }, [routes, selectedDay, depotsById]);

  const range = useMemo(() => dayClockRange(timelines), [timelines]);

  const clockRef = useRef(range.start);
  const [clock, setClock] = useState(range.start);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // Visibility / opacity for a crew given current hidden/solo/hover state.
  const opacityFor = useCallback(
    (crewId: string): number => {
      const visible = solo ? crewId === solo : !hidden.has(crewId);
      if (!visible) return 0;
      if (hover && hover !== crewId) return 0.15;
      return 1;
    },
    [hidden, solo, hover]
  );

  // Reset the clock whenever the day (and thus range) changes.
  useEffect(() => {
    clockRef.current = range.start;
    setClock(range.start);
    setPlaying(false);
    lastTsRef.current = null;
  }, [range.start, range.end]);

  // ---- GeoJSON builders ----
  const routesGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    return {
      type: 'FeatureCollection',
      features: timelines.map((tl) => ({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [tl.depot.lng, tl.depot.lat],
            ...tl.stops.map((s) => [s.lng, s.lat] as [number, number]),
            [tl.depot.lng, tl.depot.lat],
          ],
        },
        properties: {
          crewId: tl.crewId,
          color: crewColors[tl.crewId] ?? '#64748b',
          opacity: opacityFor(tl.crewId),
        },
      })),
    };
  }, [timelines, crewColors, opacityFor]);

  const stopsGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    const features: GeoJSON.Feature[] = [];
    for (const tl of timelines) {
      tl.stops.forEach((s, i) => {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
          properties: {
            crewId: tl.crewId,
            color: crewColors[tl.crewId] ?? '#64748b',
            opacity: opacityFor(tl.crewId),
            seq: String(i + 1),
          },
        });
      });
    }
    return { type: 'FeatureCollection', features };
  }, [timelines, crewColors, opacityFor]);

  const depotsGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    const seen = new Set<string>();
    const features: GeoJSON.Feature[] = [];
    for (const tl of timelines) {
      const depotId = `${tl.depot.lat},${tl.depot.lng}`;
      if (seen.has(depotId)) continue;
      seen.add(depotId);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [tl.depot.lng, tl.depot.lat] },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features };
  }, [timelines]);

  const unassignedGeoJSON = useCallback((): GeoJSON.FeatureCollection => {
    return {
      type: 'FeatureCollection',
      features: unassigned.map((u) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [u.lng, u.lat] },
        properties: { name: u.name, address: u.address },
      })),
    };
  }, [unassigned]);

  const crewPosGeoJSON = useCallback(
    (t: number): GeoJSON.FeatureCollection => {
      const features: GeoJSON.Feature[] = [];
      for (const tl of timelines) {
        const op = opacityFor(tl.crewId);
        if (op === 0) continue;
        const pos = positionAt(tl, t);
        if (!pos) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: pos },
          properties: { crewId: tl.crewId, color: crewColors[tl.crewId] ?? '#64748b', opacity: op },
        });
      }
      return { type: 'FeatureCollection', features };
    },
    [timelines, crewColors, opacityFor]
  );

  // ---- Map init (once) ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;
    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-111.89, 40.76],
      zoom: 9,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

    map.on('load', () => {
      map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('route-stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('depots', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('unassigned', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('crew-pos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'routes',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': ['get', 'opacity'],
        },
      });

      map.addLayer({
        id: 'stop-points',
        type: 'circle',
        source: 'route-stops',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 9,
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': ['get', 'opacity'],
        },
      });

      map.addLayer({
        id: 'stop-labels',
        type: 'symbol',
        source: 'route-stops',
        layout: {
          'text-field': ['get', 'seq'],
          'text-size': 11,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#fff', 'text-opacity': ['get', 'opacity'] },
      });

      map.addLayer({
        id: 'depot-points',
        type: 'circle',
        source: 'depots',
        paint: {
          'circle-color': DEPOT_COLOR,
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      });

      map.addLayer({
        id: 'unassigned-points',
        type: 'circle',
        source: 'unassigned',
        paint: {
          'circle-color': UNASSIGNED_COLOR,
          'circle-radius': 6,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff',
        },
      });

      map.addLayer({
        id: 'crew-pos-points',
        type: 'circle',
        source: 'crew-pos',
        paint: {
          'circle-color': ['get', 'color'],
          'circle-radius': 7,
          'circle-opacity': ['get', 'opacity'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#fff',
          'circle-stroke-opacity': ['get', 'opacity'],
        },
      });

      const popup = new mapboxgl.Popup({ offset: 12 });

      // Stop popup.
      map.on('click', 'stop-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const p = f.properties as Record<string, string>;
        popup
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(`<div style="font-family:inherit;font-size:12px">Stop #${escapeHtml(p.seq ?? '')}</div>`)
          .addTo(map);
      });

      // Unassigned popup.
      map.on('click', 'unassigned-points', (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== 'Point') return;
        const p = f.properties as Record<string, string>;
        popup
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(
            `<div style="font-family:inherit;min-width:200px;line-height:1.45">
               <div style="font-weight:600">${escapeHtml(p.name ?? '')}</div>
               <div style="font-size:12px;color:#64748b">${escapeHtml(p.address ?? '')}</div>
               <div style="font-size:11px;color:${UNASSIGNED_COLOR};margin-top:4px">Unassigned — could not be scheduled</div>
             </div>`
          )
          .addTo(map);
      });

      const cursorOn = () => (map.getCanvas().style.cursor = 'pointer');
      const cursorOff = () => (map.getCanvas().style.cursor = '');
      for (const layer of ['stop-points', 'unassigned-points']) {
        map.on('mouseenter', layer, cursorOn);
        map.on('mouseleave', layer, cursorOff);
      }

      setStyleReady(true);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Init exactly once; data flows through setData effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Push route/stop/depot/unassigned data when the day or visibility changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource('routes') as mapboxgl.GeoJSONSource | undefined)?.setData(routesGeoJSON());
    (map.getSource('route-stops') as mapboxgl.GeoJSONSource | undefined)?.setData(stopsGeoJSON());
    (map.getSource('depots') as mapboxgl.GeoJSONSource | undefined)?.setData(depotsGeoJSON());
    (map.getSource('unassigned') as mapboxgl.GeoJSONSource | undefined)?.setData(unassignedGeoJSON());
  }, [styleReady, routesGeoJSON, stopsGeoJSON, depotsGeoJSON, unassignedGeoJSON]);

  // Fit bounds to the selected day's geometry (once per day change).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const bounds = new mapboxgl.LngLatBounds();
    let any = false;
    for (const tl of timelines) {
      bounds.extend([tl.depot.lng, tl.depot.lat]);
      for (const s of tl.stops) {
        bounds.extend([s.lng, s.lat]);
        any = true;
      }
    }
    for (const u of unassigned) {
      bounds.extend([u.lng, u.lat]);
      any = true;
    }
    if (any) map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 300 });
  }, [styleReady, selectedDay, timelines, unassigned]);

  // Update animated crew positions whenever clock / visibility / day changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    (map.getSource('crew-pos') as mapboxgl.GeoJSONSource | undefined)?.setData(crewPosGeoJSON(clock));
  }, [styleReady, clock, crewPosGeoJSON]);

  // Within-day playback loop.
  useEffect(() => {
    if (!playing) return;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      let next = clockRef.current + dt * SPEED;
      if (next >= range.end) {
        next = range.end;
        setPlaying(false);
      }
      clockRef.current = next;
      setClock(next);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [playing, range.end]);

  // Play-through-the-week loop.
  useEffect(() => {
    if (!playingDays || days.length <= 1) return;
    const t = setInterval(() => {
      setSelectedDay((d) => {
        const idx = days.indexOf(d);
        const nextIdx = (idx + 1) % days.length;
        if (nextIdx === 0) setPlayingDays(false);
        return days[nextIdx];
      });
    }, DAY_PLAY_MS);
    return () => clearInterval(t);
  }, [playingDays, days]);

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

  const scrub = (v: number) => {
    setPlaying(false);
    clockRef.current = v;
    setClock(v);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Routes map</CardTitle>
            <CardDescription>
              {timelines.length} crews on {dayName(selectedDay)} · straight-line approximation (Haversine ×1.3),
              not turn-by-turn
              {unassigned.length > 0 && (
                <span className="ml-2 font-medium" style={{ color: UNASSIGNED_COLOR }}>
                  · {unassigned.length} unassigned
                </span>
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {days.map((d) => (
              <button
                key={d}
                onClick={() => setSelectedDay(d)}
                className={
                  'rounded-md border px-2.5 py-1 text-sm transition-colors ' +
                  (d === selectedDay
                    ? 'bg-secondary font-medium text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {dayName(d)}
              </button>
            ))}
            {days.length > 1 && (
              <Button variant="outline" size="sm" onClick={() => setPlayingDays((p) => !p)}>
                {playingDays ? 'Stop days' : 'Play days'}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div ref={containerRef} className="h-[640px] w-full overflow-hidden rounded-md border" />

        {/* Time scrubber */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (clockRef.current >= range.end) scrub(range.start);
              lastTsRef.current = null;
              setPlaying((p) => !p);
            }}
          >
            {playing ? 'Pause' : 'Play day'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => scrub(range.start)}>
            Reset
          </Button>
          <input
            type="range"
            min={range.start}
            max={range.end}
            step={60}
            value={clock}
            onChange={(e) => scrub(Number(e.target.value))}
            className="flex-1"
          />
          <span className="w-16 text-right font-mono text-sm">{formatClock(clock)}</span>
        </div>

        {/* Crew legend / filter */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setHidden(new Set());
              setSolo(null);
            }}
            className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            All
          </button>
          <button
            onClick={() => {
              setHidden(new Set(crewOrder.map((c) => c.crewId)));
              setSolo(null);
            }}
            className="rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            None
          </button>
          {crewOrder.map((c) => {
            const isHidden = solo ? c.crewId !== solo : hidden.has(c.crewId);
            return (
              <button
                key={c.crewId}
                onMouseEnter={() => setHover(c.crewId)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setSolo((cur) => (cur === c.crewId ? null : c.crewId))}
                className={
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-opacity ' +
                  (isHidden ? 'opacity-40' : 'opacity-100')
                }
                title="Click to solo this crew"
              >
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
