// Pure playback math for the routes map. No Mapbox, no React, no I/O.
// Converts a solver CrewDayRoute (+ its depot) into a clock-driven timeline so
// the map can show each crew's position at any time of day. Positions are
// linearly interpolated along straight segments, matching the solver's
// straight-line (Haversine x 1.3) cost model.
import type { CrewDayRoute } from './types';

export interface PlaybackStop {
  lat: number;
  lng: number;
  arrivalSeconds: number;
  serviceSeconds: number;
}

export interface CrewTimeline {
  crewId: string;
  depot: { lat: number; lng: number };
  startSeconds: number;
  endSeconds: number;
  stops: PlaybackStop[];
}

export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 3600 + m * 60;
}

export function formatClock(seconds: number): string {
  const h24 = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const ampm = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

export function buildCrewTimeline(
  route: CrewDayRoute,
  depot: { lat: number; lng: number }
): CrewTimeline {
  return {
    crewId: route.crew_id,
    depot,
    startSeconds: parseClock(route.start_time),
    endSeconds: parseClock(route.end_time),
    stops: route.stops.map((s) => ({
      lat: s.lat,
      lng: s.lng,
      arrivalSeconds: parseClock(s.arrival_time),
      serviceSeconds: s.service_minutes * 60,
    })),
  };
}

function frac(a: number, b: number, t: number): number {
  if (b <= a) return 1;
  return Math.min(1, Math.max(0, (t - a) / (b - a)));
}

function lerp(a: [number, number], b: [number, number], f: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

// Returns [lng, lat] of the crew at clock-time t (seconds from midnight),
// or null if the timeline has no stops.
export function positionAt(tl: CrewTimeline, t: number): [number, number] | null {
  if (tl.stops.length === 0) return null;
  const depot: [number, number] = [tl.depot.lng, tl.depot.lat];

  if (t <= tl.startSeconds) return depot;
  if (t >= tl.endSeconds) return depot;

  const first = tl.stops[0];
  if (t < first.arrivalSeconds) {
    return lerp(depot, [first.lng, first.lat], frac(tl.startSeconds, first.arrivalSeconds, t));
  }

  for (let i = 0; i < tl.stops.length; i++) {
    const s = tl.stops[i];
    const here: [number, number] = [s.lng, s.lat];
    const serviceEnd = s.arrivalSeconds + s.serviceSeconds;

    if (t >= s.arrivalSeconds && t <= serviceEnd) return here;

    const next = tl.stops[i + 1];
    if (next) {
      if (t > serviceEnd && t < next.arrivalSeconds) {
        return lerp(here, [next.lng, next.lat], frac(serviceEnd, next.arrivalSeconds, t));
      }
    } else if (t > serviceEnd) {
      return lerp(here, depot, frac(serviceEnd, tl.endSeconds, t));
    }
  }
  return depot;
}

export function dayClockRange(timelines: CrewTimeline[]): { start: number; end: number } {
  if (timelines.length === 0) return { start: 7 * 3600, end: 17 * 3600 };
  let start = Infinity;
  let end = -Infinity;
  for (const tl of timelines) {
    start = Math.min(start, tl.startSeconds);
    end = Math.max(end, tl.endSeconds);
  }
  return { start, end };
}
