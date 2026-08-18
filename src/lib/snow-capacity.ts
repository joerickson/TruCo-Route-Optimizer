// Snow-bid crews-needed model. Snow work is storm-triggered, not a recurring cadence:
// after an event, every property must be cleared within a design window (hours before
// business open). Crews dispatch from home, so routes are OPEN — no branch depot leg.
// Branches are an administrative grouping (nearest-branch assignment).
//
// Two independent fleets are sized per branch:
//   - plow trucks: every rated property, labor = its tier's plow hours
//   - sidewalk crews: only properties flagged has_sidewalk, labor = a flat sidewalk time
//
// This is the aggregate model: a nearest-neighbor tour is sliced at the window boundary
// to count crews, with real inter-stop travel from distance.ts. It is intentionally
// isolated so an OR-Tools VRP snow-mode can replace crewsForFleet/snowCapacity later.

import { driveMinutes } from './distance';

export interface SnowProperty {
  id: string;
  name: string;
  lat: number;
  lng: number;
  tier: string | null;
  has_sidewalk: boolean;
}

export interface SnowBranch {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface SnowInputs {
  properties: SnowProperty[];
  branches: SnowBranch[];
  tierPlowHours: Record<string, number>;
  sidewalkHours: number;
  windowHours: number;
  // Operational cap on how many properties one crew covers per storm ("4 properties
  // per truck"). A crew closes at whichever binds first — this cap or the window.
  // Omit / <= 0 for no cap (window-only sizing).
  maxStopsPerCrew?: number;
}

export interface FleetResult {
  crews: number;
  laborHours: number;
  travelHours: number;
  stops: number;
  // True when a single stop's labor alone exceeds the window (can't ever be met in one pass).
  overWindow: boolean;
}

export interface BranchResult {
  branchId: string;
  branchName: string;
  plow: FleetResult;
  sidewalk: FleetResult;
}

export interface SnowCapacityResult {
  branches: BranchResult[];
  totals: { plowCrews: number; sidewalkCrews: number };
  // Geocoded properties with no tier (or a tier absent from the rates) — excluded from
  // the plow fleet rather than silently defaulted. Surfaced as a warning in the UI.
  unrated: SnowProperty[];
}

type Coord = { lat: number; lng: number };

const driveHours = (a: Coord, b: Coord): number => driveMinutes(a, b) / 60;

// Greedy nearest-neighbor tour, starting from the first stop. Deterministic (no
// randomness) so results and tests are stable. Open route — no return to start.
function nearestNeighborOrder<T extends Coord>(stops: T[]): T[] {
  if (stops.length <= 2) return stops.slice();
  const remaining = stops.slice();
  const order: T[] = [remaining.shift() as T];
  while (remaining.length > 0) {
    const last = order[order.length - 1];
    let bestIdx = 0;
    let bestMin = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = driveMinutes(last, remaining[i]);
      if (d < bestMin) {
        bestMin = d;
        bestIdx = i;
      }
    }
    order.push(remaining.splice(bestIdx, 1)[0]);
  }
  return order;
}

// Slice a fleet's stops into crews. Two sizing bases:
//   - maxStops > 0 (operational "N properties per truck"): the cap is authoritative — a
//     crew closes at N stops regardless of the window. This is how snow crews are planned.
//   - maxStops <= 0 (window-only): a crew closes when its labor + intra-crew travel would
//     exceed the window.
// A crew's first stop has no incoming travel (home dispatch). Returns crew count, total
// labor, realized travel (boundary hops excluded), and whether a single stop's labor
// alone exceeds the window (informational).
export function crewsForFleet<T extends Coord>(
  stops: T[],
  laborOf: (s: T) => number,
  windowHours: number,
  maxStops = Infinity,
): FleetResult {
  const cap = maxStops > 0 ? maxStops : Infinity;
  const capMode = cap !== Infinity;
  const ordered = nearestNeighborOrder(stops);
  let crews = 0;
  let totalLabor = 0;
  let totalTravel = 0;
  let overWindow = false;
  let current: { load: number; last: T; count: number } | null = null;

  for (const stop of ordered) {
    const stopLabor = laborOf(stop);
    totalLabor += stopLabor;
    if (stopLabor > windowHours) overWindow = true;

    if (current === null) {
      current = { load: stopLabor, last: stop, count: 1 };
      crews += 1;
      continue;
    }
    const hop = driveHours(current.last, stop);
    const shouldClose = capMode
      ? current.count + 1 > cap
      : current.load + hop + stopLabor > windowHours;
    if (shouldClose) {
      // Close the current crew; the next stop begins a new crew (no incoming travel).
      current = { load: stopLabor, last: stop, count: 1 };
      crews += 1;
    } else {
      current.load += hop + stopLabor;
      current.last = stop;
      current.count += 1;
      totalTravel += hop;
    }
  }

  return { crews, laborHours: totalLabor, travelHours: totalTravel, stops: ordered.length, overWindow };
}

// Map each property id to its nearest branch id (by drive time). With no branches, every
// property lands in a single '' group so the model still produces a portfolio number.
export function assignToNearestBranch(
  properties: SnowProperty[],
  branches: SnowBranch[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of properties) {
    if (branches.length === 0) {
      out.set(p.id, '');
      continue;
    }
    let bestId = branches[0].id;
    let bestMin = Infinity;
    for (const b of branches) {
      const d = driveMinutes(p, b);
      if (d < bestMin) {
        bestMin = d;
        bestId = b.id;
      }
    }
    out.set(p.id, bestId);
  }
  return out;
}

function isGeocoded(p: SnowProperty): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

export function snowCapacity(inputs: SnowInputs): SnowCapacityResult {
  const { branches, tierPlowHours, sidewalkHours, windowHours } = inputs;
  const maxStops = inputs.maxStopsPerCrew ?? Infinity;
  const properties = inputs.properties.filter(isGeocoded);

  const ratedPlow = (p: SnowProperty): boolean => p.tier != null && p.tier in tierPlowHours;
  const unrated = properties.filter((p) => !ratedPlow(p));

  const assigned = assignToNearestBranch(properties, branches);
  // Preserve branch order; include a '' bucket only if it actually gets properties.
  const groups: { id: string; name: string }[] =
    branches.length > 0 ? branches.map((b) => ({ id: b.id, name: b.name })) : [{ id: '', name: 'All properties' }];

  const branchResults: BranchResult[] = groups.map((g) => {
    const mine = properties.filter((p) => assigned.get(p.id) === g.id);
    const plowStops = mine.filter(ratedPlow);
    const sidewalkStops = mine.filter((p) => p.has_sidewalk);
    return {
      branchId: g.id,
      branchName: g.name,
      plow: crewsForFleet(plowStops, (p) => tierPlowHours[p.tier as string], windowHours, maxStops),
      sidewalk: crewsForFleet(sidewalkStops, () => sidewalkHours, windowHours, maxStops),
    };
  });

  return {
    branches: branchResults,
    totals: {
      plowCrews: branchResults.reduce((n, b) => n + b.plow.crews, 0),
      sidewalkCrews: branchResults.reduce((n, b) => n + b.sidewalk.crews, 0),
    },
    unrated,
  };
}
