-- Persist the solver's unassigned property ids so the UI can surface
-- properties that could not be scheduled.
alter table optimization_runs
  add column if not exists unassigned_property_ids uuid[];
