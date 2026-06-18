import { roadMiles } from './distance';

type Coords = { lat: number | null; lng: number | null };

/** Filter properties to those within `radiusMiles` road-distance of `anchor`.
 *  - A null/undefined radius (or anchor without coords) passes everything
 *    through unchanged — this preserves the pre-scenario "all active" behavior.
 *  - When filtering, ungeocoded properties are excluded (they can't be placed). */
export function filterPropertiesWithinRadius<T extends Coords>(
  properties: T[],
  anchor: Coords,
  radiusMiles: number | null | undefined
): T[] {
  if (radiusMiles == null || anchor.lat == null || anchor.lng == null) return properties;
  const origin = { lat: anchor.lat, lng: anchor.lng };
  return properties.filter((p) => {
    if (p.lat == null || p.lng == null) return false;
    return roadMiles(origin, { lat: p.lat, lng: p.lng }) <= radiusMiles;
  });
}
