// Per-property work coverage for a completed run, derived from route stops.
// The solver splits big properties into work-chunks; a stop's service_minutes is
// labor_hours/crew_size*60, so placed labor = service_minutes/60 * crew_size.
// Pure — no IO.
import type { CrewDayRoute } from './types';

const DEFAULT_CREW_SIZE = 2; // matches the solver's fleet-average fallback

/** Placed person-hours per property_id, summed across all routes (chunks). */
export function computePropertyCoverage(
  routes: CrewDayRoute[],
  crewSizeById: Record<string, number>
): Record<string, number> {
  const covered: Record<string, number> = {};
  for (const r of routes) {
    const size = crewSizeById[r.crew_id] ?? DEFAULT_CREW_SIZE;
    for (const s of r.stops) {
      covered[s.property_id] = (covered[s.property_id] ?? 0) + (s.service_minutes / 60) * size;
    }
  }
  return covered;
}

export interface UnassignedProp {
  id: string;
  name: string;
  city: string | null;
  service_type: string;
  est_labor_hours: number;
}

export interface UnassignedRow {
  id: string;
  name: string;
  city: string | null;
  serviceType: string;
  totalHours: number;
  coveredHours: number;
  unplacedHours: number;
  pct: number; // coveredHours / totalHours, 0..1 (0 when total is 0)
}

export interface UnassignedSummary {
  rows: UnassignedRow[];
  count: number;
  totalLaborHours: number;
  totalUnplacedHours: number;
}

/** Build display rows for the run's unassigned properties, sorted by unplaced hours. */
export function summarizeUnassigned(
  props: UnassignedProp[],
  coverage: Record<string, number>
): UnassignedSummary {
  const rows: UnassignedRow[] = props.map((p) => {
    const total = p.est_labor_hours;
    const covered = Math.min(coverage[p.id] ?? 0, total); // clamp: rounding can overshoot
    const unplaced = Math.max(0, total - covered);
    return {
      id: p.id,
      name: p.name,
      city: p.city,
      serviceType: p.service_type,
      totalHours: total,
      coveredHours: covered,
      unplacedHours: unplaced,
      pct: total > 0 ? covered / total : 0,
    };
  });
  rows.sort((a, b) => b.unplacedHours - a.unplacedHours);
  return {
    rows,
    count: rows.length,
    totalLaborHours: rows.reduce((s, r) => s + r.totalHours, 0),
    totalUnplacedHours: rows.reduce((s, r) => s + r.unplacedHours, 0),
  };
}
