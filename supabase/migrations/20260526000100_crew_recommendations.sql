-- Crew-mix recommendations: each run of the solver's `recommend` mode writes one row.
create table if not exists crew_recommendations (
  id uuid primary key default gen_random_uuid(),
  name text,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed')),
  active_branch_ids uuid[],
  active_property_ids uuid[],
  config_snapshot jsonb,
  result_jsonb jsonb,
  iterations int,
  solver_runtime_seconds numeric,
  failure_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create index if not exists crew_recommendations_created_idx
  on crew_recommendations(created_at desc);
