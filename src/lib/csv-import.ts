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
  assigned_crew_name: string | null;
  assigned_day_raw: string | null;
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

// A mapping from our internal property fields to the source file's column headers.
// Only name/address/city are required to import a property (enough to geocode and
// place it on the map for a bid). Everything else is optional and falls back to a
// default when its column is unmapped or its value can't be read — real service
// frequency and labor hours are filled in after a property wins the bid.
export interface ColumnMapping {
  name: string | null;
  address: string | null;
  city: string | null;
  service_type: string | null;
  est_labor_hours: string | null;
  external_id: string | null;
  state: string | null;
  contract_start_date: string | null;
  contract_end_date: string | null;
  assigned_crew: string | null;
  assigned_day: string | null;
  notes: string | null;
}

export const REQUIRED_MAPPING_FIELDS: ReadonlyArray<keyof ColumnMapping> = ['name', 'address', 'city'];

// Default mapping = the Aspire export headers. Used when no mapping is supplied, so
// a real Aspire file still imports with zero configuration.
export const DEFAULT_MAPPING: ColumnMapping = {
  name: 'Property',
  address: 'Property Address 1',
  city: 'Property City',
  service_type: 'Service Abr',
  est_labor_hours: 'Est Hrs',
  external_id: 'Property ID',
  state: null,
  contract_start_date: 'Opportunity Start Date',
  contract_end_date: 'Opportunity End Date',
  assigned_crew: 'Crew',
  assigned_day: 'Service Day',
  notes: 'Opportunity Name',
};

// An all-null mapping — the base a custom client mapping is layered onto, so an
// unmapped optional field stays null rather than inheriting an Aspire default.
export const EMPTY_MAPPING: ColumnMapping = {
  name: null,
  address: null,
  city: null,
  service_type: null,
  est_labor_hours: null,
  external_id: null,
  state: null,
  contract_start_date: null,
  contract_end_date: null,
  assigned_crew: null,
  assigned_day: null,
  notes: null,
};

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

// Read a mapped column's value; an unmapped (null) column yields ''.
function mapped(raw: Record<string, unknown>, header: string | null): string {
  if (!header) return '';
  return getStr(raw, header);
}

function mapRow(
  raw: Record<string, unknown>,
  rowNumber: number,
  m: ColumnMapping
): AspireImportRow | SkippedRow {
  const name = mapped(raw, m.name);
  const address = mapped(raw, m.address);
  const city = mapped(raw, m.city);

  const skip = (reason: string): SkippedRow => ({
    row_number: rowNumber,
    property_name: name || null,
    city: city || null,
    reason,
    raw,
  });

  // Only name/address/city are required — enough to geocode and map the property.
  if (!name) return skip('Missing property name (mapped column is empty)');
  if (!address) return skip('Missing property address (mapped column is empty)');
  if (!city) return skip('Missing property city (mapped column is empty)');

  // Optional fields: fall back to a default when unmapped or unreadable, rather than
  // skipping the row. Service frequency and labor hours are refined after the bid.
  const serviceRaw = mapped(raw, m.service_type).toLowerCase();
  const serviceType: ServiceType = SERVICE_MAP[serviceRaw] ?? 'weekly';

  const estStr = mapped(raw, m.est_labor_hours);
  const estParsed = parseFloat(estStr);
  const estHrs = isFinite(estParsed) && estParsed > 0 ? estParsed : 1.0;

  const externalId = mapped(raw, m.external_id) || null;
  const state = mapped(raw, m.state) || 'UT';
  const notes = mapped(raw, m.notes) || null;

  // Invalid optional dates are tolerated as null (not a skip).
  const startDate = m.contract_start_date ? parseAspireDate(raw[m.contract_start_date], m.contract_start_date) : null;
  const endDate = m.contract_end_date ? parseAspireDate(raw[m.contract_end_date], m.contract_end_date) : null;

  const assignedCrew = mapped(raw, m.assigned_crew) || null;
  const assignedDay = mapped(raw, m.assigned_day) || null;

  return {
    external_id: externalId,
    name,
    address,
    city,
    state,
    service_type: serviceType,
    est_labor_hours: estHrs,
    contract_start_date: startDate && startDate.ok ? startDate.value : null,
    contract_end_date: endDate && endDate.ok ? endDate.value : null,
    notes,
    assigned_crew_name: assignedCrew,
    assigned_day_raw: assignedDay,
  };
}

