import { describe, it, expect } from 'vitest';
import { capacityBand, buildCalendarGrid, type CrewAvailability } from './calendar-grid';
import type { CrewDayRoute, CrewUtilization } from './types';

function route(crew_id: string, day: number, clock_hours: number, nStops: number): CrewDayRoute {
  return {
    crew_id,
    crew_name: crew_id,
    day_of_week: day,
    branch_id: 'b1',
    start_time: '07:00',
    end_time: '15:00',
    clock_hours,
    drive_hours: 1,
    drive_miles: 10,
    stops: Array.from({ length: nStops }, (_, i) => ({
      property_id: `p${i}`,
      property_name: `P${i}`,
      address: 'x',
      lat: 0,
      lng: 0,
      arrival_time: '08:00',
      service_minutes: 30,
      drive_minutes_to: 10,
    })),
  };
}

function util(crew_id: string, clock_hours: number, util_pct: number): CrewUtilization {
  return {
    crew_id,
    crew_name: crew_id,
    clock_hours,
    drive_hours: 0,
    work_hours: clock_hours,
    util_pct,
    props_assigned: 0,
    drive_miles: 0,
  };
}

const worksAll: CrewAvailability = { works: { 1: true, 2: true, 3: true, 4: true, 5: true }, maxHoursPerDay: 8 };

describe('capacityBand', () => {
  it('classifies by weekly clock-hours at the band boundaries', () => {
    expect(capacityBand(39.9)).toBe('over_provisioned');
    expect(capacityBand(40)).toBe('sufficient');
    expect(capacityBand(50)).toBe('sufficient');
    expect(capacityBand(50.1)).toBe('tight');
    expect(capacityBand(55)).toBe('tight');
    expect(capacityBand(55.1)).toBe('add_crew');
    expect(capacityBand(60)).toBe('add_crew');
    expect(capacityBand(60.1)).toBe('unsustainable');
  });
});

describe('buildCalendarGrid', () => {
  it('classifies assigned / idle / off cells', () => {
    const routes = [route('c1', 1, 6, 3)];
    const crewUtil = [util('c1', 6, 30)];
    const crewsById: Record<string, CrewAvailability> = {
      c1: { works: { 1: true, 2: true, 3: false, 4: true, 5: true }, maxHoursPerDay: 8 },
    };
    const [row] = buildCalendarGrid(routes, crewUtil, crewsById);
    expect(row.days[1]).toEqual({ kind: 'assigned', clockHours: 6, stops: 3, fillPct: 0.75 });
    expect(row.days[2]).toEqual({ kind: 'idle' });
    expect(row.days[3]).toEqual({ kind: 'off' });
  });

  it('marks cells unknown when the crew is missing from crewsById', () => {
    const [row] = buildCalendarGrid([], [util('c9', 0, 0)], {});
    expect(row.days[1]).toEqual({ kind: 'unknown' });
    expect(row.fullyIdle).toBe(true);
  });

  it('clamps fillPct when hours exceed max/day', () => {
    const routes = [route('c1', 1, 10, 1)];
    const [row] = buildCalendarGrid(routes, [util('c1', 10, 50)], { c1: worksAll });
    expect(row.days[1].fillPct).toBe(1);
  });

  it('sorts active crews by weekly hours desc, fully-idle last', () => {
    const crewUtil = [util('idle', 0, 0), util('low', 20, 40), util('high', 45, 90)];
    const crewsById = { idle: worksAll, low: worksAll, high: worksAll };
    const rows = buildCalendarGrid([], crewUtil, crewsById);
    expect(rows.map((r) => r.crewId)).toEqual(['high', 'low', 'idle']);
    expect(rows[2].fullyIdle).toBe(true);
  });

  it('produces one row per crewUtil entry with days 1..5 keyed', () => {
    const rows = buildCalendarGrid([], [util('c1', 10, 20)], { c1: worksAll });
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0].days).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
