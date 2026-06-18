import { describe, it, expect } from 'vitest';
import { parseAspireCsv, readHeaders, suggestMapping, EMPTY_MAPPING } from './csv-import';

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

describe('custom column mapping', () => {
  it('imports with only name/address/city mapped and defaults the rest', () => {
    const csv = 'Site,Street,Town\n' + 'JLL Church 1,500 S Temple,Salt Lake City\n';
    const { rows, skipped } = parseAspireCsv(csv, {
      ...EMPTY_MAPPING,
      name: 'Site',
      address: 'Street',
      city: 'Town',
    });
    expect(skipped).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'JLL Church 1',
      address: '500 S Temple',
      city: 'Salt Lake City',
      state: 'UT',
      service_type: 'weekly', // defaulted
      est_labor_hours: 1.0, // defaulted
    });
  });

  it('skips a row only when a required mapped column is empty', () => {
    const csv = 'Site,Street,Town\n' + ',500 S Temple,Salt Lake City\n';
    const { rows, skipped } = parseAspireCsv(csv, {
      ...EMPTY_MAPPING,
      name: 'Site',
      address: 'Street',
      city: 'Town',
    });
    expect(rows).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/name/i);
  });

  it('uses mapped service/hours values when provided', () => {
    const csv = 'Site,Street,Town,Freq,Hours\n' + 'A,1 Main,SLC,Monthly,3.5\n';
    const { rows } = parseAspireCsv(csv, {
      ...EMPTY_MAPPING,
      name: 'Site',
      address: 'Street',
      city: 'Town',
      service_type: 'Freq',
      est_labor_hours: 'Hours',
    });
    expect(rows[0]).toMatchObject({ service_type: 'monthly', est_labor_hours: 3.5 });
  });
});

describe('readHeaders + suggestMapping', () => {
  it('reads header names from a CSV', () => {
    const headers = readHeaders('x.csv', new TextEncoder().encode('Site,Street,Town\nA,B,C\n').buffer as ArrayBuffer);
    expect(headers).toEqual(['Site', 'Street', 'Town']);
  });

  it('auto-suggests Aspire headers to the right fields', () => {
    const suggested = suggestMapping(['Property', 'Property Address 1', 'Property City', 'Service Abr', 'Est Hrs']);
    expect(suggested.name).toBe('Property');
    expect(suggested.address).toBe('Property Address 1');
    expect(suggested.city).toBe('Property City');
    expect(suggested.service_type).toBe('Service Abr');
    expect(suggested.est_labor_hours).toBe('Est Hrs');
  });

  it('leaves a field null when no header matches', () => {
    const suggested = suggestMapping(['Site', 'Street', 'Town']);
    expect(suggested.name).toBe('Site');
    expect(suggested.address).toBe('Street');
    expect(suggested.city).toBe('Town');
    expect(suggested.est_labor_hours).toBeNull();
  });
});
