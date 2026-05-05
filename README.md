# TruCo Route Optimizer

Strategic route optimization for the TruCo Services 567-property landscape maintenance portfolio.

This is **not** a full operations platform — it's a single-purpose tool that answers two questions:

1. Can our 30 crews handle the workload at sustainable hours per week?
2. If we add crews, where should the new branch be located?

## Stack

- Next.js 14 (App Router) + TypeScript
- Tailwind + minimal shadcn/ui primitives
- Supabase Postgres
- OR-Tools VRP solver (Python serverless function)
- Mapbox for maps, Google Geocoding for address → lat/lng
- Deployed on Vercel (Pro recommended for the 300s function timeout)

## Setup

```bash
# 1. Install JS deps
npm install

# 2. Create Supabase project & run migrations
#    (point psql or the supabase dashboard SQL editor at supabase/migrations/*.sql)

# 3. Copy env file and fill in keys
cp .env.example .env.local

# 4. Run dev server (Vercel CLI handles the Python function)
vercel dev
# or, JS-only (no solver):
npm run dev
```

### Env vars

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase project
- `SUPABASE_SERVICE_ROLE_KEY` — service-role key for trusted server actions
- `GOOGLE_MAPS_API_KEY` — geocoding
- `NEXT_PUBLIC_MAPBOX_TOKEN` — public Mapbox token for map views
- `PYTHON_SOLVER_URL` *(optional)* — override solver URL (defaults to `/api/python/optimize`)

## Workflow

1. **Branches**: add at least one branch (Salt Lake City HQ is seeded by default).
2. **Crews**: 30-crew default roster is seeded (27 × 2-person, 3 × 3-person).
3. **Properties**: upload Aspire CSV via the Properties page → click "Geocode pending".
4. **Optimize**: pick a peak summer week → run optimizer (1-5 min).
5. **Capacity**: review the recommendation and per-crew utilization.

## Modeling assumptions

- Travel time = Haversine distance × 1.3 road factor at 30 mph average. Documented in the UI.
- Bi-weekly properties are visited every week in the routing model (we optimize a representative
  week, not multi-week alternation). For capacity math, biweekly = 0.5x and monthly = ~0.23x.
- Soft same-day preference: the solver picks the day on the first run; subsequent runs honor
  `assigned_day_of_week` unless utilization is materially better by moving.
- Crew clock-hours = property labor-hours ÷ crew size (2.0 default for the solver). The solver
  is fleet-average — crew-size-aware solving is a future iteration.

## Capacity bands (clock-hours per crew per week)

- < 40 — over-provisioned
- 40-50 — sustainable
- 50-55 — tight but feasible
- 55-60 — add 1-2 crews recommended
- \> 60 — unsustainable, add 2+ crews

## Deployment

```bash
vercel link           # link to project
vercel env pull       # pull env vars locally
vercel deploy --prod  # ship
```

Vercel Pro is recommended so the Python solver can run up to 300s. Hobby's 60s timeout will
truncate runs for the full 567-property × 30-crew problem.
