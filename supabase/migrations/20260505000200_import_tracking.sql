-- Import run tracking — every CSV/XLSX upload produces an import_runs row,
-- with one import_skipped_rows row per row that failed validation.

create table if not exists import_runs (
  id uuid primary key default gen_random_uuid(),
  filename text,
  total_rows int not null default 0,
  inserted_count int not null default 0,
  updated_count int not null default 0,
  skipped_count int not null default 0,
  created_at timestamp with time zone default now()
);

create table if not exists import_skipped_rows (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references import_runs(id) on delete cascade,
  row_number int not null,                  -- 1-indexed in source file; header is row 1
  property_name text,                       -- best-effort, may be null if column was empty
  city text,
  reason text not null,                     -- single specific reason ("Est Hrs is 0; ...")
  raw_data jsonb not null,                  -- entire row dict for re-export
  created_at timestamp with time zone default now()
);

create index if not exists import_skipped_rows_run_idx on import_skipped_rows(import_run_id);
create index if not exists import_runs_created_idx on import_runs(created_at desc);
