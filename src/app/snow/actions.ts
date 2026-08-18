'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';

export type SnowSettingsResult = { ok: true } | { ok: false; error: string };

export interface SnowSettingsInput {
  windowHours: number;
  sidewalkHours: number;
  maxStopsPerCrew: number;
  // tier -> plow hours
  tierPlowHours: Record<string, number>;
}

// Persist the editable snow-bid assumptions for the active scenario: the design window,
// the flat sidewalk time, and per-tier plow hours. Revalidates /snow so the results
// recompute server-side with the new inputs.
export async function updateSnowSettings(input: SnowSettingsInput): Promise<SnowSettingsResult> {
  try {
    const scenarioId = await getActiveScenarioId();
    if (!scenarioId) return { ok: false, error: 'No scenario selected' };

    const windowHours = Number(input.windowHours);
    const sidewalkHours = Number(input.sidewalkHours);
    const maxStops = Number(input.maxStopsPerCrew);
    if (!Number.isFinite(windowHours) || windowHours <= 0) {
      return { ok: false, error: 'Design window must be a positive number of hours' };
    }
    if (!Number.isFinite(sidewalkHours) || sidewalkHours < 0) {
      return { ok: false, error: 'Sidewalk time must be zero or a positive number of hours' };
    }
    if (!Number.isFinite(maxStops) || maxStops < 0) {
      return { ok: false, error: 'Properties per truck must be zero (no cap) or a positive number' };
    }

    const supabase = getServiceClient();

    const { error: scenErr } = await supabase
      .from('scenarios')
      .update({
        snow_window_hours: windowHours,
        snow_sidewalk_hours: sidewalkHours,
        snow_max_stops_per_crew: maxStops,
      })
      .eq('id', scenarioId);
    if (scenErr) return { ok: false, error: scenErr.message };

    const rateRows = Object.entries(input.tierPlowHours)
      .filter(([tier]) => tier.trim() !== '')
      .map(([tier, hours]) => ({
        scenario_id: scenarioId,
        tier,
        plow_hours: Number.isFinite(Number(hours)) && Number(hours) >= 0 ? Number(hours) : 0,
      }));
    if (rateRows.length > 0) {
      const { error: rateErr } = await supabase
        .from('snow_tier_rates')
        .upsert(rateRows, { onConflict: 'scenario_id,tier' });
      if (rateErr) return { ok: false, error: rateErr.message };
    }

    revalidatePath('/snow');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
