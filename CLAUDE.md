# CLAUDE.md

## Purpose

TruCo Route Optimizer — strategic routing analysis for a ~30-crew Utah-based landscape
maintenance portfolio. **Capacity planning + bid analysis tool**, single-purpose, internal
use. **Not** customer-facing. Not a full ops platform.

The two questions it answers:
1. Can the current 30 crews handle the workload at sustainable hours per week?
2. If we add crews, where should the new branch be located?

## Stack

- **Web**: Next.js 14 (App Router), TypeScript, Tailwind, shadcn/ui (hand-rolled primitives in `src/components/ui/`)
- **DB**: Supabase Postgres
- **Solver**: Python serverless function on Vercel at `api/solver.py` → `/api/solver`, OR-Tools VRP. Helpers (`solver_logic.py`, `distance_matrix.py`) live alongside.
- **Maps**: Mapbox GL JS (rendering), Google Maps API (geocoding)
- **Deploy**: Vercel (Pro for the 300s function timeout the solver needs)

## Critical conventions

- **DB access**: server → service-role client (`getServiceClient()`); client/RSC → anon client. Service key never ships to the browser.
- **Python solver**: must live at top-level `/api/*.py` (e.g., `api/solver.py`) so Vercel's auto-detect mounts it. Nested paths like `/api/python/optimize.py` are NOT auto-deployed when `framework: nextjs` is set — Next.js owns `/api/*` and the Python builder needs the file at the documented location. Python version is pinned via `.python-version` (3.12). Don't add `runtime` to `vercel.json`'s functions block — auto-detect handles it.
- **Migrations**: live in `supabase/migrations/`, run via `supabase db push` — **never auto-applied**. When adding a migration, **always include the paste-ready SQL in the response** so the user can run it before the next deploy.
- **Spreadsheets**: parse with `xlsx` (SheetJS). The Aspire export is xlsx; CSV path also exists in `src/lib/csv-import.ts` and shares field-mapping logic.
- **Env vars**: `.env.local` for dev, Vercel dashboard for prod. See `.env.example` for the canonical list.
- **ESLint**: pinned to `^8.57.0`. `eslint-config-next@14` is not compatible with ESLint 9 yet — don't bump.
- **Server actions returning `{ ok, error }`** can't be passed directly to `<form action={...}>` (React types it as void-returning). Wrap in a client component using `useTransition`. See `branches/branch-form.tsx` and `optimize/optimize-form.tsx` for the pattern.
- **Mapbox**: lazy-loaded via `next/dynamic({ ssr: false })` so the bundle only ships when `?view=map`. Don't statically import `mapbox-gl` from a server-rendered code path.

## Domain context

- **Property labor**: `est_labor_hours` is total **person-hours** per visit (not clock-hours).
- **Crew clock-hours** = labor-hours ÷ crew_size. Crews are 2 or 3 people. The solver uses a fleet-average crew size of 2.0 today — crew-size-aware solving is a future iteration.
- **Service types**: weekly (52 visits/yr), biweekly (26/yr), monthly (12/yr). For demand math: weekly = 1.0×, biweekly = 0.5×, monthly = ~0.23× of one weekly visit.
- **Seasonality**: most contracts run **Apr–Nov** (mowing season), some year-round. **Peak summer week is the binding capacity constraint** — that's what the optimizer targets.
- **Sustainable workload bands** (clock-hrs/crew/week): `<40` over-provisioned · `40–50` sustainable · `50–55` tight · `55–60` add 1–2 crews · `>60` unsustainable. Defined in `api/solver.py::_classify_capacity` and mirrored in `src/app/capacity/page.tsx`.
- **Same-day-of-week service**: soft constraint. First run picks the day; subsequent runs honor `assigned_day_of_week` unless utilization is materially better by moving.
- **Travel time**: Haversine × 1.3 road factor at 30 mph. Documented in the UI. Sufficient for capacity planning; not for actual navigation.
- **Bi-weekly properties** are visited every week in the routing model (we optimize a representative week, not multi-week alternation).

## State of the codebase

**Done**: schema + seed (1 SLC branch, 30 crews), Aspire xlsx/csv import with skipped-row tracking and re-import dedup, batch geocoding, OR-Tools VRP per-weekday solver with multi-depot + soft same-day, capacity classifier, capacity dashboard, run-detail page with day tabs + per-crew utilization + CSV export, Mapbox property visualization with clustering and filters.

**Not yet done**:
- Routes map view (per-day route polylines on a Mapbox map for a completed run)
- "Suggest new branch location" sweep job (~50× solver runs — defer to v2)
- Crew-size-aware solving (each crew has its own `crew_size` rather than fleet-average)
- City-centroid fallback for ungeocoded properties on the map (currently excluded with a count badge)

**Out of scope** (don't add without explicit ask): real-time crew tracking, mobile crew app, customer-facing portal, time-window constraints, equipment routing, snow/winter ops, per-property pricing, two-way Aspire integration (currently export-only), weather-day rescheduling.
