// Guards that each downloadable template's columns round-trip through its parser, so a user who
// fills the template and uploads it gets matched rows (not skipped). Header sets here MUST match
// what the template routes emit (src/app/.../*-template/route.ts).
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseScheduleFile } from './schedule-import';
import { parseAspireFile } from './csv-import';
import { parseActualHoursFile } from './actual-hours-import';

function xlsxBuffer(rows: Record<string, unknown>[], header: string[]): ArrayBuffer {
  const ws = XLSX.utils.json_to_sheet(rows, { header });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return buf as ArrayBuffer;
}

describe('template round-trips', () => {
  it('schedule template columns parse (External ID / Crew / Day) when filled', () => {
    const buf = xlsxBuffer(
      [{ 'External ID': 'A-1', name: 'Acme', city: 'SLC', service_type: 'weekly', Crew: 'Crew 1', Day: 'Monday' }],
      ['External ID', 'name', 'city', 'service_type', 'Crew', 'Day']
    );
    const { rows, skipped } = parseScheduleFile('current-schedule-template.xlsx', buf);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([{ external_id: 'A-1', assigned_crew_name: 'Crew 1', assigned_day_raw: 'Monday' }]);
  });

  it('aspire template example row parses into a property (not skipped)', () => {
    const buf = xlsxBuffer(
      [{
        'Property ID': 'A-1001', Property: 'Example Property LLC', 'Property Address 1': '123 Main St',
        'Property City': 'Salt Lake City', 'Service Abr': 'Weekly MT', 'Est Hrs': 9,
        'Opportunity Start Date': '2026-04-01', 'Opportunity End Date': '2026-11-30', Crew: 'Crew 1', 'Service Day': 'Monday',
      }],
      ['Property ID', 'Property', 'Property Address 1', 'Property City', 'Service Abr', 'Est Hrs',
        'Opportunity Start Date', 'Opportunity End Date', 'Crew', 'Service Day']
    );
    const { rows, skipped } = parseAspireFile('aspire-import-template.xlsx', buf);
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ external_id: 'A-1001', name: 'Example Property LLC', service_type: 'weekly', est_labor_hours: 9 });
  });

  it('actual-hours template columns parse when actual filled (reference cols ignored)', () => {
    const buf = xlsxBuffer(
      [{ external_id: 'A-1', name: 'Acme', city: 'SLC', service_type: 'weekly',
        'est_labor_hours (budget, per visit)': 9, actual_hours_per_week: 11.5 }],
      ['external_id', 'name', 'city', 'service_type', 'est_labor_hours (budget, per visit)', 'actual_hours_per_week']
    );
    const { rows, skipped } = parseActualHoursFile('actual-hours-template.xlsx', buf);
    expect(skipped).toEqual([]);
    expect(rows).toEqual([{ identifier: 'A-1', byExternalId: true, actual_hours_per_week: 11.5 }]);
  });
});
