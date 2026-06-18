// Bid-area coverage: which sites fall within a straight-line radius of any of the
// selected branches. Straight-line (haversine) is used here — not the optimizer's
// road-distance — so the matched set exactly agrees with the radius circle drawn
// on the map.
import { haversineMiles } from './distance';

export interface CoverageBranch {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface CoverageMatch<P> {
  property: P;
  nearestBranchId: string;
  nearestBranchName: string;
  distanceMiles: number;
}

/** Sites within `radiusMiles` of any selected branch, annotated with the nearest
 *  selected branch and its distance, sorted nearest-first. Returns [] when no
 *  branch is selected or the radius is not a positive number. */
export function sitesWithinRadius<P extends { lat: number; lng: number }>(
  properties: P[],
  branches: CoverageBranch[],
  selectedBranchIds: string[],
  radiusMiles: number | null | undefined
): CoverageMatch<P>[] {
  if (radiusMiles == null || !(radiusMiles > 0)) return [];
  const selectedSet = new Set(selectedBranchIds);
  const selected = branches.filter((b) => selectedSet.has(b.id));
  if (selected.length === 0) return [];

  const matches: CoverageMatch<P>[] = [];
  for (const p of properties) {
    let best: { id: string; name: string; d: number } | null = null;
    for (const b of selected) {
      const d = haversineMiles({ lat: b.lat, lng: b.lng }, { lat: p.lat, lng: p.lng });
      if (best === null || d < best.d) best = { id: b.id, name: b.name, d };
    }
    if (best && best.d <= radiusMiles) {
      matches.push({
        property: p,
        nearestBranchId: best.id,
        nearestBranchName: best.name,
        distanceMiles: best.d,
      });
    }
  }
  return matches.sort((a, b) => a.distanceMiles - b.distanceMiles);
}
