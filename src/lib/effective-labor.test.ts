import { describe, it, expect } from 'vitest';
import { perVisitActual, effectiveLaborHours, laborVariance } from './effective-labor';

describe('perVisitActual', () => {
  it('converts avg-per-week to per-visit by frequency', () => {
    expect(perVisitActual({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: 12 })).toBeCloseTo(12);
    expect(perVisitActual({ service_type: 'biweekly', est_labor_hours: 20, actual_hours_per_week: 8 })).toBeCloseTo(16);
    expect(perVisitActual({ service_type: 'monthly', est_labor_hours: 10, actual_hours_per_week: 3 })).toBeCloseTo(13, 0);
  });
  it('is null when no actual uploaded', () => {
    expect(perVisitActual({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: null })).toBeNull();
    expect(perVisitActual({ service_type: 'weekly', est_labor_hours: 9 })).toBeNull();
  });
});

describe('effectiveLaborHours', () => {
  it('uses the actual when variance exceeds the threshold', () => {
    expect(effectiveLaborHours({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: 12 })).toBeCloseTo(12); // +33%
    expect(effectiveLaborHours({ service_type: 'biweekly', est_labor_hours: 20, actual_hours_per_week: 8 })).toBeCloseTo(16); // -20%
  });
  it('keeps the budget when variance is within the threshold', () => {
    expect(effectiveLaborHours({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: 10 })).toBe(9); // +11%
  });
  it('falls back to budget with no actual', () => {
    expect(effectiveLaborHours({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: null })).toBe(9);
  });
  it('guards est_labor_hours = 0 (no division)', () => {
    expect(effectiveLaborHours({ service_type: 'weekly', est_labor_hours: 0, actual_hours_per_week: 5 })).toBe(0);
  });
});

describe('laborVariance', () => {
  it('reports signed variance and applied flag', () => {
    const over = laborVariance({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: 12 });
    expect(over.pct).toBeCloseTo(0.333, 2);
    expect(over.applied).toBe(true);
    const within = laborVariance({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: 10 });
    expect(within.applied).toBe(false);
    const none = laborVariance({ service_type: 'weekly', est_labor_hours: 9, actual_hours_per_week: null });
    expect(none).toEqual({ perVisitActual: null, est: 9, pct: null, applied: false });
  });
});
