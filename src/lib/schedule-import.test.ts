import { describe, it, expect } from 'vitest';
import { parseDayOfWeek, resolveCrewId } from './schedule-import';

describe('parseDayOfWeek', () => {
  it('parses full names case-insensitively', () => {
    expect(parseDayOfWeek('Monday')).toBe(1);
    expect(parseDayOfWeek('friday')).toBe(5);
    expect(parseDayOfWeek('SUNDAY')).toBe(7);
  });
  it('parses abbreviations', () => {
    expect(parseDayOfWeek('Mon')).toBe(1);
    expect(parseDayOfWeek('wed')).toBe(3);
  });
  it('parses numeric 1..7', () => {
    expect(parseDayOfWeek('1')).toBe(1);
    expect(parseDayOfWeek(4)).toBe(4);
    expect(parseDayOfWeek('7')).toBe(7);
  });
  it('returns null for garbage / out of range', () => {
    expect(parseDayOfWeek('someday')).toBeNull();
    expect(parseDayOfWeek('0')).toBeNull();
    expect(parseDayOfWeek('8')).toBeNull();
    expect(parseDayOfWeek('')).toBeNull();
    expect(parseDayOfWeek(null)).toBeNull();
  });
});

describe('resolveCrewId', () => {
  const map = new Map<string, string>([['crew a', 'id-a'], ['north crew', 'id-n']]);
  it('matches case- and space-insensitively', () => {
    expect(resolveCrewId('Crew A', map)).toBe('id-a');
    expect(resolveCrewId('  north crew ', map)).toBe('id-n');
  });
  it('returns null when unmatched', () => {
    expect(resolveCrewId('Crew Z', map)).toBeNull();
    expect(resolveCrewId('', map)).toBeNull();
  });
});

import { parseScheduleFile } from './schedule-import';

function csvBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('parseScheduleFile (CSV)', () => {
  it('parses external_id, crew, day rows', () => {
    const csv =
      'External ID,Crew,Day\n' +
      'P-1,Crew A,Monday\n' +
      'P-2,North Crew,3\n';
    const { rows, skipped } = parseScheduleFile('sched.csv', csvBuffer(csv));
    expect(skipped).toHaveLength(0);
    expect(rows).toEqual([
      { external_id: 'P-1', assigned_crew_name: 'Crew A', assigned_day_raw: 'Monday' },
      { external_id: 'P-2', assigned_crew_name: 'North Crew', assigned_day_raw: '3' },
    ]);
  });

  it('skips rows missing external_id, crew, or day', () => {
    const csv =
      'External ID,Crew,Day\n' +
      ',Crew A,Monday\n' +       // no external id
      'P-3,,Monday\n' +          // no crew
      'P-4,Crew A,\n';           // no day
    const { rows, skipped } = parseScheduleFile('sched.csv', csvBuffer(csv));
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(3);
    expect(skipped[0].reason).toMatch(/External ID/i);
    expect(skipped[1].reason).toMatch(/Crew/i);
    expect(skipped[2].reason).toMatch(/Day/i);
  });
});
