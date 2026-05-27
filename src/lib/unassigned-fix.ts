// Pure planner: turn a completed run's unassigned properties into a concrete fix
// (relocate idle crews to short branches, then add crews for the remainder). No IO.
import { haversineMiles } from './distance';

// Sustainable weekly capacities (mirror the crew-mix recommender) + idle threshold.
export const FIX_CAP2 = 85; // 2-person person-hours/wk
export const FIX_CAP3 = 127.5; // 3-person
export const FIX_UNDERUTILIZED_CLOCK = 40; // a crew under this weekly clock is idle

export interface FixUnassignedProp {
  id: string;
  name: string;
  est_labor_hours: number;
  preferred_branch_id: string | null;
  lat: number | null;
  lng: number | null;
}
export interface FixBranch {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
export interface FixCrew {
  id: string;
  name: string;
  crew_size: number;
  home_branch_id: string;
  clock_hours: number;
}

export interface Relocation {
  crew_id: string;
  crew_name: string;
  crew_size: number;
  from_branch_id: string;
  from_branch_name: string;
  to_branch_id: string;
  to_branch_name: string;
}
export interface Addition {
  branch_id: string;
  branch_name: string;
  size: 2 | 3;
  count: number;
}
export interface FixPlan {
  relocations: Relocation[];
  additions: Addition[];
  hadIdleCrews: boolean;
  unresolvedPropertyIds: string[];
  summary: { relocatedCrews: number; addedCrews: number; shortBranches: number };
}

function attributeBranch(
  p: FixUnassignedProp,
  branchById: Record<string, FixBranch>,
  branches: FixBranch[]
): string | null {
  if (p.preferred_branch_id && branchById[p.preferred_branch_id]) return p.preferred_branch_id;
  if (p.lat == null || p.lng == null || branches.length === 0) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const b of branches) {
    const d = haversineMiles({ lat: p.lat, lng: p.lng }, { lat: b.lat, lng: b.lng });
    if (d < bestD) {
      bestD = d;
      best = b.id;
    }
  }
  return best;
}

export function planUnassignedFix(
  unassigned: FixUnassignedProp[],
  branches: FixBranch[],
  crews: FixCrew[]
): FixPlan {
  const branchById: Record<string, FixBranch> = Object.fromEntries(branches.map((b) => [b.id, b]));

  const deficit: Record<string, number> = {};
  const bigJobs: Record<string, number> = {};
  const unresolvedPropertyIds: string[] = [];
  for (const p of unassigned) {
    const bid = attributeBranch(p, branchById, branches);
    if (!bid) {
      unresolvedPropertyIds.push(p.id);
      continue;
    }
    deficit[bid] = (deficit[bid] ?? 0) + p.est_labor_hours;
    if (p.est_labor_hours > FIX_CAP2) bigJobs[bid] = (bigJobs[bid] ?? 0) + 1;
  }
  const shortBranches = Object.keys(deficit).filter((b) => deficit[b] > 1e-9);

  const idle = crews
    .filter((c) => c.clock_hours < FIX_UNDERUTILIZED_CLOCK && !(deficit[c.home_branch_id] > 1e-9))
    .sort((a, b) => b.crew_size - a.crew_size || a.name.localeCompare(b.name));
  const hadIdleCrews = idle.length > 0;

  const remaining: Record<string, number> = { ...deficit };
  const relocations: Relocation[] = [];
  let idleIdx = 0;

  for (const bid of [...shortBranches].sort((a, b) => remaining[b] - remaining[a])) {
    while (remaining[bid] > 1e-9 && idleIdx < idle.length) {
      const c = idle[idleIdx++];
      relocations.push({
        crew_id: c.id,
        crew_name: c.name,
        crew_size: c.crew_size,
        from_branch_id: c.home_branch_id,
        from_branch_name: branchById[c.home_branch_id]?.name ?? c.home_branch_id,
        to_branch_id: bid,
        to_branch_name: branchById[bid].name,
      });
      remaining[bid] -= c.crew_size === 3 ? FIX_CAP3 : FIX_CAP2;
    }
  }

  const additions: Addition[] = [];
  for (const bid of shortBranches) {
    let bigLeft = bigJobs[bid] ?? 0;
    let two = 0;
    let three = 0;
    while (remaining[bid] > 1e-9) {
      if (bigLeft > 0) {
        three += 1;
        bigLeft -= 1;
        remaining[bid] -= FIX_CAP3;
      } else {
        two += 1;
        remaining[bid] -= FIX_CAP2;
      }
    }
    if (three > 0) additions.push({ branch_id: bid, branch_name: branchById[bid].name, size: 3, count: three });
    if (two > 0) additions.push({ branch_id: bid, branch_name: branchById[bid].name, size: 2, count: two });
  }

  return {
    relocations,
    additions,
    hadIdleCrews,
    unresolvedPropertyIds,
    summary: {
      relocatedCrews: relocations.length,
      addedCrews: additions.reduce((s, a) => s + a.count, 0),
      shortBranches: shortBranches.length,
    },
  };
}
