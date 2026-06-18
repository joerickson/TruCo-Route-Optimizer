import { Suspense } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { compareSchedules } from '@/lib/schedule-compare';
import { CompareSelectors } from './compare-selectors';
import { UploadScheduleButton } from './upload-schedule';
import { FleetSummary } from './fleet-summary';
import { CrewDeltas } from './crew-deltas';
import { PropertyChanges } from './property-changes';
import { getActiveScenarioId } from '@/lib/scenario';

export const dynamic = 'force-dynamic';

function nextMonday(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

export default async function ComparePage({ searchParams }: { searchParams: { baseline?: string; optimized?: string } }) {
  const scenarioId = await getActiveScenarioId();
  const supabase = getServerClient();

  const [{ data: baselineRows }, { data: optimizedRows }] = await Promise.all([
    supabase.from('optimization_runs').select('id, name, created_at, status').eq('scenario_id', scenarioId ?? '').eq('run_kind', 'baseline').eq('status', 'completed').order('created_at', { ascending: false }).limit(20),
    supabase.from('optimization_runs').select('id, name, created_at, status').eq('scenario_id', scenarioId ?? '').eq('run_kind', 'optimized').eq('status', 'completed').order('created_at', { ascending: false }).limit(20),
  ]);
  const baselines = (baselineRows ?? []) as Array<{ id: string; name: string; created_at: string }>;
  const optimized = (optimizedRows ?? []) as Array<{ id: string; name: string; created_at: string }>;

  const baselineId = searchParams.baseline ?? baselines[0]?.id ?? null;
  const optimizedId = searchParams.optimized ?? optimized[0]?.id ?? null;

  let baselineRun: OptimizationRun | null = null;
  let optimizedRun: OptimizationRun | null = null;
  if (baselineId && optimizedId) {
    const [{ data: b }, { data: o }] = await Promise.all([
      supabase.from('optimization_runs').select('*').eq('scenario_id', scenarioId ?? '').eq('id', baselineId).maybeSingle(),
      supabase.from('optimization_runs').select('*').eq('scenario_id', scenarioId ?? '').eq('id', optimizedId).maybeSingle(),
    ]);
    baselineRun = (b as OptimizationRun) ?? null;
    optimizedRun = (o as OptimizationRun) ?? null;
  }

  const comparison = baselineRun && optimizedRun ? compareSchedules(baselineRun, optimizedRun) : null;
  const weekMismatch =
    baselineRun && optimizedRun && baselineRun.target_week_start_date !== optimizedRun.target_week_start_date;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Current vs optimized</h1>
          <p className="text-sm text-muted-foreground">
            Score your real-world schedule on the same yardstick as the optimizer and see what to change.
          </p>
        </div>
        <UploadScheduleButton defaultWeek={nextMonday()} />
      </div>

      {baselines.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No baseline yet</CardTitle>
            <CardDescription>
              Use “Upload schedule” above to score your current schedule, then compare it against an
              optimized run here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Suspense fallback={null}>
            <CompareSelectors baselines={baselines} optimized={optimized} baselineId={baselineId} optimizedId={optimizedId} />
          </Suspense>

          {weekMismatch && (
            <Card className="border-amber-300">
              <CardContent className="pt-4 text-sm text-amber-800">
                These runs target different weeks ({baselineRun!.target_week_start_date} vs {optimizedRun!.target_week_start_date}).
                Deltas are approximate.
              </CardContent>
            </Card>
          )}

          {comparison ? (
            <>
              <FleetSummary comparison={comparison} />
              <CrewDeltas crews={comparison.crews} />
              <PropertyChanges changes={comparison.changes} coverage={comparison.coverage} baselineId={baselineId!} optimizedId={optimizedId!} />
            </>
          ) : (
            <Card>
              <CardHeader>
                <CardDescription>Pick a baseline and an optimized run to compare.</CardDescription>
              </CardHeader>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
