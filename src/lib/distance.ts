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

// Assumed average suburban/urban speed for landscape crews.
const AVG_SPEED_MPH = 30;

export function driveMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return (roadMiles(a, b) / AVG_SPEED_MPH) * 60;
}
