import { describe, it, expect } from 'vitest';
import {
  crewsForFleet,
  assignToNearestBranch,
  snowCapacity,
  type SnowProperty,
  type SnowBranch,
} from './snow-capacity';

// Two points ~0.7 mi apart (small in-neighborhood hop) and one far point ~20 mi away.
const A = { lat: 40.76, lng: -111.89 };
const B = { lat: 40.77, lng: -111.89 }; // ~0.7 mi N of A
const FAR = { lat: 41.05, lng: -111.89 }; // ~20 mi N of A

describe('crewsForFleet', () => {
  it('returns zeros for no stops', () => {
    const r = crewsForFleet([], () => 1, 4);
    expect(r).toEqual({ crews: 0, laborHours: 0, travelHours: 0, stops: 0, overWindow: false });
  });

  it('one stop = one crew, its labor, no travel', () => {
    const r = crewsForFleet([A], () => 1.5, 4);
    expect(r.crews).toBe(1);
    expect(r.laborHours).toBeCloseTo(1.5);
    expect(r.travelHours).toBe(0);
    expect(r.stops).toBe(1);
  });

  it('two nearby stops that fit the window = one crew, travel counted', () => {
    const r = crewsForFleet([A, B], () => 1, 4); // 2h labor + tiny hop < 4h
    expect(r.crews).toBe(1);
    expect(r.laborHours).toBeCloseTo(2);
    expect(r.travelHours).toBeGreaterThan(0);
  });

  it('splits into a new crew when the next stop would exceed the window', () => {
    // window 1.5h, two 1h stops: 1 + hop + 1 > 1.5 -> second stop starts a new crew.
    const r = crewsForFleet([A, B], () => 1, 1.5);
    expect(r.crews).toBe(2);
    expect(r.travelHours).toBe(0); // the only hop was at a crew boundary, not counted
  });

  it('a lone stop larger than the window still gets one crew and is flagged', () => {
    const r = crewsForFleet([A], () => 6, 4);
    expect(r.crews).toBe(1);
    expect(r.overWindow).toBe(true);
  });

  it('far-apart stops each need their own crew under a tight window', () => {
    // ~20 mi hop is ~20+ min drive; with a 1h window and 0.9h labor each, they cannot share.
    const r = crewsForFleet([A, FAR], () => 0.9, 1);
    expect(r.crews).toBe(2);
  });

  it('caps a crew at maxStops even when the window has room', () => {
    // 6 nearby stops, tiny labor, huge window — window never binds, so the cap of 4 does.
    const stops = [A, B, A, B, A, B];
    const r = crewsForFleet(stops, () => 0.1, 100, 4);
    expect(r.crews).toBe(2); // ceil(6 / 4)
  });

  it('with maxStops the count is ceil(stops / cap) when the window is slack', () => {
    const stops = Array.from({ length: 10 }, () => A);
    expect(crewsForFleet(stops, () => 0.01, 1000, 4).crews).toBe(3); // ceil(10/4)
  });

  it('maxStops <= 0 or omitted means no cap (window-only)', () => {
    const stops = Array.from({ length: 6 }, () => A);
    expect(crewsForFleet(stops, () => 0.1, 100).crews).toBe(1); // all fit the window
    expect(crewsForFleet(stops, () => 0.1, 100, 0).crews).toBe(1);
  });

  it('the cap is authoritative — it wins even when the window is tighter', () => {
    // 8 stops, each 1h labor, 1h window. Window-only would give 8 crews; a cap of 4 gives 2.
    const stops = Array.from({ length: 8 }, () => A);
    expect(crewsForFleet(stops, () => 1, 1).crews).toBe(8); // window-only
    expect(crewsForFleet(stops, () => 1, 1, 4).crews).toBe(2); // cap wins: ceil(8/4)
  });
});

