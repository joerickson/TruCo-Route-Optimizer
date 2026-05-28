import { describe, it, expect } from 'vitest';
import { parseActualHoursCsv } from './actual-hours-import';

describe('parseActualHoursCsv', () => {
  it('parses external_id + hours, ignoring extra reference columns', () => {
    const csv = [
      'external_id,name,city,service_type,est_labor_hours,actual_hours_per_week',
      'A-100,Acme,SLC,weekly,9,11.5',
      'A-200,Beta,Provo,biweekly,20,8',
    ].join('\n');
    const r = parseActualHoursCsv(csv);
    expect(r.skipped).toEqual([]);
    expect(r.rows).toEqual([
      { identifier: 'A-100', byExternalId: true, actual_hours_per_week: 11.5 },
      { identifier: 'A-200', byExternalId: true, actual_hours_per_week: 8 },
    ]);
  });

  it('falls back to name when external_id is blank', () => {
    const csv = 'external_id,name,actual_hours_per_week\n,Gamma Property,6\n';
    const r = parseActualHoursCsv(csv);
    expect(r.rows).toEqual([{ identifier: 'Gamma Property', byExternalId: false, actual_hours_per_week: 6 }]);
  });

  it('silently drops blank-hours rows (unfilled template rows)', () => {
    const csv = 'external_id,name,actual_hours_per_week\nA-1,Acme,\nA-2,Beta,7\n';
    const r = parseActualHoursCsv(csv);
    expect(r.rows).toEqual([{ identifier: 'A-2', byExternalId: true, actual_hours_per_week: 7 }]);
    expect(r.skipped).toEqual([]); // blank is not an error
  });

  it('skips rows with no identifier or invalid hours', () => {
    const csv = 'external_id,name,actual_hours_per_week\n,,5\nA-3,Acme,abc\nA-4,Beta,-2\n';
    const r = parseActualHoursCsv(csv);
    expect(r.rows).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual([
      expect.stringContaining('No external_id or name'),
      expect.stringContaining('Invalid actual_hours_per_week'),
      expect.stringContaining('Invalid actual_hours_per_week'),
    ]);
  });

  it('accepts header aliases', () => {
    const csv = 'Aspire ID,Property,Actual Hours/Week\nX-9,Foo,4.2\n';
    const r = parseActualHoursCsv(csv);
    expect(r.rows).toEqual([{ identifier: 'X-9', byExternalId: true, actual_hours_per_week: 4.2 }]);
  });
});
