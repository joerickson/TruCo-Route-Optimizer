// Haversine + 1.3x road factor — used by the JS preview/export side.
// The Python solver computes the authoritative matrix.
const ROAD_FACTOR = 1.3;
const EARTH_RADIUS_MI = 3958.8;

export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_MI * 2 * Math.asin(Math.sqrt(h));
}

export function roadMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineMiles(a, b) * ROAD_FACTOR;
}

// Distance-tiered effective speed, mirrored from the Python solver's distance_matrix.py:
// short in-neighborhood hops crawl, longer trips reach arterial then freeway speed. Modeled as
// CUMULATIVE segments on road-distance so travel time is strictly increasing with distance.
// Each tuple is [segmentUpperBoundMiles, mph].
const SPEED_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3, 25], // first 3 road-mi: neighborhood streets
  [12, 40], // next 3-12 road-mi: arterials
  [Infinity, 65], // beyond 12 road-mi: freeway
];

export function roadMinutes(roadMi: number): number {
  let minutes = 0;
  let lower = 0;
  for (const [upper, mph] of SPEED_TIERS) {
    if (roadMi <= lower) break;
    const seg = Math.min(roadMi, upper) - lower;
    minutes += (seg / mph) * 60;
    lower = upper;
  }
  return minutes;
}

export function driveMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return roadMinutes(roadMiles(a, b));
}
