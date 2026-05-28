-- Measured average labor hours per week per property (uploaded separately from the Aspire export).
-- Null = no actual recorded (behaves exactly as before). Budget stays in est_labor_hours;
-- scheduling uses the actual only when it diverges from budget by more than the variance threshold
-- (see src/lib/effective-labor.ts).
alter table public.properties
  add column if not exists actual_hours_per_week numeric;
