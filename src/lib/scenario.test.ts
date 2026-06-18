import { describe, it, expect } from 'vitest';
import { resolveActiveScenarioId } from './scenario';

const scenarios = [
  { id: 'default-1', is_default: true },
  { id: 'bid-2', is_default: false },
];

describe('resolveActiveScenarioId', () => {
  it('returns the cookie id when it matches a scenario', () => {
    expect(resolveActiveScenarioId('bid-2', scenarios)).toBe('bid-2');
  });

  it('falls back to the default when cookie is null', () => {
    expect(resolveActiveScenarioId(null, scenarios)).toBe('default-1');
  });

  it('falls back to the default when cookie id is unknown', () => {
    expect(resolveActiveScenarioId('deleted-9', scenarios)).toBe('default-1');
  });

  it('returns null when there are no scenarios at all', () => {
    expect(resolveActiveScenarioId('anything', [])).toBeNull();
  });

  it('falls back to the first scenario when none is marked default', () => {
    expect(resolveActiveScenarioId(null, [{ id: 'only', is_default: false }])).toBe('only');
  });
});
