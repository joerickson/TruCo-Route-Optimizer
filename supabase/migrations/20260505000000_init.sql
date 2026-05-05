-- TruCo Route Optimizer — initial schema

create extension if not exists "pgcrypto";

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  city text not null,
  state text not null,
  postal_code text,
  lat numeric not null,
  lng numeric not null,
  is_active boolean default true,
  created_at timestamp with time zone default now()
);

create table if not exists crews (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  crew_size int not null default 2,
  home_branch_id uuid not null references branches(id) on delete restrict,

  works_monday boolean default true,
  works_tuesday boolean default true,
  works_wednesday boolean default true,
  works_thursday boolean default true,
  works_friday boolean default true,
  works_saturday boolean default false,
  works_sunday boolean default false,

  max_clock_hours_per_day numeric default 8,

  is_active boolean default true,
  notes text,
  created_at timestamp with time zone default now()
);

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  name text not null,
  address text not null,
  city text not null,
  state text default 'UT',
  postal_code text,
  lat numeric,
  lng numeric,
  geocoded_at timestamp with time zone,

  service_type text not null check (service_type in ('weekly', 'biweekly', 'monthly')),
  est_labor_hours numeric not null,

  contract_start_date date,
  contract_end_date date,

  preferred_day_of_week int check (preferred_day_of_week between 1 and 7),
  preferred_branch_id uuid references branches(id) on delete set null,

  assigned_crew_id uuid references crews(id) on delete set null,
  assigned_day_of_week int check (assigned_day_of_week between 1 and 7),

  notes text,
  is_active boolean default true,
  imported_at timestamp with time zone default now()
);

create index if not exists properties_active_idx on properties(is_active);
create index if not exists properties_geocode_idx on properties(lat, lng) where lat is not null;
create index if not exists properties_external_idx on properties(external_id);

create table if not exists optimization_runs (
  id uuid primary key default gen_random_uuid(),
  name text not null,

  target_week_start_date date not null,
  active_branch_ids uuid[],
  active_crew_ids uuid[],
  active_property_ids uuid[],
  config_snapshot jsonb,

  status text default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  solver_runtime_seconds numeric,
  total_clock_hours_per_week numeric,
  total_labor_hours_per_week numeric,
  total_drive_hours_per_week numeric,
  total_drive_miles_per_week numeric,

  crew_utilization jsonb,

  capacity_recommendation text,
  recommendation_text text,

  routes_jsonb jsonb,

  failure_reason text,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_by text,
  created_at timestamp with time zone default now()
);

create index if not exists optimization_runs_created_idx on optimization_runs(created_at desc);
