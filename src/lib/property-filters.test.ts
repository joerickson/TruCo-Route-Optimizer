import { describe, it, expect } from 'vitest';
import {
  contractStatusOf,
  distinctCities,
  matchesFilters,
  type FilterState,
} from './property-filters';

const today = new Date('2026-05-25T12:00:00');

const allServices = { weekly: true, biweekly: true, monthly: true } as const;

describe('contractStatusOf', () => {
  it('active when today is within [start, end]', () => {
    expect(contractStatusOf({ contract_start_date: '2026-01-01', contract_end_date: '2026-12-31' }, today)).toBe('active');
  });
  it('inactive when expired (end before today)', () => {
    expect(contractStatusOf({ contract_start_date: '2025-01-01', contract_end_date: '2025-12-31' }, today)).toBe('inactive');
  });
  it('inactive when not yet started (start after today)', () => {
    expect(contractStatusOf({ contract_start_date: '2026-07-01', contract_end_date: null }, today)).toBe('inactive');
  });
  it('active with null start when today <= end', () => {
    expect(contractStatusOf({ contract_start_date: null, contract_end_date: '2026-12-31' }, today)).toBe('active');
  });
  it('active with null end when today >= start', () => {
    expect(contractStatusOf({ contract_start_date: '2026-01-01', contract_end_date: null }, today)).toBe('active');
  });
  it('active when both dates null', () => {
    expect(contractStatusOf({ contract_start_date: null, contract_end_date: null }, today)).toBe('active');
  });
  it('inclusive: active when today equals start or end', () => {
    expect(contractStatusOf({ contract_start_date: '2026-05-25', contract_end_date: '2026-05-25' }, today)).toBe('active');
  });
});

describe('distinctCities', () => {
  it('returns cities with counts, sorted by name, ignoring empties', () => {
    const result = distinctCities([
      { city: 'Provo' }, { city: 'Lehi' }, { city: 'Provo' }, { city: '' },
    ]);
    expect(result).toEqual([
      { city: 'Lehi', count: 1 },
      { city: 'Provo', count: 2 },
    ]);
  });
});

describe('matchesFilters', () => {
  const base = { city: 'Provo', service_type: 'weekly' as const, contract_start_date: '2026-01-01', contract_end_date: '2026-12-31' };

  it('passes when all filters are permissive (cities null, all services, contract all)', () => {
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(true);
  });
  it('cities null means all cities pass', () => {
    expect(matchesFilters(base, { cities: null, services: { ...allServices }, contract: 'all' }, today)).toBe(true);
  });
  it('cities empty array matches no properties', () => {
    expect(matchesFilters(base, { cities: [], services: { ...allServices }, contract: 'all' }, today)).toBe(false);
  });
  it('filters out a city not in the selection', () => {
    const state: FilterState = { cities: ['Lehi'], services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
  it('keeps a city in the selection', () => {
    const state: FilterState = { cities: ['Provo'], services: { ...allServices }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(true);
  });
  it('filters out a disabled service type', () => {
    const state: FilterState = { cities: null, services: { ...allServices, weekly: false }, contract: 'all' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
  it('contract=active excludes an expired property', () => {
    const expired = { ...base, contract_start_date: '2025-01-01', contract_end_date: '2025-12-31' };
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'active' };
    expect(matchesFilters(expired, state, today)).toBe(false);
  });
  it('contract=inactive excludes an active property', () => {
    const state: FilterState = { cities: null, services: { ...allServices }, contract: 'inactive' };
    expect(matchesFilters(base, state, today)).toBe(false);
  });
});
