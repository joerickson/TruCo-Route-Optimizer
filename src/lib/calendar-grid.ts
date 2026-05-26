// Pure grid-builder for the run calendar/week view. No React, no Supabase, no IO.
import type { CrewDayRoute, CrewUtilization } from './types';

export type CapacityBand = 'over_provisioned' | 'sufficient' | 'tight' | 'add_crew' | 'unsustainable';
export type CellKind = 'assigned' | 'idle' | 'off' | 'unknown';

export interface CalendarCell {
  kind: CellKind;
  clockHours?: number; // assigned only
  stops?: number; // assigned only
  fillPct?: number; // assigned only: clockHours / maxHoursPerDay, clamped 0..1
}

export interface CalendarRow {
  crewId: string;
  crewName: string;
  weeklyClockHours: number;
  utilPct: number;
  band: CapacityBand;
  fullyIdle: boolean; // weeklyClockHours === 0
  days: Record<number, CalendarCell>; // keys 1..5
}

export interface CrewAvailability {
  works: Record<number, boolean>; // keys 1..5
  maxHoursPerDay: number;
}

const WEEKDAYS = [1, 2, 3, 4, 5];

// Bands keyed on weekly clock-hours per crew (matches solver _classify_capacity).
export function capacityBand(weeklyClockHours: number): CapacityBand {
  if (weeklyClockHours < 40) return 'over_provisioned';
  if (weeklyClockHours <= 50) return 'sufficient';
  if (weeklyClockHours <= 55) return 'tight';
  if (weeklyClockHours <= 60) return 'add_crew';
  return 'unsustainable';
}

export function buildCalendarGrid(
  routes: CrewDayRoute[],
  crewUtil: CrewUtilization[],
  crewsById: Record<string, CrewAvailability>
): CalendarRow[] {
  const routeByCrewDay = new Map<string, CrewDayRoute>();
  for (const r of routes) {
    routeByCrewDay.set(`${r.crew_id}:${r.day_of_week}`, r);
  }

  const rows: CalendarRow[] = crewUtil.map((cu) => {
    const avail = crewsById[cu.crew_id];
    const days: Record<number, CalendarCell> = {};
    for (const d of WEEKDAYS) {
      const route = routeByCrewDay.get(`${cu.crew_id}:${d}`);
      if (route) {
        const maxPerDay = avail?.maxHoursPerDay ?? 8;
        const fillPct = maxPerDay > 0 ? Math.min(1, route.clock_hours / maxPerDay) : 0;
        days[d] = { kind: 'assigned', clockHours: route.clock_hours, stops: route.stops.length, fillPct };
      } else if (!avail) {
        days[d] = { kind: 'unknown' };
      } else if (avail.works[d]) {
        days[d] = { kind: 'idle' };
      } else {
        days[d] = { kind: 'off' };
      }
    }
    return {
      crewId: cu.crew_id,
      crewName: cu.crew_name,
      weeklyClockHours: cu.clock_hours,
      utilPct: cu.util_pct,
      band: capacityBand(cu.clock_hours),
      fullyIdle: cu.clock_hours === 0,
      days,
    };
  });

  rows.sort((a, b) => {
    if (a.fullyIdle !== b.fullyIdle) return a.fullyIdle ? 1 : -1;
    if (b.weeklyClockHours !== a.weeklyClockHours) return b.weeklyClockHours - a.weeklyClockHours;
    return a.crewName.localeCompare(b.crewName);
  });

  return rows;
}
