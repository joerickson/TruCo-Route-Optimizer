import { describe, it, expect } from 'vitest';
import { planUnassignedFix, FIX_CAP2, FIX_CAP3 } from './unassigned-fix';
import type { FixUnassignedProp, FixBranch, FixCrew } from './unassigned-fix';

const branches: FixBranch[] = [
  { id: 'slc', name: 'SLC', lat: 40.76, lng: -111.89 },
  { id: 'provo', name: 'Provo', lat: 40.23, lng: -111.66 },
];
function prop(id: string, hrs: number, pref: string | null, lat = 40.24, lng = -111.65): FixUnassignedProp {
  return { id, name: id, est_labor_hours: hrs, preferred_branch_id: pref, lat, lng };
}
function crew(id: string, size: number, home: string, clock: number): FixCrew {
  return { id, name: id, crew_size: size, home_branch_id: home, clock_hours: clock };
}

describe('planUnassignedFix', () => {
  it('relocates an idle crew from a no-deficit branch to the short branch', () => {
    const plan = planUnassignedFix(
      [prop('p1', 50, 'provo')],
      branches,
      [crew('slc-1', 2, 'slc', 10), crew('provo-1', 2, 'provo', 50)],
    );
    expect(plan.relocations).toHaveLength(1);
    expect(plan.relocations[0]).toMatchObject({ crew_id: 'slc-1', from_branch_id: 'slc', to_branch_id: 'provo' });
    expect(plan.additions).toHaveLength(0);
    expect(plan.hadIdleCrews).toBe(true);
  });

  it('does NOT take an idle crew whose own branch has a deficit', () => {
    const plan = planUnassignedFix(
      [prop('a', 40, 'slc'), prop('b', 40, 'provo')],
      branches,
      [crew('provo-1', 2, 'provo', 10)],
    );
    expect(plan.relocations).toHaveLength(0);
    expect(plan.hadIdleCrews).toBe(false);
    expect(plan.additions.reduce((s, a) => s + a.count, 0)).toBe(2);
  });

  it('adds a 3-person crew when a big job (> CAP2) is unassigned, else 2-person', () => {
    const plan = planUnassignedFix([prop('big', 120, 'slc')], branches, []);
    expect(plan.hadIdleCrews).toBe(false);
    expect(plan.additions).toEqual([{ branch_id: 'slc', branch_name: 'SLC', size: 3, count: 1 }]);
  });

  it('attributes by nearest branch when no preferred', () => {
    const plan = planUnassignedFix([prop('n', 40, null, 40.76, -111.89)], branches, []);
    expect(plan.additions[0].branch_id).toBe('slc');
  });

  it('returns an empty plan when nothing is unassigned', () => {
    const plan = planUnassignedFix([], branches, [crew('slc-1', 2, 'slc', 10)]);
    expect(plan.relocations).toHaveLength(0);
    expect(plan.additions).toHaveLength(0);
    expect(plan.summary.shortBranches).toBe(0);
  });

  it('relocates first, then adds for the remainder', () => {
    const plan = planUnassignedFix([prop('p', 200, 'provo')], branches, [crew('slc-1', 2, 'slc', 5)]);
    expect(plan.relocations).toHaveLength(1);
    const added = plan.additions.reduce((s, a) => s + a.count, 0);
    expect(added).toBeGreaterThanOrEqual(1);
    const cap = 85 + plan.additions.reduce((s, a) => s + a.count * (a.size === 3 ? FIX_CAP3 : FIX_CAP2), 0);
    expect(cap).toBeGreaterThanOrEqual(200);
  });
});
