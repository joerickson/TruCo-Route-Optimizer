import { describe, it, expect } from 'vitest';
import { filterPropertiesWithinRadius } from './property-radius';

// SLC office anchor
const anchor = { lat: 40.7608, lng: -111.891 };

const slcProp = { id: 'slc', lat: 40.75, lng: -111.88 };      // ~1 mi
const provoProp = { id: 'provo', lat: 40.2338, lng: -111.6585 }; // ~45 mi
const ungeocoded = { id: 'none', lat: null, lng: null };

describe('filterPropertiesWithinRadius', () => {
  it('includes properties inside the radius', () => {
    const out = filterPropertiesWithinRadius([slcProp], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('excludes properties outside the radius', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('excludes ungeocoded properties when filtering', () => {
    const out = filterPropertiesWithinRadius([slcProp, ungeocoded], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('passes all properties through when radius is null/undefined', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp, ungeocoded], anchor, null);
    expect(out.map((p) => p.id)).toEqual(['slc', 'provo', 'none']);
  });

  it('passes all through when anchor has no coords', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp], { lat: null, lng: null }, 25);
    expect(out.map((p) => p.id)).toEqual(['slc', 'provo']);
  });
});
