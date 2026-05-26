import { describe, it, expect } from 'vitest';
import { compareSchedules } from './schedule-compare';
import type { OptimizationRun, CrewDayRoute, CrewUtilization } from './types';

function stop(property_id: string, property_name: string) {
  return { property_id, property_name, address: 'x', lat: 0, lng: 0, arrival_time: '08:00', service_minutes: 30, drive_minutes_to: 5 };
}
function route(crew_id: string, crew_name: string, day: number, props: Array<[string, string]>): CrewDayRoute {
  return {
    crew_id, crew_name, day_of_week: day, branch_id: 'b1',
    start_time: '07:00', end_time: '15:00', clock_hours: 8, drive_hours: 1, drive_miles: 10,
    stops: props.map(([id, name]) => stop(id, name)),
  };
}
function util(crew_id: string, clock: number, drive: number, util_pct: number): CrewUtilization {
  return { crew_id, crew_name: crew_id, clock_hours: clock, drive_hours: drive, work_hours: clock - drive, util_pct, props_assigned: 0, drive_miles: drive * 10 };
}
function run(over: Partial<OptimizationRun>): OptimizationRun {
  return {
    id: 'r', name: 'r', target_week_start_date: '2026-06-01', active_branch_ids: null,
    active_crew_ids: null, active_property_ids: null, config_snapshot: null, status: 'completed',
    solver_runtime_seconds: 1, total_clock_hours_per_week: 0, total_labor_hours_per_week: 0,
    total_drive_hours_per_week: 0, total_drive_miles_per_week: 0, crew_utilization: [],
    capacity_recommendation: null, recommendation_text: null, routes_jsonb: { per_day: [] },
    unassigned_property_ids: null, failure_reason: null, started_at: null, completed_at: null,
    created_by: null, created_at: '2026-05-26', ...over,
  } as OptimizationRun;
}

describe('compareSchedules', () => {
  const baseline = run({
    total_clock_hours_per_week: 120, total_drive_hours_per_week: 30, total_drive_miles_per_week: 900,
    crew_utilization: [util('c1', 64, 16, 80), util('c2', 36, 8, 45)],
    capacity_recommendation: 'add_crew_recommended',
    routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['p2', 'P2']]), route('c2', 'Crew 2', 2, [['p3', 'P3']])] },
  });
  const optimized = run({
    total_clock_hours_per_week: 100, total_drive_hours_per_week: 18, total_drive_miles_per_week: 600,
    crew_utilization: [util('c1', 50, 9, 62), util('c2', 50, 9, 62)],
    capacity_recommendation: 'sufficient',
    routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1']]), route('c2', 'Crew 2', 4, [['p2', 'P2'], ['p3', 'P3']])] },
  });

  it('computes fleet deltas and percentages', () => {
    const c = compareSchedules(baseline, optimized);
    expect(c.fleet.driveHours.current).toBe(30);
    expect(c.fleet.driveHours.optimized).toBe(18);
    expect(c.fleet.driveHours.delta).toBe(-12);
    expect(c.fleet.driveHours.pct).toBeCloseTo(-0.4, 5);
    expect(c.fleet.activeCrews.current).toBe(2);
  });

  it('flags overloaded and underused crews from the current side', () => {
    const c = compareSchedules(baseline, optimized);
    const c1 = c.crews.find((x) => x.crewId === 'c1')!;
    const c2 = c.crews.find((x) => x.crewId === 'c2')!;
    expect(c1.flag).toBe('overloaded'); // 64h current
    expect(c2.flag).toBe('underused');  // 36h current
    expect(c1.deltaClock).toBe(50 - 64);
  });

  it('lists only properties that moved crew or day', () => {
    const c = compareSchedules(baseline, optimized);
    const ids = c.changes.map((ch) => ch.propertyId).sort();
    expect(ids).toEqual(['p2', 'p3']);
    const p2 = c.changes.find((ch) => ch.propertyId === 'p2')!;
    expect(p2.from).toEqual({ crewName: 'Crew 1', day: 2 });
    expect(p2.to).toEqual({ crewName: 'Crew 2', day: 4 });
    expect(p2.changedCrew).toBe(true);
  });

  it('reports coverage differences', () => {
    const b = run({ routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['only-cur', 'X']])] } });
    const o = run({ routes_jsonb: { per_day: [route('c1', 'Crew 1', 2, [['p1', 'P1'], ['only-opt', 'Y']])] } });
    const c = compareSchedules(b, o);
    expect(c.coverage.onlyInCurrent).toEqual(['only-cur']);
    expect(c.coverage.onlyInOptimized).toEqual(['only-opt']);
  });

  it('returns no changes for identical runs', () => {
    const c = compareSchedules(optimized, optimized);
    expect(c.changes).toHaveLength(0);
    expect(c.fleet.driveHours.delta).toBe(0);
    expect(c.fleet.driveHours.pct).toBe(0);
  });
});
