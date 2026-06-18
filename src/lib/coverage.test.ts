import { describe, it, expect } from 'vitest';
import { sitesWithinRadius } from './coverage';

const branches = [
  { id: 'slc', name: 'SLC Office', lat: 40.7608, lng: -111.891 },
  { id: 'provo', name: 'Provo Office', lat: 40.2338, lng: -111.6585 },
];

const slcSite = { id: 'a', lat: 40.75, lng: -111.88 }; // ~1 mi from SLC
const provoSite = { id: 'b', lat: 40.24, lng: -111.66 }; // ~0.5 mi from Provo
const remote = { id: 'c', lat: 39.0, lng: -111.0 }; // far from both

describe('sitesWithinRadius', () => {
  it('returns [] when no branch is selected', () => {
    expect(sitesWithinRadius([slcSite], branches, [], 25)).toEqual([]);
  });

  it('returns [] when radius is missing or non-positive', () => {
    expect(sitesWithinRadius([slcSite], branches, ['slc'], null)).toEqual([]);
    expect(sitesWithinRadius([slcSite], branches, ['slc'], 0)).toEqual([]);
  });

  it('includes only sites within radius of a selected branch', () => {
    const out = sitesWithinRadius([slcSite, provoSite, remote], branches, ['slc'], 25);
    // provoSite (~45mi) and remote are excluded when only SLC is selected
    expect(out.map((m) => m.property.id)).toEqual(['a']);
    expect(out[0].nearestBranchName).toBe('SLC Office');
  });

  it('unions across selected branches and picks the nearest branch per site', () => {
    const out = sitesWithinRadius([slcSite, provoSite, remote], branches, ['slc', 'provo'], 25);
    const ids = out.map((m) => m.property.id).sort();
    expect(ids).toEqual(['a', 'b']);
    const provoMatch = out.find((m) => m.property.id === 'b')!;
    expect(provoMatch.nearestBranchId).toBe('provo');
  });

  it('sorts nearest-first', () => {
    const out = sitesWithinRadius([slcSite, provoSite], branches, ['slc', 'provo'], 50);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].distanceMiles).toBeGreaterThanOrEqual(out[i - 1].distanceMiles);
    }
  });
});
