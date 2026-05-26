-- Distinguish baseline (scored current schedule) runs from optimized runs.
-- Both live in optimization_runs so the baseline reuses the run-detail tabs.
alter table optimization_runs
  add column if not exists run_kind text not null default 'optimized'
    check (run_kind in ('optimized', 'baseline'));

create index if not exists optimization_runs_kind_idx
  on optimization_runs(run_kind, created_at desc);
