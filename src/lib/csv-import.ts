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

export interface ImportError {
  row: number;
  reason: string;
  raw: Record<string, unknown>;
}

export interface ImportResult {
  rows: AspireImportRow[];
  errors: ImportError[];
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

function parseAspireDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  // xlsx with cellDates: true gives us a Date object directly.
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = typeof v === 'string' ? v.trim() : String(v).trim();
  if (!s) return null;
  // Aspire exports vary: "MM/DD/YYYY" or "YYYY-MM-DD".
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mapRow(raw: Record<string, unknown>, rowIdx: number): AspireImportRow | ImportError {
  const get = (k: string) => {
    const v = raw[k];
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  };

  const name = get('Property');
  const address = get('Property Address 1');
  const city = get('Property City');
  const serviceAbr = get('Service Abr').toLowerCase();
  const estHrsStr = get('Est Hrs');
  const externalId = get('Property ID') || get('External ID') || null;
  const opportunityName = get('Opportunity Name') || null;

  if (!name) return { row: rowIdx, reason: 'Missing Property name', raw };
  if (!address) return { row: rowIdx, reason: 'Missing Property Address 1', raw };
  if (!city) return { row: rowIdx, reason: 'Missing Property City', raw };

  const serviceType = SERVICE_MAP[serviceAbr];
  if (!serviceType) {
    return { row: rowIdx, reason: `Unknown Service Abr: "${serviceAbr}"`, raw };
  }

  const estHrs = parseFloat(estHrsStr);
  if (!isFinite(estHrs) || estHrs <= 0) {
    return { row: rowIdx, reason: `Invalid Est Hrs: "${estHrsStr}"`, raw };
  }

  return {
    external_id: externalId,
    name,
    address,
    city,
    state: 'UT',
    service_type: serviceType,
    est_labor_hours: estHrs,
    contract_start_date: parseAspireDate(raw['Opportunity Start Date']),
    contract_end_date: parseAspireDate(raw['Opportunity End Date']),
    notes: opportunityName,
  };
}

function mapAll(rawRows: Array<Record<string, unknown>>): ImportResult {
  const rows: AspireImportRow[] = [];
  const errors: ImportError[] = [];
  rawRows.forEach((raw, idx) => {
    const result = mapRow(raw, idx + 2); // +2 = header row + 1-indexed
    if ('reason' in result) errors.push(result);
    else rows.push(result);
  });
  return { rows, errors };
}

export function parseAspireCsv(csvText: string): ImportResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const result = mapAll(parsed.data);
  parsed.errors.forEach((e) => {
    result.errors.push({ row: e.row ?? -1, reason: e.message, raw: {} });
  });
  return result;
}

export function parseAspireXlsx(buffer: ArrayBuffer): ImportResult {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { rows: [], errors: [{ row: -1, reason: 'Workbook contains no sheets', raw: {} }] };
  }
  const sheet = workbook.Sheets[firstSheetName];
  // sheet_to_json with header:1 gives an array-of-arrays; default (no header opt) gives objects keyed by header row.
  // defval:'' so missing cells are empty strings (matches our get() logic).
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: true, // keep numbers as numbers, dates as Date objects (with cellDates above)
  });
  // Trim header keys — xlsx preserves leading/trailing whitespace.
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
  // default: CSV
  const text = new TextDecoder('utf-8').decode(buffer);
  return parseAspireCsv(text);
}
