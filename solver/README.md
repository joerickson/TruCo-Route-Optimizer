# TruCo Route Optimizer — Python solver

OR-Tools VRP solver, deployed as a **separate Vercel project** from the Next.js
web app. Next.js and Python can't coexist in a single Vercel project — Next.js
claims `/api/*` at the routing layer, so the Python function gets shadowed.

This directory is the **Root Directory** of the second Vercel project.

## Layout

```
solver/
├── .python-version       # 3.12
├── requirements.txt      # ortools, supabase
└── api/
    ├── solver.py         # entrypoint — POST /api/solver
    ├── solver_logic.py   # solve_day(), per-day VRP
    └── distance_matrix.py # haversine × 1.3 road factor
```

## Vercel project setup

1. Create a new Vercel project pointing at the same GitHub repo.
2. **Settings → General → Root Directory** = `solver`
3. **Framework Preset**: Other (Vercel will auto-detect Python from `requirements.txt`)
4. **Environment variables** (Production + Preview):
   - `NEXT_PUBLIC_SUPABASE_URL` (or `SUPABASE_URL`) — Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — service-role key (writes to `optimization_runs`)
5. Deploy. Note the production URL; you'll wire it into the Next.js project as
   `PYTHON_SOLVER_URL` (full URL, e.g. `https://truco-solver.vercel.app/api/solver`).

The solver function reads/writes Supabase directly to update the
`optimization_runs` row when the solve completes — the Next.js app polls
`/optimize/[runId]/status` to detect completion.

## Endpoint

- `POST /api/solver` — runs the optimization and persists results
- `GET  /api/solver` — health check

Request body (sent by the Next.js server action):

```jsonc
{
  "run_id": "uuid",
  "crews": [...],
  "branches": [...],
  "properties": [...]
}
```

Response: full result JSON (also written to `optimization_runs` row).

## Local dev

```bash
cd solver
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# Run with vercel dev from the solver/ directory:
vercel dev
```
