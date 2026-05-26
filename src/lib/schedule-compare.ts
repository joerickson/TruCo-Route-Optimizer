// Pure comparison of two optimization_runs rows (a baseline 'current' schedule
// vs an optimized run). No IO — reads persisted run fields only.
import type { OptimizationRun, CrewUtilization, CapacityRecommendation } from './types';

const OVERLOADED_HRS = 55; // current-side clock-hrs/wk above this = overloaded
const UNDERUSED_HRS = 40;  // active crew below this = underused
const DRIVE_SAVED_NOISE_FLOOR_HRS = 0.5; // suppress sub-30-min drive deltas in the verdict

const BAND_LABELS: Record<CapacityRecommendation, string> = {
  over_provisioned: 'over-provisioned',
  sufficient: 'sufficient',
  tight_but_feasible: 'tight but feasible',
  add_crew_recommended: 'add 1-2 crews',
  add_crew_required: 'add crews (unsustainable)',
};

export interface FleetMetric {
  current: number;
  optimized: number;
  delta: number;
  pct: number; // delta / current (0 when current is 0)
}
export interface FleetDelta {
  clockHours: FleetMetric;
  driveHours: FleetMetric;
  driveMiles: FleetMetric;
  activeCrews: { current: number; optimized: number; delta: number };
  avgUtil: { current: number; optimized: number; delta: number };
}
export interface CrewDelta {
  crewId: string;
  crewName: string;
  currentClock: number;
  optimizedClock: number;
  deltaClock: number;
  currentUtil: number;
  optimizedUtil: number;
  flag: 'overloaded' | 'underused' | 'ok';
}
export interface PropertyChange {
  propertyId: string;
  propertyName: string;
  from: { crewName: string | null; day: number | null };
  to: { crewName: string | null; day: number | null };
  changedCrew: boolean;
  changedDay: boolean;
}
export interface CoverageNote {
  onlyInCurrent: string[];
  onlyInOptimized: string[];
}
export interface ScheduleComparison {
  fleet: FleetDelta;
  capacity: {
    currentBand: CapacityRecommendation | null;
    optimizedBand: CapacityRecommendation | null;
    verdict: string;
  };
  crews: CrewDelta[];
  changes: PropertyChange[];
  coverage: CoverageNote;
}

interface PlacedProp {
  propertyName: string;
  crewName: string;
  day: number;
}

function placement(run: OptimizationRun): Map<string, PlacedProp> {
  const map = new Map<string, PlacedProp>();
  for (const r of run.routes_jsonb?.per_day ?? []) {
    for (const s of r.stops) {
      if (!map.has(s.property_id)) {
        map.set(s.property_id, { propertyName: s.property_name, crewName: r.crew_name, day: r.day_of_week });
      }
    }
  }
  return map;
}

function metric(current: number, optimized: number): FleetMetric {
  const delta = optimized - current;
  return { current, optimized, delta, pct: current === 0 ? 0 : delta / current };
}

function activeCount(util: CrewUtilization[]): number {
  return util.filter((u) => u.clock_hours > 0).length;
}
function avgUtil(util: CrewUtilization[]): number {
  const active = util.filter((u) => u.clock_hours > 0);
  if (active.length === 0) return 0;
  return active.reduce((s, u) => s + u.util_pct, 0) / active.length;
}

