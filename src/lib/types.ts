// Domain types — kept in sync with supabase/migrations.
// We intentionally hand-roll these (instead of supabase-cli generated) to keep the scaffold dependency-light.

export type ServiceType = 'weekly' | 'biweekly' | 'monthly';

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

export type CapacityRecommendation =
  | 'over_provisioned'
  | 'sufficient'
  | 'tight_but_feasible'
  | 'add_crew_recommended'
  | 'add_crew_required';

export interface Branch {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  postal_code: string | null;
  // lat/lng are nullable: a branch can be saved with a bad address and re-geocoded later.
  // The map and optimizer skip branches without coords.
  lat: number | null;
  lng: number | null;
  is_active: boolean;
  created_at: string;
}

export interface Crew {
  id: string;
  name: string;
  crew_size: number;
  home_branch_id: string;
  works_monday: boolean;
  works_tuesday: boolean;
  works_wednesday: boolean;
  works_thursday: boolean;
  works_friday: boolean;
  works_saturday: boolean;
  works_sunday: boolean;
  max_clock_hours_per_day: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export interface Property {
  id: string;
  external_id: string | null;
  name: string;
  address: string;
  city: string;
  state: string;
  postal_code: string | null;
  lat: number | null;
  lng: number | null;
  geocoded_at: string | null;
  service_type: ServiceType;
  est_labor_hours: number;
  contract_start_date: string | null;
  contract_end_date: string | null;
  preferred_day_of_week: number | null;
  preferred_branch_id: string | null;
  assigned_crew_id: string | null;
  assigned_day_of_week: number | null;
  notes: string | null;
  is_active: boolean;
  imported_at: string;
}

export interface CrewUtilization {
  crew_id: string;
  crew_name: string;
  clock_hours: number;
  drive_hours: number;
  work_hours: number;
  util_pct: number;
  props_assigned: number;
  drive_miles: number;
}

export interface RouteStop {
  property_id: string;
  property_name: string;
  address: string;
  lat: number;
  lng: number;
  arrival_time: string; // "HH:MM"
  service_minutes: number;
  drive_minutes_to: number;
  // Set when a large property was split into multiple work-chunks; 1/1 otherwise.
  chunk_index?: number;
  chunk_count?: number;
}

export interface CrewDayRoute {
  crew_id: string;
  crew_name: string;
  day_of_week: number; // 1=Mon..7=Sun
  branch_id: string;
  start_time: string;
  end_time: string;
  clock_hours: number;
  drive_hours: number;
  drive_miles: number;
  stops: RouteStop[];
}

export interface OptimizationRoutes {
  per_day: CrewDayRoute[];
}

export interface OptimizationRun {
  id: string;
  name: string;
  // 'optimized' = a solver optimization; 'baseline' = a scored current (unoptimized)
  // schedule, produced by the solver's evaluate mode. Both share this table.
  run_kind: 'optimized' | 'baseline';
  target_week_start_date: string;
  active_branch_ids: string[] | null;
  active_crew_ids: string[] | null;
  active_property_ids: string[] | null;
  config_snapshot: unknown;
  status: RunStatus;
  solver_runtime_seconds: number | null;
  total_clock_hours_per_week: number | null;
  total_labor_hours_per_week: number | null;
  total_drive_hours_per_week: number | null;
  total_drive_miles_per_week: number | null;
  crew_utilization: CrewUtilization[] | null;
  capacity_recommendation: CapacityRecommendation | null;
  recommendation_text: string | null;
  routes_jsonb: OptimizationRoutes | null;
  unassigned_property_ids: string[] | null;
  failure_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
}

export interface BranchRecommendation {
  branch_id: string;
  branch_name: string;
  two_person: number;
  three_person: number;
  total_people: number;
  demand_hours: number;
  avg_util_pct: number;
  drivers_three_person: string[];
  split_properties: string[];
}

export interface RecommendationResult {
  branches: BranchRecommendation[];
  totals: {
    two_person: number;
    three_person: number;
    total_crews: number;
    total_people: number;
    demand_hours: number;
  };
  unattributable_property_ids: string[];
  residual_unassigned: { count: number; labor_hours: number };
}

export interface CrewRecommendation {
  id: string;
  name: string | null;
  status: RunStatus;
  result_jsonb: RecommendationResult | null;
  iterations: number | null;
  solver_runtime_seconds: number | null;
  failure_reason: string | null;
  created_at: string;
}
