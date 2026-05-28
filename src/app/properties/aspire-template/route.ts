import * as XLSX from 'xlsx';

export const dynamic = 'force-dynamic';

// Template for the Aspire property import. Unlike the actual-hours / schedule templates (which
// pre-fill existing properties), this is the INITIAL load, so it's the exact column headers the
// parser reads (csv-import.ts) plus one example row and a Reference sheet of valid values.
const HEADERS = [
  'Property ID',
  'Property',
  'Property Address 1',
  'Property City',
  'Service Abr',
  'Est Hrs',
  'Opportunity Start Date',
  'Opportunity End Date',
  'Crew',
  'Service Day',
];

export async function GET() {
  const example = {
    'Property ID': 'A-1001',
    Property: 'Example Property LLC',
    'Property Address 1': '123 Main St',
    'Property City': 'Salt Lake City',
    'Service Abr': 'Weekly MT',
    'Est Hrs': 9,
    'Opportunity Start Date': '2026-04-01',
    'Opportunity End Date': '2026-11-30',
    Crew: 'Crew 1',
    'Service Day': 'Monday',
  };
  const reference = [
    { Column: 'Property ID', Notes: 'Aspire property id — used to match on re-import (recommended).' },
    { Column: 'Property', Notes: 'Property name. Required.' },
    { Column: 'Service Abr', Notes: 'One of: Weekly MT, Bi-Weekly, Monthly MT Service' },
    { Column: 'Est Hrs', Notes: 'Budgeted labor hours per visit (person-hours). Required.' },
    { Column: 'Opportunity Start/End Date', Notes: 'MM/DD/YYYY or YYYY-MM-DD. End may be blank.' },
    { Column: 'Crew / Service Day', Notes: 'Optional current assignment (crew name; Monday–Sunday or 1–7).' },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([example], { header: HEADERS }), 'Properties');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reference), 'Reference');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="aspire-import-template.xlsx"',
    },
  });
}
