-- Scenarios — isolated property/crew/branch/run sets for bid analysis.

create table if not exists scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamp with time zone default now()
);

-- At most one default scenario.
create unique index if not exists scenarios_one_default on scenarios (is_default) where is_default;

-- Default scenario for all pre-existing data (idempotent).
insert into scenarios (name, description, is_default)
select 'TruCo Portfolio', 'Live 30-crew SLC portfolio', true
where not exists (select 1 from scenarios where is_default);

-- Add scenario_id (nullable first so the backfill can run).
alter table properties         add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table crews              add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table branches           add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table optimization_runs  add column if not exists scenario_id uuid references scenarios(id) on delete cascade;

-- Backfill everything into the default scenario.
update properties        set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update crews             set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update branches          set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update optimization_runs set scenario_id = (select id from scenarios where is_default) where scenario_id is null;

-- Enforce not null now that every row has a scenario.
alter table properties        alter column scenario_id set not null;
alter table crews             alter column scenario_id set not null;
alter table branches          alter column scenario_id set not null;
alter table optimization_runs alter column scenario_id set not null;

create index if not exists properties_scenario_idx        on properties(scenario_id);

-- Per-scenario uniqueness for Aspire/CSV external ids (NULLs are distinct, so
-- many properties without an external_id can coexist in a scenario).
create unique index if not exists properties_scenario_external_idx on properties(scenario_id, external_id);
create index if not exists crews_scenario_idx             on crews(scenario_id);
create index if not exists branches_scenario_idx          on branches(scenario_id);
create index if not exists optimization_runs_scenario_idx on optimization_runs(scenario_id);
