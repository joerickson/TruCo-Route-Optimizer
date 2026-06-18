import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getServerClient } from '@/lib/supabase';
import type { CrewRecommendation, RecommendationResult } from '@/lib/types';
import { RecommendRefresher } from './recommend-refresher';
import { RecommendForm } from './recommend-form';
import { RecommendTable } from './recommend-table';
import { getActiveScenarioId } from '@/lib/scenario';

export const dynamic = 'force-dynamic';

function isDeltaShape(r: RecommendationResult | null | undefined): boolean {
  return !!r && !!r.changes && !!r.totals && typeof r.totals.net_capital_usd === 'number';
}

export default async function RecommendPage() {
  const supabase = getServerClient();
  const scenarioId = await getActiveScenarioId();
  const { data } = await supabase
    .from('crew_recommendations')
    .select('*')
    .eq('scenario_id', scenarioId ?? '')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const rec = (data as CrewRecommendation) ?? null;
  const polling = rec?.status === 'running' || rec?.status === 'pending';

  return (
    <div className="space-y-6">
      {polling && <RecommendRefresher />}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Recommend fleet</h1>
        <p className="text-sm text-muted-foreground">
          Suggests crews per branch and the 2-/3-person mix to cover the portfolio sustainably, validated by the
          routing solver. Takes several minutes.
        </p>
      </div>

      <RecommendForm />

      {!rec && (
        <Card><CardHeader><CardDescription>No recommendation yet — run one above.</CardDescription></CardHeader></Card>
      )}

      {rec && polling && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Computing… <Badge variant="warning">{rec.status}</Badge>
            </CardTitle>
            <CardDescription>Seeding a fleet and validating it with the solver across several rounds. This page refreshes automatically.</CardDescription>
          </CardHeader>
        </Card>
      )}

      {rec && rec.status === 'failed' && (
        <Card className="border-destructive/40">
          <CardHeader><CardTitle>Recommendation failed</CardTitle><CardDescription>{rec.failure_reason ?? 'Unknown error'}</CardDescription></CardHeader>
        </Card>
      )}

      {rec && rec.status === 'completed' && rec.result_jsonb && (
        isDeltaShape(rec.result_jsonb) ? (
          <>
            <RecommendTable result={rec.result_jsonb} runId={rec.optimization_run_id} />
            <p className="text-xs text-muted-foreground">
              {rec.iterations ?? 0} solver round(s) · {rec.solver_runtime_seconds ?? 0}s. Analytical seed validated by the
              optimizer; capacity assumes ~50 sustainable clock-hrs/crew/wk. Create these crews and run the optimizer to confirm.
            </p>
          </>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Recommendation from an earlier version</CardTitle>
              <CardDescription>
                This recommendation predates the capital-aware fleet planner. Run a new one above to see the relocate / upsize / buy plan and the what-if schedule.
              </CardDescription>
            </CardHeader>
          </Card>
        )
      )}
    </div>
  );
}
