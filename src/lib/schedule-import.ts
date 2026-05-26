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

function getStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function mapScheduleRow(
  raw: Record<string, unknown>,
  rowNumber: number,
): ScheduleAssignmentRow | SkippedRow {
  const externalId = getStr(raw, 'External ID') || getStr(raw, 'Property ID');
  const crew = getStr(raw, 'Crew') || getStr(raw, 'Assigned Crew');
  const day = getStr(raw, 'Day') || getStr(raw, 'Service Day');

  const skip = (reason: string): SkippedRow => ({
    row_number: rowNumber,
    property_name: externalId || null,
    city: null,
    reason,
    raw,
  });

  if (!externalId) return skip("Missing External ID (column 'External ID' or 'Property ID')");
  if (!crew) return skip("Missing Crew (column 'Crew' or 'Assigned Crew')");
  if (!day) return skip("Missing Day (column 'Day' or 'Service Day')");

  return { external_id: externalId, assigned_crew_name: crew, assigned_day_raw: day };
}

function isSkipped(r: ScheduleAssignmentRow | SkippedRow): r is SkippedRow {
  return 'reason' in r;
}

function mapAll(rawRows: Array<Record<string, unknown>>): ScheduleImportResult {
  const rows: ScheduleAssignmentRow[] = [];
  const skipped: SkippedRow[] = [];
  rawRows.forEach((raw, idx) => {
    const result = mapScheduleRow(raw, idx + 2); // header is row 1
    if (isSkipped(result)) skipped.push(result);
    else rows.push(result);
  });
  return { rows, skipped };
}

export function parseScheduleFile(filename: string, buffer: ArrayBuffer): ScheduleImportResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { rows: [], skipped: [{ row_number: -1, property_name: null, city: null, reason: 'Workbook contains no sheets', raw: {} }] };
    }
    const sheet = workbook.Sheets[firstSheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });
    const trimmed = json.map((row) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(row)) out[k.trim()] = row[k];
      return out;
    });
    return mapAll(trimmed);
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const result = mapAll(parsed.data);
  parsed.errors.forEach((e) => {
    result.skipped.push({
      row_number: typeof e.row === 'number' ? e.row + 2 : -1,
      property_name: null,
      city: null,
      reason: `CSV parse error: ${e.message}`,
      raw: {},
    });
  });
  return result;
}
