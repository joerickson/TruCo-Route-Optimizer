// Aspire CSV/XLSX import — maps Aspire export columns to our properties schema.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { ServiceType } from './types';

export interface AspireImportRow {
  external_id: string | null;
  name: string;
  address: string;
  city: string;
  state: string;
  service_type: ServiceType;
  est_labor_hours: number;
  contract_start_date: string | null;
  contract_end_date: string | null;
  notes: string | null;
}

export interface SkippedRow {
  row_number: number; // 1-indexed in source file; header is row 1
  property_name: string | null;
  city: string | null;
  reason: string;
  raw: Record<string, unknown>;
}

export interface ImportResult {
  rows: AspireImportRow[];
  skipped: SkippedRow[];
}

const SERVICE_MAP: Record<string, ServiceType> = {
  'weekly mt': 'weekly',
  'weekly': 'weekly',
  'bi-weekly': 'biweekly',
  'biweekly': 'biweekly',
  'bi weekly': 'biweekly',
  'monthly mt service': 'monthly',
  'monthly': 'monthly',
};

const KNOWN_SERVICES = 'Weekly MT, Bi-Weekly, Monthly MT Service';

type DateParseResult = { ok: true; value: string | null } | { ok: false; reason: string };

function parseAspireDate(v: unknown, columnName: string): DateParseResult {
  // Empty is allowed — some properties have no end date.
  if (v == null || v === '') return { ok: true, value: null };
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return { ok: false, reason: `Invalid date in '${columnName}': ${String(v)}` };
    return { ok: true, value: v.toISOString().slice(0, 10) };
  }
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return { ok: true, value: null };
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    return { ok: false, reason: `Invalid date format in '${columnName}': "${s}" (expected MM/DD/YYYY or YYYY-MM-DD)` };
  }
  return { ok: true, value: d.toISOString().slice(0, 10) };
}

function getStr(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
}

function mapRow(raw: Record<string, unknown>, rowNumber: number): AspireImportRow | SkippedRow {
  const name = getStr(raw, 'Property');
  const address = getStr(raw, 'Property Address 1');
  const city = getStr(raw, 'Property City');
  const serviceAbrRaw = getStr(raw, 'Service Abr');
  const serviceAbr = serviceAbrRaw.toLowerCase();
  const estHrsStr = getStr(raw, 'Est Hrs');
  const externalId = getStr(raw, 'Property ID') || getStr(raw, 'External ID') || null;
  const opportunityName = getStr(raw, 'Opportunity Name') || null;

  const skip = (reason: string): SkippedRow => ({
    row_number: rowNumber,
    property_name: name || null,
    city: city || null,
    reason,
    raw,
  });

  if (!name) return skip("Missing Property name (column 'Property' is empty)");
  if (!address) return skip("Missing Property address (column 'Property Address 1' is empty)");
  if (!city) return skip("Missing Property city (column 'Property City' is empty)");

  if (!serviceAbrRaw) {
    return skip(`Missing 'Service Abr' (expected one of: ${KNOWN_SERVICES})`);
  }
  const serviceType = SERVICE_MAP[serviceAbr];
  if (!serviceType) {
    return skip(`Service Abr "${serviceAbrRaw}" not recognized — expected one of: ${KNOWN_SERVICES}`);
  }

  if (!estHrsStr) {
    return skip("Est Hrs is empty; cannot route a property with no time estimate");
  }
  const estHrs = parseFloat(estHrsStr);
  if (!isFinite(estHrs)) {
    return skip(`Est Hrs is not a number: "${estHrsStr}"`);
  }
  if (estHrs <= 0) {
    return skip(`Est Hrs is ${estHrs}; cannot route a property with no time estimate`);
  }

  const startDate = parseAspireDate(raw['Opportunity Start Date'], 'Opportunity Start Date');
  if (!startDate.ok) return skip(startDate.reason);
  const endDate = parseAspireDate(raw['Opportunity End Date'], 'Opportunity End Date');
  if (!endDate.ok) return skip(endDate.reason);

  return {
    external_id: externalId,
    name,
    address,
    city,
    state: 'UT',
    service_type: serviceType,
    est_labor_hours: estHrs,
    contract_start_date: startDate.value,
    contract_end_date: endDate.value,
    notes: opportunityName,
  };
}

function isSkipped(r: AspireImportRow | SkippedRow): r is SkippedRow {
  return 'reason' in r;
}

function mapAll(rawRows: Array<Record<string, unknown>>): ImportResult {
  const rows: AspireImportRow[] = [];
  const skipped: SkippedRow[] = [];
  rawRows.forEach((raw, idx) => {
    // idx 0 = first data row. With a header row, that's row 2 in the file (1-indexed, header is row 1).
    const result = mapRow(raw, idx + 2);
    if (isSkipped(result)) skipped.push(result);
    else rows.push(result);
  });
  return { rows, skipped };
}

export function parseAspireCsv(csvText: string): ImportResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
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

export function parseAspireXlsx(buffer: ArrayBuffer): ImportResult {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return {
      rows: [],
      skipped: [
        { row_number: -1, property_name: null, city: null, reason: 'Workbook contains no sheets', raw: {} },
      ],
    };
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

export function parseAspireFile(filename: string, buffer: ArrayBuffer): ImportResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    return parseAspireXlsx(buffer);
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  return parseAspireCsv(text);
}