describe('assignToNearestBranch', () => {
  const branches: SnowBranch[] = [
    { id: 'north', name: 'North', lat: 41.05, lng: -111.89 },
    { id: 'south', name: 'South', lat: 40.5, lng: -111.89 },
  ];

  it('assigns each property to the closest branch', () => {
    const near = mkProp('p1', A); // near south
    const north = mkProp('p2', { lat: 41.04, lng: -111.89 }); // near north
    const assigned = assignToNearestBranch([near, north], branches);
    expect(assigned.get('p1')).toBe('south');
    expect(assigned.get('p2')).toBe('north');
  });

  it('assigns all to a single empty-string group when there are no branches', () => {
    const assigned = assignToNearestBranch([mkProp('p1', A)], []);
    expect(assigned.get('p1')).toBe('');
  });
});

describe('snowCapacity', () => {
  const branches: SnowBranch[] = [{ id: 'b1', name: 'SLC', lat: 40.76, lng: -111.89 }];
  const tierPlowHours = { '1': 1.5, '2': 1.0, '3': 1.0 };

  it('sizes plow and sidewalk fleets independently and excludes non-sidewalk from sidewalk fleet', () => {
    const props: SnowProperty[] = [
      { id: 'p1', name: 'P1', lat: A.lat, lng: A.lng, tier: '1', has_sidewalk: true },
      { id: 'p2', name: 'P2', lat: B.lat, lng: B.lng, tier: '2', has_sidewalk: false },
    ];
    const r = snowCapacity({ properties: props, branches, tierPlowHours, sidewalkHours: 0.5, windowHours: 4 });
    const b = r.branches[0];
    expect(b.plow.stops).toBe(2); // both plowed
    expect(b.plow.laborHours).toBeCloseTo(2.5); // 1.5 + 1.0
    expect(b.sidewalk.stops).toBe(1); // only p1 has sidewalks
    expect(b.sidewalk.laborHours).toBeCloseTo(0.5);
  });

  it('excludes unrated properties from plow but still counts their sidewalks, and reports them', () => {
    const props: SnowProperty[] = [
      { id: 'p1', name: 'P1', lat: A.lat, lng: A.lng, tier: null, has_sidewalk: true },
      { id: 'p2', name: 'P2', lat: B.lat, lng: B.lng, tier: '9', has_sidewalk: false }, // tier not in rates
    ];
    const r = snowCapacity({ properties: props, branches, tierPlowHours, sidewalkHours: 0.5, windowHours: 4 });
    expect(r.unrated.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(r.branches[0].plow.stops).toBe(0); // neither is a valid plow stop
    expect(r.branches[0].sidewalk.stops).toBe(1); // p1 still needs sidewalk clearing
  });

  it('portfolio totals equal the sum across branches', () => {
    const twoBranches: SnowBranch[] = [
      { id: 'b1', name: 'SLC', lat: 40.76, lng: -111.89 },
      { id: 'b2', name: 'North', lat: 41.05, lng: -111.89 },
    ];
    const props: SnowProperty[] = [
      { id: 'p1', name: 'P1', lat: A.lat, lng: A.lng, tier: '1', has_sidewalk: true },
      { id: 'p2', name: 'P2', lat: FAR.lat, lng: FAR.lng, tier: '1', has_sidewalk: true },
    ];
    const r = snowCapacity({ properties: props, branches: twoBranches, tierPlowHours, sidewalkHours: 0.5, windowHours: 4 });
    const sumPlow = r.branches.reduce((n, b) => n + b.plow.crews, 0);
    const sumSidewalk = r.branches.reduce((n, b) => n + b.sidewalk.crews, 0);
    expect(r.totals.plowCrews).toBe(sumPlow);
    expect(r.totals.sidewalkCrews).toBe(sumSidewalk);
  });
});

function mkProp(id: string, at: { lat: number; lng: number }): SnowProperty {
  return { id, name: id, lat: at.lat, lng: at.lng, tier: '1', has_sidewalk: false };
}
