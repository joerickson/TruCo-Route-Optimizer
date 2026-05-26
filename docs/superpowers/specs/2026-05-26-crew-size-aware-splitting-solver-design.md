# Crew-Size-Aware + Splittable-Workload Solver — Design Spec

**Date:** 2026-05-26
**Status:** Draft (awaiting user review)
**Scope:** Rework the OR-Tools solver so (1) a property's clock-hours depend on the
**actual crew size** that does it (`labor ÷ crew_size`, not a fleet-average 2.0),
and (2) a property's labor can be **split across multiple crews and multiple days**
("work-chunks"), so large properties (e.g. a 250-person-hour budget) are covered
instead of silently dropped.

This replaces the documented "crew-size-aware solving" future item and the
implicit "one stop per property" assumption.

## 1. Problem & goal

Today `solver_logic.py` models each property as **one indivisible stop**, visited
once by one crew on one day, with a fixed service time of `est_labor_hours ÷ 2.0`
(`index.py::_properties_for_solver`). Two consequences:

- **Crew size is ignored.** A 3-person crew and a 2-person crew are modeled
  identically, so big jobs aren't preferentially given to bigger crews.
- **Big properties are dropped.** A single visit whose `labor ÷ 2` exceeds a
  crew-day cap can't fit any route, so OR-Tools drops it to `unassigned`
  (observed: "Canyon Park", 132.6 person-hours → 66 clock-h vs a 10 h day).

**Goal:** the solver should (a) compute each job's time from the assigned crew's
size, routing bigger jobs to bigger crews, and (b) split a property's labor across
as many crew-days as needed so the full budget is scheduled. A 250 h budget ÷ a
30-person-hour 3-person day ≈ 8–9 crew-days, which **must** spread across parallel
crews to fit one week.

**Required behaviors (first-class, not incidental):**
- **Multiple crews on one property**, including a **3-person and a 2-person crew on
  the same property on the same day** (parallel, mixed sizes), when the property is
  big enough to warrant it.
- **Spanning multiple days** for one property as needed.
- **Crew-size-aware matching**: the optimizer knows each crew's size and fits crews
  to remaining capacity so crew-days are packed efficiently (minimal wasted hours).
- **No "one crew-day per property" cap** — the current single-stop assumption is
  explicitly removed; it is neither sustainable nor correct for large properties.

### Out of scope
- Dynamic staffing (solver choosing how many people per job). Crews have **fixed**
  `crew_size` (confirmed); the solver routes to existing 2- and 3-person crews.
- Real multi-week alternation (still optimize one representative peak week).
- A hard "property over X hours *must* use a 3-person crew" rule — preference is
  **emergent** from capacity (a job too big for a 2-person day can't be assigned to
  one). Revisit only if emergent behavior proves insufficient.
- Fixing Canyon Park's data: 132.6 h is ~4× a 3-person day and is almost certainly a
  bad `Est Hrs`; this design routes everything up to `crew_size × max_day` per chunk,
  and splits the rest — it does not validate source data.

## 2. Current state (what changes)

- `index.py::_properties_for_solver(props, crew_size_default=2)` — precomputes
  `est_clock_hours = labor ÷ 2`, drops ungeocoded, emits one solver-prop per
  property. **Changes:** stop pre-dividing; emit **chunks** carrying `labor_hours`.
- `index.py::_bucketize_properties` — distributes **properties** across weekdays
  (sticky by `assigned_day_of_week`, else load-balanced). **Changes:** operates on
  **chunks**; multi-chunk properties are never sticky (they must span days).
- `solver_logic.py::solve_day` — one node-fixed service time, one transit callback
  for all vehicles, `AddDimensionWithVehicleCapacity`. **Changes:** per-crew service
  time, per-vehicle transit callbacks, per-vehicle daily cap.
- `solver_logic.py::_extract_routes` — service time from `est_clock_hours`.
  **Changes:** service from `labor_hours ÷ crew_size`; emit chunk stops.
- `index.py::_aggregate_result` — `props_assigned = len(stops)`; `unassigned` =
  per-node. **Changes:** count **distinct property_ids**; a property is unassigned if
  **any** of its chunks is unassigned (partial coverage is incomplete).
- `run_evaluation` (baseline/evaluate mode) shares `solve_day`, so it inherits both
  changes for free.

## 3. Work-chunks model

### 3.1 Chunking (`index.py`)

The chunking rule has two thresholds so we **don't fragment properties a single
crew can handle**, but **do** split the genuinely-too-big ones into packable pieces:

```python
def chunk_labor(labor_hours: float, single_day_max: float, shift: float) -> list[float]:
    """Person-hour chunks for one property.
      - labor <= single_day_max  -> [labor]  (one stop; some single crew can do it
        in a day — keep it whole; crew-size-aware routing sends it to a crew that
        fits, e.g. a 28 person-hr job goes to a 3-person crew, not a 2-person one).
      - otherwise -> split into chunks of `shift` person-hours (+ a remainder), so
        multiple crews across multiple days cover it and crew-days pack tightly."""
```

