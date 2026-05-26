// Standalone current-schedule import — maps a schedule sheet (external_id -> crew, day)
// onto existing properties' assigned_crew_id / assigned_day_of_week.
// Shares the skipped-row shape with csv-import.ts.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { SkippedRow } from './csv-import';

const DAY_NAMES: Record<string, number> = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

export function parseDayOfWeek(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s in DAY_NAMES) return DAY_NAMES[s];
  if (/^[1-7]$/.test(s)) return Number(s);
  return null;
}

export function resolveCrewId(name: string, crewsByName: Map<string, string>): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return crewsByName.get(key) ?? null;
}

export interface ScheduleAssignmentRow {
  external_id: string;
  assigned_crew_name: string;
  assigned_day_raw: string;
}

export interface ScheduleImportResult {
  rows: ScheduleAssignmentRow[];
  skipped: SkippedRow[];
}

// Re-export types so consumers can import from a single location
export type { SkippedRow };

// Papa and XLSX are used by parseScheduleFile (added in a later task).
// Declare intentional references to suppress tree-shaking / lint warnings
// without marking them as used in dead code.
void (Papa as unknown);
void (XLSX as unknown);