export function compareSchedules(baseline: OptimizationRun, optimized: OptimizationRun): ScheduleComparison {
  const curUtil = baseline.crew_utilization ?? [];
  const optUtil = optimized.crew_utilization ?? [];

  const fleet: FleetDelta = {
    clockHours: metric(baseline.total_clock_hours_per_week ?? 0, optimized.total_clock_hours_per_week ?? 0),
    driveHours: metric(baseline.total_drive_hours_per_week ?? 0, optimized.total_drive_hours_per_week ?? 0),
    driveMiles: metric(baseline.total_drive_miles_per_week ?? 0, optimized.total_drive_miles_per_week ?? 0),
    activeCrews: {
      current: activeCount(curUtil),
      optimized: activeCount(optUtil),
      delta: activeCount(optUtil) - activeCount(curUtil),
    },
    avgUtil: {
      current: avgUtil(curUtil),
      optimized: avgUtil(optUtil),
      delta: avgUtil(optUtil) - avgUtil(curUtil),
    },
  };

  const optByCrew = new Map(optUtil.map((u) => [u.crew_id, u]));
  const curByCrew = new Map(curUtil.map((u) => [u.crew_id, u]));
  const crewIds = Array.from(new Set([...curByCrew.keys(), ...optByCrew.keys()]));
  const crews: CrewDelta[] = crewIds.map((id) => {
    const cur = curByCrew.get(id);
    const opt = optByCrew.get(id);
    const currentClock = cur?.clock_hours ?? 0;
    const optimizedClock = opt?.clock_hours ?? 0;
    let flag: CrewDelta['flag'] = 'ok';
    if (currentClock > OVERLOADED_HRS) flag = 'overloaded';
    else if (currentClock > 0 && currentClock < UNDERUSED_HRS) flag = 'underused';
    return {
      crewId: id,
      crewName: cur?.crew_name ?? opt?.crew_name ?? id,
      currentClock,
      optimizedClock,
      deltaClock: optimizedClock - currentClock,
      currentUtil: cur?.util_pct ?? 0,
      optimizedUtil: opt?.util_pct ?? 0,
      flag,
    };
  });

  const curPlace = placement(baseline);
  const optPlace = placement(optimized);
  const changes: PropertyChange[] = [];
  for (const [propertyId, cur] of curPlace) {
    const opt = optPlace.get(propertyId);
    if (!opt) continue;
    const changedCrew = cur.crewName !== opt.crewName;
    const changedDay = cur.day !== opt.day;
    if (!changedCrew && !changedDay) continue;
    changes.push({
      propertyId,
      propertyName: opt.propertyName ?? cur.propertyName,
      from: { crewName: cur.crewName, day: cur.day },
      to: { crewName: opt.crewName, day: opt.day },
      changedCrew,
      changedDay,
    });
  }

  const coverage: CoverageNote = {
    onlyInCurrent: Array.from(curPlace.keys()).filter((id) => !optPlace.has(id)),
    onlyInOptimized: Array.from(optPlace.keys()).filter((id) => !curPlace.has(id)),
  };

  const verdict = buildVerdict(fleet, baseline.capacity_recommendation, optimized.capacity_recommendation);

  return {
    fleet,
    capacity: {
      currentBand: baseline.capacity_recommendation,
      optimizedBand: optimized.capacity_recommendation,
      verdict,
    },
    crews,
    changes,
    coverage,
  };
}

function buildVerdict(
  fleet: FleetDelta,
  currentBand: CapacityRecommendation | null,
  optimizedBand: CapacityRecommendation | null,
): string {
  const driveSaved = -fleet.driveHours.delta;
  const crewSlack = fleet.activeCrews.current - fleet.activeCrews.optimized;
  const parts: string[] = [];
  if (crewSlack > 0) {
    parts.push(`Optimizing covers the same work with ${crewSlack} fewer active crew${crewSlack === 1 ? '' : 's'}.`);
  } else if (crewSlack < 0) {
    parts.push(`The optimizer spreads work across ${-crewSlack} more crew${-crewSlack === 1 ? '' : 's'} to stay in band.`);
  } else {
    parts.push('Both plans use the same number of active crews.');
  }
  if (driveSaved > DRIVE_SAVED_NOISE_FLOOR_HRS) parts.push(`Drive time drops ${driveSaved.toFixed(1)} hr/week.`);
  if (currentBand && optimizedBand && currentBand !== optimizedBand) {
    parts.push(`Capacity outlook improves from "${BAND_LABELS[currentBand]}" to "${BAND_LABELS[optimizedBand]}".`);
  }
  return parts.join(' ');
}
