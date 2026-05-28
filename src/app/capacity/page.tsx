import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun, Property, Crew } from '@/lib/types';
import { formatHours } from '@/lib/utils';
import { effectiveLaborHours } from '@/lib/effective-labor';

export const dynamic = 'force-dynamic';

// Demand model:
//   weekly  → labor every week (1.0x weight)
//   biweekly → labor every other week (0.5x weight averaged)
//   monthly → labor once per month (~0.23x weight averaged)
const DEMAND_WEIGHT: Record<string, number> = { weekly: 1, biweekly: 0.5, monthly: 1 / 4.33 };

export default async function CapacityPage() {
  const supabase = getServerClient();
  const [{ data: propsData }, { data: crewsData }, { data: runData }] = await Promise.all([
    supabase.from('properties').select('*').eq('is_active', true),
    supabase.from('crews').select('*').eq('is_active', true),
    supabase
      .from('optimization_runs')
      .select('*')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const properties = (propsData ?? []) as Property[];
  const crews = (crewsData ?? []) as Crew[];
  const latestRun = runData as OptimizationRun | null;

  // Static demand math (no solver required)
  // Use actual-corrected labor where an upload diverges from budget (see effective-labor.ts).
  const totalLaborHrsAvgWk = properties.reduce(
    (sum, p) => sum + effectiveLaborHours(p) * (DEMAND_WEIGHT[p.service_type] ?? 0),
    0
  );
  const peakLaborHrsWk = properties.reduce(
    (sum, p) => sum + effectiveLaborHours(p) * (p.service_type === 'monthly' ? 1 / 4.33 : 1),
    0
  );

  const totalCrewCapacityHrsWk = crews.reduce((sum, c) => {
    const days = [
      c.works_monday,
      c.works_tuesday,
      c.works_wednesday,
      c.works_thursday,
      c.works_friday,
      c.works_saturday,
      c.works_sunday,
    ].filter(Boolean).length;
    return sum + days * Number(c.max_clock_hours_per_day);
  }, 0);

  const avgUtilPct = totalCrewCapacityHrsWk > 0 ? (totalLaborHrsAvgWk / totalCrewCapacityHrsWk) * 100 : 0;
  const peakUtilPct = totalCrewCapacityHrsWk > 0 ? (peakLaborHrsWk / totalCrewCapacityHrsWk) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Capacity</h1>
        <p className="text-sm text-muted-foreground">
          Static demand math (labor only, no drive time). Run an optimization for the authoritative number.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Avg week labor demand" value={formatHours(totalLaborHrsAvgWk)} hint={`${properties.length} properties`} />
        <Stat label="Peak week labor demand" value={formatHours(peakLaborHrsWk)} hint="all weekly + biweekly active" />
        <Stat label="Total crew capacity / wk" value={formatHours(totalCrewCapacityHrsWk)} hint={`${crews.length} crews`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Static utilization estimate</CardTitle>
          <CardDescription>Pre-routing — actual will be higher due to drive time.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-sm text-muted-foreground">Avg week</div>
              <div className="mt-1 text-3xl font-semibold">{avgUtilPct.toFixed(0)}%</div>
              <UtilBar pct={avgUtilPct} />
            </div>
            <div>
              <div className="text-sm text-muted-foreground">Peak week</div>
              <div className="mt-1 text-3xl font-semibold">{peakUtilPct.toFixed(0)}%</div>
              <UtilBar pct={peakUtilPct} />
            </div>
          </div>
        </CardContent>
      </Card>

      {latestRun && (
        <Card>
          <CardHeader>
            <CardTitle>Latest solver run · {latestRun.name}</CardTitle>
            <CardDescription>
              {latestRun.capacity_recommendation && <Badge>{latestRun.capacity_recommendation}</Badge>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {latestRun.recommendation_text && <p className="text-sm">{latestRun.recommendation_text}</p>}

            {latestRun.crew_utilization && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Crew</TableHead>
                    <TableHead className="text-right">Clock hrs/wk</TableHead>
                    <TableHead className="text-right">Util %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latestRun.crew_utilization.map((u) => (
                    <TableRow key={u.crew_id}>
                      <TableCell>{u.crew_name}</TableCell>
                      <TableCell className="text-right">{formatHours(u.clock_hours)}</TableCell>
                      <TableCell className="text-right">{u.util_pct.toFixed(0)}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}

function UtilBar({ pct }: { pct: number }) {
  const clamped = Math.min(120, Math.max(0, pct));
  const color = clamped < 70 ? 'bg-emerald-500' : clamped < 90 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mt-2 h-2 w-full rounded-full bg-muted">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(100, clamped)}%` }} />
    </div>
  );
}
