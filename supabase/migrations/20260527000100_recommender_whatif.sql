-- Link a crew recommendation to the read-only "what-if" optimization run that shows
-- the schedule its recommended fleet produces.
alter table public.crew_recommendations
  add column if not exists optimization_run_id uuid
    references public.optimization_runs(id) on delete set null;

-- Allow the what-if run kind (existing inline check is auto-named *_run_kind_check).
alter table public.optimization_runs drop constraint if exists optimization_runs_run_kind_check;
alter table public.optimization_runs
  add constraint optimization_runs_run_kind_check
    check (run_kind in ('optimized','baseline','what_if'));
