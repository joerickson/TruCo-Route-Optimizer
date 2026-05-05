import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { dayName, formatHours, formatMiles } from '@/lib/utils';
import { RunRefresher } from './refresher';
import { ExportCsvButton } from './export-csv';

export const dynamic = 'force-dynamic';

export default async function RunPage({ params }: { params: { runId: string } }) {
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('optimization_runs')
    .select('*')
    .eq('id', params.runId)
    .maybeSingle();

  if (error || !data) notFound();
  const run = data as OptimizationRun;

  const isPolling = run.status === 'pending' || run.status === 'running';

  return (
    <div className="space-y-6">
      {isPolling && <RunRefresher />}

      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{run.name}</h1>
          <p className="text-sm text-muted-foreground">
            Target week: {run.target_week_start_date} · created {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      {run.status === 'failed' && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Run failed</CardTitle>
            <CardDescription>{run.failure_reason ?? 'Unknown error'}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {(run.status === 'pending' || run.status === 'running') && (
        <Card>
          <CardHeader>
            <CardTitle>Solver running…</CardTitle>
            <CardDescription>
              VRP solves can take 1-5 minutes. This page will refresh automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {run.status === 'completed' && <CompletedRun run={run} />}
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <Badge variant="success">completed</Badge>;
    case 'running':
      return <Badge variant="warning">running</Badge>;
    case 'failed':
      return <Badge variant="destructive">failed</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function CompletedRun({ run }: { run: OptimizationRun }) {
  const utilization = run.crew_utilization ?? [];
  const routes = run.routes_jsonb?.per_day ?? [];
  const days = Array.from(new Set(routes.map((r) => r.day_of_week))).sort((a, b) => a - b);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-4">
        <SummaryStat label="Total clock hrs/wk" value={formatHours(run.total_clock_hours_per_week)} />
        <SummaryStat label="Drive hrs/wk" value={formatHours(run.total_drive_hours_per_week)} />
        <SummaryStat label="Drive mi/wk" value={formatMiles(run.total_drive_miles_per_week)} />
        <SummaryStat
          label="Solver runtime"
          value={run.solver_runtime_seconds != null ? `${run.solver_runtime_seconds.toFixed(0)} s` : '—'}
        />
      </div>

      {run.recommendation_text && (
        <Card>
          <CardHeader>
            <CardTitle>Capacity analysis</CardTitle>
            <CardDescription>{run.capacity_recommendation ?? '—'}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{run.recommendation_text}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Day-by-day routes</CardTitle>
            <CardDescription>{routes.length} crew-days planned</CardDescription>
          </div>
          <ExportCsvButton runId={run.id} />
        </CardHeader>
        <CardContent>
          {days.length === 0 ? (
            <p className="text-sm text-muted-foreground">No routes generated.</p>
          ) : (
            <Tabs defaultValue={String(days[0])}>
              <TabsList>
                {days.map((d) => (
                  <TabsTrigger key={d} value={String(d)}>
                    {dayName(d)}
                  </TabsTrigger>
                ))}
              </TabsList>
              {days.map((d) => (
                <TabsContent key={d} value={String(d)} className="space-y-4">
                  {routes
                    .filter((r) => r.day_of_week === d)
                    .map((r) => (
                      <Card key={`${r.crew_id}-${d}`}>
                        <CardHeader className="pb-2">
                          <div className="flex items-center justify-between">
                            <CardTitle className="text-base">{r.crew_name}</CardTitle>
                            <div className="text-xs text-muted-foreground">
                              {r.stops.length} stops · {formatHours(r.clock_hours)} clock · {formatHours(r.drive_hours)} drive ·{' '}
                              {formatMiles(r.drive_miles)}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="p-0">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead className="w-16">Arr.</TableHead>
                                <TableHead>Property</TableHead>
                                <TableHead>Address</TableHead>
                                <TableHead className="w-24 text-right">Service</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {r.stops.map((s, i) => (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-xs">{s.arrival_time}</TableCell>
                                  <TableCell className="font-medium">{s.property_name}</TableCell>
                                  <TableCell className="text-muted-foreground">{s.address}</TableCell>
                                  <TableCell className="text-right">{(s.service_minutes / 60).toFixed(1)}h</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </CardContent>
                      </Card>
                    ))}
                </TabsContent>
              ))}
            </Tabs>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Per-crew utilization</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Crew</TableHead>
                <TableHead className="text-right">Clock hrs/wk</TableHead>
                <TableHead className="text-right">Drive hrs/wk</TableHead>
                <TableHead className="text-right">Drive miles</TableHead>
                <TableHead className="text-right">Properties</TableHead>
                <TableHead className="text-right">Util %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {utilization.map((u) => (
                <TableRow key={u.crew_id}>
                  <TableCell className="font-medium">{u.crew_name}</TableCell>
                  <TableCell className="text-right">{formatHours(u.clock_hours)}</TableCell>
                  <TableCell className="text-right">{formatHours(u.drive_hours)}</TableCell>
                  <TableCell className="text-right">{formatMiles(u.drive_miles)}</TableCell>
                  <TableCell className="text-right">{u.props_assigned}</TableCell>
                  <TableCell className="text-right">{u.util_pct.toFixed(0)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
