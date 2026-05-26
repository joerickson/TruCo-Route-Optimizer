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