- **`single_day_max`** = `max_crew_size * max_clock_hours_per_day` — the most any
  single crew can do in one day (e.g. 3 × 10 = 30 person-hrs). At/under this, the
  property stays **one stop**: normal properties are unchanged, and a moderately
  large one (say 25 person-hrs) simply must go to a crew big enough to fit it in a
  day — the crew-size-aware service time makes a 2-person crew infeasible for it and
  a 3-person crew feasible. **No artificial splitting of single-day-doable work.**
- **`shift`** = one person-day = `max_clock_hours_per_day` person-hours (e.g. 10).
  Splitting uses this unit so a size-`s` crew completes ~`s` chunks per day and
  packs to (near) a full day — that's the "fit crews in optimally" requirement.
  Mixed crews compose naturally: on one day a 3-person crew can take 3 chunks and a
  2-person crew 2 chunks **of the same property**, in parallel. A 250 person-hr
  budget → 25 chunks the solver spreads across crews and days.
- (`max_clock_hours_per_day` / `max_crew_size` are taken across the **active**
  crews; when they vary, use the fleet max for `single_day_max` and a conservative
  value for `shift`. These are tunable constants, settled during implementation
  with the post-deploy behavior check.)
- Each chunk becomes a solver node: `chunk_id = f"{property_id}#{k}"`, `property_id`
  (parent), `name = "<Property> (k/n)"` (or `<Property>` when `n == 1`), the
  property's `lat/lng`, `labor_hours` (its share), `preferred_day_of_week`, and —
  **only when `n == 1`** — `assigned_day_of_week`/`assigned_crew_id` (split
  properties get `None`; see §3.3).
- Chunks of one property share coordinates, so inter-chunk travel is 0 (the distance
  matrix already yields 0 for identical points — no special-casing). This is what
  lets two crews work the same property the same day at zero travel penalty.

### 3.2 Crew-size-aware service time (`solve_day`)

Service time becomes vehicle-dependent. For a chunk node with `labor_hours = h`
served by a crew of size `s`: `service_seconds = round(h / s * 3600)`.

OR-Tools wiring (verify exact API against the installed `ortools` during build):
- Build a service-seconds vector **per distinct crew size** present among the day's
  crews (sizes are small: {2, 3}).
- Register **one transit callback per crew size**: `transit_s(from, to) =
  service_s[from] + distance[from][to]`.
- Map each vehicle to the callback for its size; pass that per-vehicle list to
  `routing.AddDimensionWithVehicleTransits(transit_idx_by_vehicle, 0, BIG_CAP,
  True, "Time")`.
- Enforce each crew's daily cap on the **end cumul**:
  `time_dim.CumulVar(routing.End(v)).SetMax(round(max_clock_hours_v * 3600))`
  (`AddDimensionWithVehicleTransits` takes a single scalar capacity, so per-vehicle
  caps are applied via `SetMax`; `BIG_CAP` is a safe upper bound).
- Arc cost per vehicle: `routing.SetArcCostEvaluatorOfVehicle(transit_idx_s, v)`.
- Keep the per-node drop disjunction (`drop_penalty` large) so a chunk is dropped
  only if a day genuinely can't fit it.

**Fallback if `AddDimensionWithVehicleTransits` is unavailable in the pinned
ortools:** register per-vehicle callbacks and use the lower-level
`AddDimension`-with-vehicle-transit equivalent, or model service as a separate
per-vehicle unary dimension summed into Time. The implementer confirms the exact
supported call before wiring (this is the one real OR-Tools risk).

### 3.3 Days & splitting (`_bucketize_properties`)

- **Single-chunk properties** keep today's behavior: sticky to
  `assigned_day_of_week` when set/working, else load-balanced into a day.
- **Multi-chunk (split) properties** relax the same-day preference (the chosen
  decision): their chunks enter the free pool and are load-balanced **across
  different days**, so a big property naturally spans the week. Because chunks are
  independent nodes, the per-day VRPs then place them on whichever crews fit —
  yielding parallel crews on the same property when a week demands it.
- Two chunks of one property may land on the same crew-day (consecutive work, 0
  travel) when capacity allows; that's realistic (a crew spending the day there).

### 3.4 Extraction & aggregation

- `_extract_routes` computes each stop's `service_minutes = h / s * 60` and the
  route's `clock_hours` from the vehicle's size-adjusted service + drive. Stops are
  chunk stops: `property_id` = **parent** id (so downstream keyed-by-property logic
  keeps working), `property_name` = the `"(k/n)"` label, plus new optional
  `chunk_index`/`chunk_count` on `RouteStop`.
