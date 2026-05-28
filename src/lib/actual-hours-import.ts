// Actual-hours upload — a focused file mapping properties to their measured avg hours/week.
// Matched to properties by Aspire external_id (preferred) or exact name. Mirrors csv-import.ts.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

export interface ActualHoursRow {
  identifier: string; // external_id when byExternalId, else the property name
  byExternalId: boolean;
  actual_hours_per_week: number;
}

export interface ActualHoursSkipped {
  row_number: number; // 1-indexed in source; header is row 1
  reason: string;
  raw: Record<string, unknown>;
}

export interface ActualHoursResult {
  rows: ActualHoursRow[];
  skipped: ActualHoursSkipped[];
}

// Header aliases (lowercased, trimmed). The template emits 'actual_hours_per_week'.
const HOURS_KEYS = ['actual_hours_per_week', 'actual hours per week', 'actual hours/week', 'actual_hours'];
const EXTID_KEYS = ['external_id', 'external id', 'aspire id'];
const NAME_KEYS = ['name', 'property', 'property name'];

function lowerKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(raw)) out[k.trim().toLowerCase()] = raw[k];
  return out;
}

function pick(norm: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (norm[k] !== undefined) return norm[k];
  return undefined;
}

function asStr(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function mapRows(json: Record<string, unknown>[]): ActualHoursResult {
  const rows: ActualHoursRow[] = [];
  const skipped: ActualHoursSkipped[] = [];
  json.forEach((raw, i) => {
    const rowNum = i + 2; // +1 for 0-index, +1 for header
    const norm = lowerKeys(raw);
    const ext = asStr(pick(norm, EXTID_KEYS));
    const name = asStr(pick(norm, NAME_KEYS));
    const hoursRaw = pick(norm, HOURS_KEYS);
    const hoursStr = asStr(hoursRaw);

    if (hoursStr === '') return; // blank — unfilled template row, silently ignored (not an error)

    if (!ext && !name) {
      skipped.push({ row_number: rowNum, reason: 'No external_id or name to match a property', raw });
      return;
    }
    const hours = Number(hoursStr);
    if (!Number.isFinite(hours) || hours < 0) {
      skipped.push({ row_number: rowNum, reason: `Invalid actual_hours_per_week: "${hoursStr}"`, raw });
      return;
    }
    rows.push({ identifier: ext || name, byExternalId: !!ext, actual_hours_per_week: hours });
  });
  return { rows, skipped };
}

export function parseActualHoursCsv(csvText: string): ActualHoursResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  return mapRows(parsed.data);
}

export function parseActualHoursXlsx(buffer: ArrayBuffer): ActualHoursResult {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { rows: [], skipped: [{ row_number: -1, reason: 'Workbook contains no sheets', raw: {} }] };
  }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
    raw: true,
  });
  return mapRows(json);
}

export function parseActualHoursFile(filename: string, buffer: ArrayBuffer): ActualHoursResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    return parseActualHoursXlsx(buffer);
  }
  return parseActualHoursCsv(new TextDecoder('utf-8').decode(buffer));
}
