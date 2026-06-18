'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { parseScheduleFile, parseDayOfWeek, resolveCrewId } from '@/lib/schedule-import';
import type { Branch, Crew, Property } from '@/lib/types';
import { withEffectiveLabor } from '@/lib/effective-labor';
import { getActiveScenarioId } from '@/lib/scenario';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export interface ScheduleScoreResult {
  ok: true;
  run_id: string;
  applied: number;
  skipped: number;
}
export type ScheduleActionResult = ScheduleScoreResult | { ok: false; error: string };

export async function uploadAndScoreSchedule(formData: FormData): Promise<ScheduleActionResult> {
  try {
    const file = formData.get('file');
    const name = String(formData.get('name') ?? '').trim() || `Current schedule ${new Date().toISOString().slice(0, 16)}`;
    const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'No file uploaded' };
    if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };

    const buffer = await file.arrayBuffer();
    const { rows, skipped } = parseScheduleFile(file.name, buffer);
    if (rows.length === 0) return { ok: false, error: 'No usable schedule rows found in file' };

    const supabase = getServiceClient();
    const scenarioId = await getActiveScenarioId();
    if (!scenarioId) return { ok: false, error: 'No scenario selected' };

    // Build crew-name -> id map (case/space-insensitive).
    const { data: crewRows } = await supabase.from('crews').select('id, name').eq('scenario_id', scenarioId ?? '').eq('is_active', true);
    const crewsByName = new Map<string, string>();
    for (const c of (crewRows ?? []) as Array<{ id: string; name: string }>) {
      crewsByName.set(c.name.trim().toLowerCase(), c.id);
    }

    // Resolve each row to (crew_id, day). Bucket external_ids by (crew_id, day)
    // so we issue ONE update per distinct assignment (≈ crews × days, ~150 max)
    // instead of one per row — the per-row loop is what timed out a 564-row
    // re-import historically (see properties/actions.ts).
    let unresolved = skipped.length;
    const buckets = new Map<string, { crewId: string; day: number; externalIds: string[] }>();
    for (const r of rows) {
      const crewId = resolveCrewId(r.assigned_crew_name, crewsByName);
      const day = parseDayOfWeek(r.assigned_day_raw);
      if (!crewId || !day) {
        unresolved += 1;
        continue;
      }
      const key = `${crewId}::${day}`;
      const bucket = buckets.get(key) ?? { crewId, day, externalIds: [] };
      bucket.externalIds.push(r.external_id);
      buckets.set(key, bucket);
    }

    // NB: each bucket UPDATE auto-commits independently. If a later bucket throws,
    // earlier assignments persist but no run row is created yet — acceptable for an
    // internal re-import (re-running the upload is idempotent per (crew, day)).
    let applied = 0;
    let unmatched = 0;
    for (const { crewId, day, externalIds } of buckets.values()) {
      const { data: updated, error } = await supabase
        .from('properties')
        .update({ assigned_crew_id: crewId, assigned_day_of_week: day })
        .eq('scenario_id', scenarioId)
        .in('external_id', externalIds)
        .select('id');
      if (error) throw new Error(error.message);
      const matched = (updated ?? []).length;
      applied += matched;
      unmatched += externalIds.length - matched; // resolved rows whose External ID matched no property
    }

    if (applied === 0) {
      return { ok: false, error: 'No schedule rows matched an existing property (check External IDs and crew names)' };
    }

    // Gather the same inputs the optimizer uses.
    const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
      supabase.from('crews').select('*').eq('scenario_id', scenarioId ?? '').eq('is_active', true),
      supabase.from('branches').select('*').eq('scenario_id', scenarioId ?? '').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
      supabase.from('properties').select('*').eq('scenario_id', scenarioId ?? '').eq('is_active', true).not('lat', 'is', null).not('lng', 'is', null),
    ]);
    const crews = (crewsData ?? []) as Crew[];
    const branches = (branchesData ?? []) as Branch[];
    const properties = (propsData ?? []) as Property[];

    const { data: run, error: runErr } = await supabase
      .from('optimization_runs')
      .insert({
        name,
        scenario_id: scenarioId,
        run_kind: 'baseline',
        target_week_start_date: targetWeek,
        active_branch_ids: branches.map((b) => b.id),
        active_crew_ids: crews.map((c) => c.id),
        active_property_ids: properties.map((p) => p.id),
        config_snapshot: { kind: 'baseline', applied, unresolved, unmatched },
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (runErr || !run) return { ok: false, error: runErr?.message ?? 'Could not create baseline run' };

    // Fire-and-forget solver call in evaluate mode (same pattern as optimize).
    void invokeEvaluate(run.id, { crews, branches, properties }).catch(async (e) => {
      await supabase
        .from('optimization_runs')
        .update({ status: 'failed', failure_reason: e instanceof Error ? e.message : String(e), completed_at: new Date().toISOString() })
        .eq('id', run.id);
    });

    revalidatePath('/compare');
    return { ok: true, run_id: run.id, applied, skipped: unresolved + unmatched };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function invokeEvaluate(runId: string, payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }) {
  if (!PYTHON_SOLVER_URL) {
    throw new Error(
      'PYTHON_SOLVER_URL is not configured. Set it on this project to the deployed Python solver URL (e.g. https://truco-solver.vercel.app/api/solver).'
    );
  }
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, ...payload, properties: withEffectiveLabor(payload.properties), mode: 'evaluate' }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