function isSkipped(r: AspireImportRow | SkippedRow): r is SkippedRow {
  return 'reason' in r;
}

function mapAll(rawRows: Array<Record<string, unknown>>, mapping: ColumnMapping): ImportResult {
  const rows: AspireImportRow[] = [];
  const skipped: SkippedRow[] = [];
  rawRows.forEach((raw, idx) => {
    // idx 0 = first data row. With a header row, that's row 2 in the file (1-indexed, header is row 1).
    const result = mapRow(raw, idx + 2, mapping);
    if (isSkipped(result)) skipped.push(result);
    else rows.push(result);
  });
  return { rows, skipped };
}

export function parseAspireCsv(csvText: string, mapping: ColumnMapping = DEFAULT_MAPPING): ImportResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const result = mapAll(parsed.data, mapping);
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

export function parseAspireXlsx(buffer: ArrayBuffer, mapping: ColumnMapping = DEFAULT_MAPPING): ImportResult {
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
  return mapAll(trimmed, mapping);
}

export function parseAspireFile(
  filename: string,
  buffer: ArrayBuffer,
  mapping: ColumnMapping = DEFAULT_MAPPING
): ImportResult {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    return parseAspireXlsx(buffer, mapping);
  }
  const text = new TextDecoder('utf-8').decode(buffer);
  return parseAspireCsv(text, mapping);
}

// Read just the header row of a file (xlsx or csv) so the import UI can offer the
// user a column-mapping step. Returns the trimmed, non-empty column names in order.
export function readHeaders(filename: string, buffer: ArrayBuffer): string[] {
  const lower = filename.toLowerCase();
  let header: unknown[] = [];
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (sheet) {
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
      header = rows[0] ?? [];
    }
  } else {
    const text = new TextDecoder('utf-8').decode(buffer);
    const parsed = Papa.parse<string[]>(text, { preview: 1, skipEmptyLines: true });
    header = parsed.data[0] ?? [];
  }
  return header.map((h) => String(h ?? '').trim()).filter((h) => h.length > 0);
}

// Header-name aliases used to pre-fill the mapping dropdowns. Matched against a
// normalized (lowercase, alphanumeric-only) form of each source header.
const SUGGEST_ALIASES: Record<keyof ColumnMapping, string[]> = {
  name: ['property', 'propertyname', 'name', 'sitename', 'site', 'location', 'account'],
  address: ['propertyaddress1', 'propertyaddress', 'address1', 'address', 'street', 'streetaddress'],
  city: ['propertycity', 'city', 'town'],
  service_type: ['serviceabr', 'servicetype', 'service', 'servicefrequency', 'frequency'],
  est_labor_hours: ['esthrs', 'esthours', 'estimatedhours', 'laborhours', 'manhours', 'hours'],
  external_id: ['propertyid', 'externalid', 'accountid', 'id'],
  state: ['propertystate', 'state'],
  contract_start_date: ['opportunitystartdate', 'startdate', 'contractstart', 'start'],
  contract_end_date: ['opportunityenddate', 'enddate', 'contractend', 'end'],
  assigned_crew: ['assignedcrew', 'crew', 'route'],
  assigned_day: ['serviceday', 'dayofweek', 'day'],
  notes: ['opportunityname', 'notes', 'description', 'comments'],
};

const UNSAFE_PARTIAL_ALIASES = new Set(['id', 'end', 'start', 'day']);

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Best-guess mapping from a file's headers: exact normalized match first, then a
// contains-match. Unmatched fields are left null for the user to set.
export function suggestMapping(headers: string[]): ColumnMapping {
  const norm = headers.map((h) => ({ raw: h, n: normalizeHeader(h) }));
  const used = new Set<string>();
  const pick = (aliases: string[]): string | null => {
    for (const a of aliases) {
      const exact = norm.find((h) => !used.has(h.raw) && h.n === a);
      if (exact) { used.add(exact.raw); return exact.raw; }
    }
    for (const a of aliases) {
      if (UNSAFE_PARTIAL_ALIASES.has(a)) continue;
      const partial = norm.find((h) => !used.has(h.raw) && (h.n.includes(a) || a.includes(h.n)));
      if (partial) { used.add(partial.raw); return partial.raw; }
    }
    return null;
  };
  const out = { ...EMPTY_MAPPING };
  (Object.keys(SUGGEST_ALIASES) as (keyof ColumnMapping)[]).forEach((field) => {
    out[field] = pick(SUGGEST_ALIASES[field]);
  });
  return out;
}
