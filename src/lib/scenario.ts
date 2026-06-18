import { cookies } from 'next/headers';
import { getServiceClient } from './supabase';

export const ACTIVE_SCENARIO_COOKIE = 'active_scenario_id';

type ScenarioRef = { id: string; is_default: boolean };

/** Pure resolver: choose the active scenario id from a cookie value and the
 *  known scenario list. Prefers an exact cookie match, then the default, then
 *  the first scenario, then null if there are none. */
export function resolveActiveScenarioId(
  cookieValue: string | null,
  scenarios: ScenarioRef[]
): string | null {
  if (scenarios.length === 0) return null;
  if (cookieValue && scenarios.some((s) => s.id === cookieValue)) return cookieValue;
  const dflt = scenarios.find((s) => s.is_default);
  return (dflt ?? scenarios[0]).id;
}

/** Server-side: read the cookie and resolve against the live scenario list. */
export async function getActiveScenarioId(): Promise<string | null> {
  const supabase = getServiceClient();
  const { data } = await supabase.from('scenarios').select('id, is_default');
  const cookieValue = cookies().get(ACTIVE_SCENARIO_COOKIE)?.value ?? null;
  return resolveActiveScenarioId(cookieValue, (data ?? []) as ScenarioRef[]);
}
