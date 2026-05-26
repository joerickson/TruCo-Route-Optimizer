import { describe, it, expect } from 'vitest';
import { parseAspireCsv } from './csv-import';

describe('parseAspireCsv crew/day columns', () => {
  it('captures Crew and Service Day when present', () => {
    const csv =
      'Property,Property Address 1,Property City,Service Abr,Est Hrs,Crew,Service Day\n' +
      'Acme HQ,1 Main St,SLC,Weekly,2,Crew A,Tuesday\n';
    const { rows } = parseAspireCsv(csv);
    expect(rows[0].assigned_crew_name).toBe('Crew A');
    expect(rows[0].assigned_day_raw).toBe('Tuesday');
  });
  it('leaves them null when columns are absent', () => {
    const csv =
      'Property,Property Address 1,Property City,Service Abr,Est Hrs\n' +
      'Acme HQ,1 Main St,SLC,Weekly,2\n';
    const { rows } = parseAspireCsv(csv);
    expect(rows[0].assigned_crew_name).toBeNull();
    expect(rows[0].assigned_day_raw).toBeNull();
  });
});
