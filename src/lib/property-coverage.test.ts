import { describe, it, expect } from 'vitest';
import { computePropertyCoverage, summarizeUnassigned } from './property-coverage';
import type { CrewDayRoute } from './types';

function stop(property_id: string, service_minutes: number) {
  return {
    property_id, property_name: property_id, address: 'x', lat: 0, lng: 0,
    arrival_time: '08:00', service_minutes, drive_minutes_to: 5,
  };
}
function route(crew_id: string, props: Array<[string, number]>): CrewDayRoute {
  return {
    crew_id, crew_name: crew_id, day_of_week: 1, branch_id: 'b1',
    start_time: '07:00', end_time: '15:00', clock_hours: 8, drive_hours: 1, drive_miles: 10,
    stops: props.map(([id, mins]) => stop(id, mins)),
  };
}

describe('computePropertyCoverage', () => {
  it('recovers placed labor-hours = service_minutes/60 * crew_size', () => {
    // 200 min on a 3-person crew = 200/60*3 = 10 labor-hours
    const cov = computePropertyCoverage([route('c1', [['p1', 200]])], { c1: 3 });
    expect(cov['p1']).toBeCloseTo(10, 6);
  });
  it('sums chunks of one property across routes/crews/days', () => {
    // p1: 200min@3 (=10h) on c1 + 300min@2 (=10h) on c2 = 20h
    const cov = computePropertyCoverage(
      [route('c1', [['p1', 200]]), route('c2', [['p1', 300]])],
      { c1: 3, c2: 2 }
    );
    expect(cov['p1']).toBeCloseTo(20, 6);
  });
  it('defaults to crew size 2 when crew not in the map', () => {
    const cov = computePropertyCoverage([route('cX', [['p1', 120]])], {});
    expect(cov['p1']).toBeCloseTo(4, 6); // 120/60*2
  });
  it('returns {} for no routes', () => {
    expect(computePropertyCoverage([], { c1: 2 })).toEqual({});
  });
});

describe('summarizeUnassigned', () => {
  const props = [
    { id: 'big', name: 'Canyon Park', city: 'Provo', service_type: 'weekly', est_labor_hours: 132.6 },
    { id: 'mid', name: 'Mid Lot', city: 'SLC', service_type: 'weekly', est_labor_hours: 20 },
    { id: 'none', name: 'No Cover', city: null, service_type: 'biweekly', est_labor_hours: 12 },
  ];
  const coverage = { big: 90, mid: 18 }; // 'none' absent => 0 covered

  it('computes covered/unplaced/pct per property and sorts by unplaced desc', () => {
    const s = summarizeUnassigned(props, coverage);
    expect(s.count).toBe(3);
    expect(s.rows[0].id).toBe('big'); // 42.6 unplaced, largest
    const big = s.rows.find((r) => r.id === 'big')!;
    expect(big.coveredHours).toBeCloseTo(90, 6);
    expect(big.unplacedHours).toBeCloseTo(42.6, 6);
    expect(big.pct).toBeCloseTo(90 / 132.6, 6);
    const none = s.rows.find((r) => r.id === 'none')!;
    expect(none.coveredHours).toBe(0);
    expect(none.unplacedHours).toBeCloseTo(12, 6);
  });
  it('clamps covered to total (rounding can overshoot) and never negative unplaced', () => {
    const s = summarizeUnassigned([{ id: 'p', name: 'P', city: null, service_type: 'weekly', est_labor_hours: 10 }], { p: 10.4 });
    const r = s.rows[0];
    expect(r.coveredHours).toBe(10);
    expect(r.unplacedHours).toBe(0);
    expect(r.pct).toBe(1);
  });
  it('totals unplaced and labor across rows', () => {
    const s = summarizeUnassigned(props, coverage);
    expect(s.totalLaborHours).toBeCloseTo(132.6 + 20 + 12, 6);
    expect(s.totalUnplacedHours).toBeCloseTo(42.6 + 2 + 12, 6);
  });
});
