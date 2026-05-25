import { describe, it, expect } from 'vitest';
import {
  parseClock,
  formatClock,
  buildCrewTimeline,
  positionAt,
  dayClockRange,
} from './route-playback';
import type { CrewDayRoute } from './types';

const depot = { lat: 40.0, lng: -111.0 };

// One crew, leaves depot 07:00, arrives stop1 (40.1,-111.0) at 07:30,
// services 30 min (ends 08:00), returns to depot by end_time 08:30.
const route: CrewDayRoute = {
  crew_id: 'c1',
  crew_name: 'Crew 1',
  day_of_week: 1,
  branch_id: 'b1',
  start_time: '07:00',
  end_time: '08:30',
  clock_hours: 1.5,
  drive_hours: 1.0,
  drive_miles: 10,
  stops: [
    {
      property_id: 'p1',
      property_name: 'Prop 1',
      address: '123 St',
      lat: 40.1,
      lng: -111.0,
      arrival_time: '07:30',
      service_minutes: 30,
      drive_minutes_to: 30,
    },
  ],
};

describe('parseClock', () => {
  it('parses HH:MM to seconds from midnight', () => {
    expect(parseClock('07:00')).toBe(25200);
    expect(parseClock('08:30')).toBe(30600);
    expect(parseClock('00:00')).toBe(0);
  });
});

describe('formatClock', () => {
  it('formats seconds to 12-hour am/pm', () => {
    expect(formatClock(25200)).toBe('7:00am');
    expect(formatClock(43200)).toBe('12:00pm');
    expect(formatClock(48600)).toBe('1:30pm');
  });
});

describe('buildCrewTimeline', () => {
  it('derives start/end and stop schedule in seconds', () => {
    const tl = buildCrewTimeline(route, depot);
    expect(tl.crewId).toBe('c1');
    expect(tl.startSeconds).toBe(25200);
    expect(tl.endSeconds).toBe(30600);
    expect(tl.stops).toHaveLength(1);
    expect(tl.stops[0].arrivalSeconds).toBe(27000); // 07:30
    expect(tl.stops[0].serviceSeconds).toBe(1800); // 30 min
  });
});

describe('positionAt', () => {
  const tl = buildCrewTimeline(route, depot);

  it('sits at depot before departure', () => {
    expect(positionAt(tl, parseClock('06:59'))).toEqual([-111.0, 40.0]);
    expect(positionAt(tl, parseClock('07:00'))).toEqual([-111.0, 40.0]);
  });

  it('interpolates depot -> first stop mid-drive (halfway at 07:15)', () => {
    const pos = positionAt(tl, parseClock('07:15'))!;
    expect(pos[0]).toBeCloseTo(-111.0, 6); // lng unchanged
    expect(pos[1]).toBeCloseTo(40.05, 6); // halfway in lat
  });

  it('is parked at the stop during service window', () => {
    expect(positionAt(tl, parseClock('07:30'))).toEqual([-111.0, 40.1]);
    expect(positionAt(tl, parseClock('07:45'))).toEqual([-111.0, 40.1]);
    expect(positionAt(tl, parseClock('08:00'))).toEqual([-111.0, 40.1]);
  });

  it('interpolates last stop -> depot on the return leg (halfway at 08:15)', () => {
    const pos = positionAt(tl, parseClock('08:15'))!;
    expect(pos[1]).toBeCloseTo(40.05, 6);
  });

  it('returns to depot at/after end_time', () => {
    expect(positionAt(tl, parseClock('08:30'))).toEqual([-111.0, 40.0]);
    expect(positionAt(tl, parseClock('09:00'))).toEqual([-111.0, 40.0]);
  });

  it('returns null when there are no stops', () => {
    const empty = buildCrewTimeline({ ...route, stops: [] }, depot);
    expect(positionAt(empty, parseClock('07:30'))).toBeNull();
  });
});

describe('dayClockRange', () => {
  it('spans min start to max end across timelines', () => {
    const a = buildCrewTimeline(route, depot);
    const b = buildCrewTimeline({ ...route, start_time: '06:30', end_time: '09:15' }, depot);
    expect(dayClockRange([a, b])).toEqual({ start: 23400, end: 33300 });
  });

  it('falls back to 7am-5pm when empty', () => {
    expect(dayClockRange([])).toEqual({ start: 25200, end: 61200 });
  });
});
