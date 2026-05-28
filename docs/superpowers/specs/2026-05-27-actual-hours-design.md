# Actual Hours Upload — Design

**Status:** Approved 2026-05-27. Migration + web + (no solver change).

## Goal
Jon: upload actual average hours-per-week per job; when a job consistently runs over/under its budgeted `est_labor_hours`, feed the actuals into scheduling. Plus a **pre-filled template download** so the upload columns/matching are guaranteed correct.

## Decisions (confirmed)
- **Upload:** a separate xlsx/CSV file (not the Aspire export), matched to properties by Aspire `external_id` (fallback: exact name).
- **Unit:** uploaded value is **avg hours/week**; converted to per-visit by frequency: `perVisitActual = actual_hours_per_week × (52 / annual_visits)`, annual_visits = weekly 52, biweekly 26, monthly 12 → ×1 / ×2 / ×4.333.
- **Override:** only when **variance > 15%** (`|perVisitActual − est_labor_hours| / est_labor_hours > 0.15`) does scheduling use `perVisitActual`; otherwise the budget. `est_labor_hours` is never overwritten.
- **Where applied:** in the **web** solver-payload builders (solver untouched) via a shared `effectiveLaborHours()` helper.

## Components

### 1. Migration
`properties.actual_hours_per_week numeric null`. Paste-ready SQL provided in the response (run via `supabase db push`, never auto-applied).

### 2. `src/lib/effective-labor.ts` (pure)
```
annualVisits(service_type): weekly 52 | biweekly 26 | monthly 12 (default 52)
perVisitActual(p): p.actual_hours_per_week == null ? null : actual * 52 / annualVisits(service_type)
effectiveLaborHours(p): const a = perVisitActual(p);
   if a == null || !est || est <= 0 return est_labor_hours;
   return Math.abs(a - est)/est > 0.15 ? a : est_labor_hours;
laborVariance(p): { perVisitActual, est, pct, applied } for display
```
`_VARIANCE_THRESHOLD = 0.15`. Used wherever a solver payload's per-property `est_labor_hours` is set (optimize, recommend, compare/baseline, capacity). Each call site maps `est_labor_hours -> effectiveLaborHours(p)` when constructing the payload.

### 3. Parser `src/lib/actual-hours-import.ts` (pure, xlsx + CSV via SheetJS)
Parse → `{ rows: { identifier: string; actual_hours_per_week: number }[]; skipped: { row: number; reason: string }[] }`. Expected headers (case-insensitive): an identifier column (`external_id` preferred, else `name`) and `actual_hours_per_week`. Skip rows with no identifier, non-numeric/negative hours; tolerate extra columns (the template carries reference columns the parser ignores). Mirrors `csv-import.ts` conventions + unit-tested.

### 4. Template download
A GET route `src/app/properties/actual-hours-template/route.ts` streams an **xlsx of all active properties** with columns: `external_id, name, city, service_type, est_labor_hours` (reference, read-only) and a blank `actual_hours_per_week` to fill. Round-tripping this file guarantees correct headers + `external_id` matching. Built with SheetJS (`xlsx`), same dep as the importer.

### 5. Upload UI + action
On the Properties page, an "Actual hours" card with a **Download template** link and an upload form. Server action: parse → match by `external_id` (fallback name) among active properties → update `actual_hours_per_week` → return inline `{ matched, updated, skipped[] }` summary (lighter than the full import-run tracking page; this only writes one column). Wrap the action `{ ok, error }` in a `useTransition` client component per the project's server-action-in-form rule.

### 6. Display (property detail page)
Show `actual_hours_per_week`, the per-visit equivalent, budget `est_labor_hours`, variance %, and a badge: "on budget" (≤15%) or "over/under budget — driving schedule" (>15%, since it then overrides). Cheap, and lets Jon see what the upload did.

## Testing (pure, no DB)
- `effective-labor.test.ts`: each frequency conversion; under/over the 15% threshold; null actual → est; est = 0 guard; variance fields.
- `actual-hours-import.test.ts`: good rows, missing identifier, non-numeric/negative hours skipped, header aliasing, extra columns ignored, both xlsx + CSV.

## Out of scope
Full import-run tracking page for actuals (inline summary instead); historical actuals over time (single current value per property); auto-refreshing existing runs when actuals change (next run picks them up).

## Deploy
Run the migration first. Redeploy web (and solver, though solver behavior is unchanged — the web sends corrected `est_labor_hours`). No data backfill needed (`actual_hours_per_week` null → behaves exactly as today).
