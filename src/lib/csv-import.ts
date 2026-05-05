// Aspire CSV/XLSX import — maps Aspire export columns to our properties schema.
import Papa from 'papaparse';
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

function parseAspireDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Aspire exports vary: "MM/DD/YYYY", "YYYY-MM-DD", or Excel serial via xlsx.
  const d = new Date(trimmed);
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
    contract_start_date: parseAspireDate(get('Opportunity Start Date')),
    contract_end_date: parseAspireDate(get('Opportunity End Date')),
    notes: opportunityName,
  };
}

export function parseAspireCsv(csvText: string): ImportResult {
  const parsed = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const rows: AspireImportRow[] = [];
  const errors: ImportError[] = [];

  parsed.data.forEach((raw, idx) => {
    const result = mapRow(raw, idx + 2); // +2 because of header + 1-indexed
    if ('reason' in result) errors.push(result);
    else rows.push(result);
  });

  parsed.errors.forEach((e) => {
    errors.push({ row: e.row ?? -1, reason: e.message, raw: {} });
  });

  return { rows, errors };
}
