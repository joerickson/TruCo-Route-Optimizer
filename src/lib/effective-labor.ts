import type { ServiceType } from './types';

// Budget vs actual: when a job's measured hours diverge from its budgeted est_labor_hours by more
// than this, scheduling uses the actual. Smaller divergences keep the budget (avoid churn/noise).
export const VARIANCE_THRESHOLD = 0.15;

const ANNUAL_VISITS: Record<ServiceType, number> = { weekly: 52, biweekly: 26, monthly: 12 };

export function annualVisits(serviceType: ServiceType): number {
  return ANNUAL_VISITS[serviceType] ?? 52;
}

// Minimal shape needed to reason about labor — works on a full Property or any subset with these.
export type LaborInput = {
  service_type: ServiceType;
  est_labor_hours: number;
  actual_hours_per_week?: number | null;
};

// Convert uploaded avg hours/week to per-visit (the unit est_labor_hours uses), by frequency.
// weekly ×1, biweekly ×2, monthly ×~4.33. Null when no actual was uploaded.
export function perVisitActual(p: LaborInput): number | null {
  if (p.actual_hours_per_week == null) return null;
  return p.actual_hours_per_week * (52 / annualVisits(p.service_type));
}

// The per-visit labor scheduling should use: the actual when it diverges from budget by > threshold,
// otherwise the budget. Never returns null — falls back to est_labor_hours.
export function effectiveLaborHours(p: LaborInput): number {
  const actual = perVisitActual(p);
  const est = p.est_labor_hours;
  if (actual == null || !est || est <= 0) return est;
  return Math.abs(actual - est) / est > VARIANCE_THRESHOLD ? actual : est;
}

// Map a property list to the form sent to the solver: est_labor_hours replaced by the effective
// (actual-corrected) per-visit labor. Everything else is preserved. Apply at every solver-payload
// boundary so a run schedules with corrected hours; the stored est_labor_hours budget is untouched.
export function withEffectiveLabor<T extends LaborInput>(properties: T[]): T[] {
  return properties.map((p) => ({ ...p, est_labor_hours: effectiveLaborHours(p) }));
}

// For display: the per-visit actual, the budget, the signed variance fraction, and whether the
// actual is large enough to drive the schedule (|variance| > threshold).
export function laborVariance(p: LaborInput): {
  perVisitActual: number | null;
  est: number;
  pct: number | null;
  applied: boolean;
} {
  const actual = perVisitActual(p);
  const est = p.est_labor_hours;
  if (actual == null || !est || est <= 0) return { perVisitActual: actual, est, pct: null, applied: false };
  const pct = (actual - est) / est;
  return { perVisitActual: actual, est, pct, applied: Math.abs(pct) > VARIANCE_THRESHOLD };
}