- `_aggregate_result`:
  - `props_assigned` counts **distinct `property_id`s** per crew (not chunk count).
  - `unassigned_property_ids` = properties with **≥1 unassigned chunk** (partial
    coverage = not complete). Add `coverage_jsonb` (optional) mapping
    `property_id -> {covered_hours, total_hours}` so the UI can show "Canyon Park:
    90 of 132 h scheduled" when a big job is only partly placed.
  - Totals (`total_clock/drive/miles`, `total_labor`) unchanged in definition;
    clock/util now reflect real crew sizes.

## 4. Web ripple (run views read `routes_jsonb`)

`RouteStop.property_name` now carries `"(k/n)"` for split properties and stops
repeat a `property_id`. Required follow-through:
- **List view** (`runs/[runId]` day-by-day + per-crew table): renders chunk stops
  as-is; the `(k/n)` label makes splits legible. Per-crew clock-hours are now real.
- **Map** (`routes-map`): chunk stops at identical coords stack; acceptable. Group
  popups by `property_id` if trivial; otherwise leave.
- **Calendar**: unaffected (works off routes + utilization).
- **Compare** (`schedule-compare.placement()`): keyed by `property_id`,
  first-chunk-wins — a split property maps to one placement; acceptable, note it.
- **`OptimizationRoutes`/`RouteStop` types** (`src/lib/types.ts`): add optional
  `chunk_index?`, `chunk_count?` to `RouteStop`.

Reporting polish (grouping all chunks of a property into one "N visits this week"
line) is a **follow-up**, not required for correctness; the `(k/n)` labels are
enough to ship.

## 5. Files

- `solver/api/index.py` — `chunk_labor`, chunk emission in `_properties_for_solver`
  (renamed concept; keep function name), chunk-aware `_bucketize_properties`,
  distinct-property counting + chunk-aware `unassigned`/coverage in
  `_aggregate_result`. Pass `crew_size` through (already present on crew dicts).
- `solver/api/solver_logic.py` — per-crew service vectors, per-size transit
  callbacks, `AddDimensionWithVehicleTransits` + per-vehicle `SetMax`, size-aware
  `_extract_routes`.
- `solver/api/check_chunking.py` — standalone (no OR-Tools) check for `chunk_labor`
  and the cap computation, in the style of `check_grouping.py`.
- `src/lib/types.ts` — optional `chunk_index`/`chunk_count` on `RouteStop`;
  optional `coverage_jsonb` on `OptimizationRun`.
- No DB/schema change. No new migration.

## 6. Testing

- **Pure Python checks** (no OR-Tools, runnable locally): `chunk_labor` —
  `labor <= single_day_max` → `[labor]` (one chunk, no fragmentation); `labor`
  just over `single_day_max` → `shift`-sized chunks + remainder; a 250-hr budget at
  `shift=10` → 25 chunks; sums always equal input; remainder never zero-padded.
  Distinct-property counting and "unassigned if any chunk unassigned" logic factored
  into pure helpers and checked.
- **Solver behavior** (needs OR-Tools; manual / post-deploy because ortools isn't
  installed in this workspace): a 50 person-hour property with a 2-person and a
  3-person crew (10 h days) → the 3-person crew takes more of it; the property is
  fully covered across ≥2 chunks/days; a property ≤ cap stays a single stop and
  matches prior routing; an oversized-beyond-all-capacity case still reports
  `unassigned` with partial `coverage`.
- **Web**: list/map render of `(k/n)` stops verified manually; typecheck/lint/build.

## 7. Risks / notes

- **OR-Tools API is the main risk.** Per-vehicle transit + per-vehicle cap must be
  wired with the pinned `ortools` version; the implementer verifies the exact call
  (`AddDimensionWithVehicleTransits` + end-cumul `SetMax`) before building, with the
  §3.2 fallback if needed. Cannot be unit-tested here (no local OR-Tools) — gated on
  the manual post-deploy check.
- **Chunk explosion** is bounded: only properties above `single_day_max` (the most
  a single crew can do in a day, ~30 person-hrs) split; everything a single crew-day
  can cover stays one stop. A few big properties add a handful of coincident nodes —
  negligible for capacity planning at ~570 nodes. (A pathological data value like
  Canyon Park's 132.6 h adds ~13 chunks; still fine.)
- **Time budget**: per-day solve stays at 8 s; more nodes are modest. Watch the
  total against the 60 s edge-proxy limit; chunking only adds nodes for big props.
- **Partial coverage is now possible and surfaced** (`coverage_jsonb` +
  any-chunk-unassigned). This is strictly better than today's silent full drop and
  feeds the (parked) unassigned-surfacing work.
- **Behavior change for existing runs**: re-running will shift clock-hours/util
  (now crew-size-real) and may move assignments. Expected and desired.
