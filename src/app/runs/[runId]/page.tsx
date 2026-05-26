import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun, CrewDayRoute } from '@/lib/types';
import { dayName, formatHours, formatMiles } from '@/lib/utils';
import { RunRefresher } from './refresher';
import { ExportCsvButton } from './export-csv';
import { RunViewToggle } from './run-view-toggle';
import { RoutesMapLoader } from './routes-map-loader';
import { RunCalendar } from './run-calendar';
import { buildCalendarGrid, type CrewAvailability } from '@/lib/calendar-grid';
import type { RoutesMapCrew, RoutesMapDepot, RoutesMapUnassigned } from './routes-map';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
  searchParams,
}: {
  params: { runId: string };
  searchParams: { view?: string };
}) {
  const view: 'list' | 'map' | 'calendar' =
    searchParams.view === 'map' ? 'map' : searchParams.view === 'calendar' ? 'calendar' : 'list';
  const supabase = getServerClient();
  const { data, error } = await supabase
    .from('optimization_runs')
    .select('*')
    .eq('id', params.runId)
    .maybeSingle();

  if (error || !data) notFound();
  const run = data as OptimizationRun;

  const isPolling = run.status === 'pending' || run.status === 'running';

  // Preformatted "Branch · Np" label per crew (home branch + crew size), shown
  // inline next to crew names across the views. Empty string when unknown.
  const crewMeta =
    run.status === 'completed'
      ? await loadCrewMeta(supabase, (run.crew_utilization ?? []).map((c) => c.crew_id))
      : {};

  return (
    <div className="space-y-6">
      {isPolling && <RunRefresher />}

      <div className="flex items-end justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{run.name}</h1>
            {run.run_kind === 'baseline' && <Badge variant="secondary">baseline</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">
            Target week: {run.target_week_start_date} · created {new Date(run.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {run.status === 'completed' && <RunViewToggle runId={run.id} current={view} />}
          <RunStatusBadge status={run.status} />
        </div>
      </div>

      {run.run_kind === 'baseline' && run.status === 'completed' && (
        <Card className="border-secondary">
          <CardHeader className="py-3">
            <CardDescription>
              This is a <strong>scored current schedule</strong> (your existing crew assignments run
              through the solver), not an optimization. Compare it against an optimized run on the{' '}
              <Link href="/compare" className="text-primary underline-offset-2 hover:underline">
                Compare page
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      )}

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

      {run.status === 'completed' &&
        (view === 'map' ? (
          <RunMap run={run} crewMeta={crewMeta} />
        ) : view === 'calendar' ? (
          <RunCalendarView run={run} crewMeta={crewMeta} />
        ) : (
          <CompletedRun run={run} crewMeta={crewMeta} />
        ))}
    </div>
  );
}

// Build a "Branch · Np" label per crew from the crews + branches tables, keyed
// by crew_id. The run row only stores crew_id/crew_name, so home branch and
// crew size are joined here.
async function loadCrewMeta(
  supabase: ReturnType<typeof getServerClient>,
  crewIds: string[]
): Promise<Record<string, string>> {
  if (crewIds.length === 0) return {};
  const { data: crewRows } = await supabase
    .from('crews')
    .select('id, crew_size, home_branch_id')
    .in('id', crewIds);
  const crews = (crewRows ?? []) as Array<{
    id: string;
    crew_size: number | string | null;
    home_branch_id: string | null;
  }>;

  const branchIds = Array.from(
    new Set(crews.map((c) => c.home_branch_id).filter((b): b is string => !!b))
  );
  const branchName: Record<string, string> = {};
  if (branchIds.length > 0) {
    const { data: branchRows } = await supabase.from('branches').select('id, name').in('id', branchIds);
    for (const b of (branchRows ?? []) as Array<{ id: string; name: string }>) branchName[b.id] = b.name;
  }

  const meta: Record<string, string> = {};
  for (const c of crews) {
    const parts: string[] = [];
    const bn = c.home_branch_id ? branchName[c.home_branch_id] : undefined;
    if (bn) parts.push(bn);
    const size = Number(c.crew_size ?? 0);
    if (size > 0) parts.push(`${size}p`);
    meta[c.id] = parts.join(' · ');
  }
  return meta;
}

async function RunMap({ run, crewMeta }: { run: OptimizationRun; crewMeta: Record<string, string> }) {
  const supabase = getServerClient();
  const routes: CrewDayRoute[] = run.routes_jsonb?.per_day ?? [];
  const days = Array.from(new Set(routes.map((r) => r.day_of_week))).sort((a, b) => a - b);

  // Join depot coordinates for every branch referenced by a route.
  const branchIds = Array.from(new Set(routes.map((r) => r.branch_id)));

  // Load unassigned properties (null on pre-migration runs -> empty).
  const unassignedIds = run.unassigned_property_ids ?? [];

  const [branchResult, propResult] = await Promise.all([
    branchIds.length > 0
      ? supabase
          .from('branches')
          .select('id, name, lat, lng')
          .in('id', branchIds)
          .not('lat', 'is', null)
          .not('lng', 'is', null)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; lat: number | string; lng: number | string }> }),
    unassignedIds.length > 0
      ? supabase
          .from('properties')
          .select('id, name, address, lat, lng')
          .in('id', unassignedIds)
          .not('lat', 'is', null)
          .not('lng', 'is', null)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string; address: string; lat: number | string; lng: number | string }> }),
  ]);

  const depotsById: Record<string, RoutesMapDepot> = {};
  for (const b of (branchResult.data ?? []) as Array<{ id: string; name: string; lat: number | string; lng: number | string }>) {
    if (b.lat == null || b.lng == null) continue;
    depotsById[b.id] = { id: b.id, name: b.name, lat: Number(b.lat), lng: Number(b.lng) };
  }

  const unassigned: RoutesMapUnassigned[] = ((propResult.data ?? []) as Array<{ id: string; name: string; address: string; lat: number | string; lng: number | string }>).map(
    (p) => ({ id: p.id, name: p.name, address: p.address, lat: Number(p.lat), lng: Number(p.lng) })
  );

  // Assign each crew a stable, evenly-spread color.
  const crewSeen = new Map<string, string>();
  for (const r of routes) if (!crewSeen.has(r.crew_id)) crewSeen.set(r.crew_id, r.crew_name);
  const sortedCrews = Array.from(crewSeen.entries()).sort((a, b) =>
    a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])
  );
  const n = Math.max(1, sortedCrews.length);
  const crewColors: Record<string, string> = {};
  const crewOrder: RoutesMapCrew[] = sortedCrews.map(([crewId, name], i) => {
    const color = `hsl(${Math.round((i * 360) / n)}, 65%, 50%)`;
    crewColors[crewId] = color;
    const meta = crewMeta[crewId];
    return { crewId, name: meta ? `${name} · ${meta}` : name, color };
  });

  return (
    <RoutesMapLoader
      routes={routes}
      depotsById={depotsById}
      crewColors={crewColors}
      crewOrder={crewOrder}
      unassigned={unassigned}
      days={days}
    />
  );
}

async function RunCalendarView({ run, crewMeta }: { run: OptimizationRun; crewMeta: Record<string, string> }) {
  const supabase = getServerClient();
  const routes: CrewDayRoute[] = run.routes_jsonb?.per_day ?? [];
  const crewUtil = run.crew_utilization ?? [];
  const crewIds = crewUtil.map((c) => c.crew_id);

  const crewsById: Record<string, CrewAvailability> = {};
  if (crewIds.length > 0) {
    const { data: crewRows } = await supabase
      .from('crews')
      .select(
        'id, works_monday, works_tuesday, works_wednesday, works_thursday, works_friday, max_clock_hours_per_day'
      )
      .in('id', crewIds);
    for (const c of (crewRows ?? []) as Array<{
      id: string;
      works_monday: boolean;
      works_tuesday: boolean;
      works_wednesday: boolean;
      works_thursday: boolean;
      works_friday: boolean;
      max_clock_hours_per_day: number | string | null;
    }>) {
      crewsById[c.id] = {
        works: {
          1: !!c.works_monday,
          2: !!c.works_tuesday,
          3: !!c.works_wednesday,
          4: !!c.works_thursday,
          5: !!c.works_friday,
        },
        maxHoursPerDay: Number(c.max_clock_hours_per_day ?? 8) || 8,
      };
    }
  }

  const grid = buildCalendarGrid(routes, crewUtil, crewsById);
  return <RunCalendar grid={grid} crewMeta={crewMeta} />;
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

function CompletedRun({ run, crewMeta }: { run: OptimizationRun; crewMeta: Record<string, string> }) {
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
                            <CardTitle className="text-base">
                              {r.crew_name}
                              {crewMeta[r.crew_id] && (
                                <span className="font-normal text-muted-foreground"> · {crewMeta[r.crew_id]}</span>
                              )}
                            </CardTitle>
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
                  <TableCell className="font-medium">
                    {u.crew_name}
                    {crewMeta[u.crew_id] && (
                      <span className="font-normal text-muted-foreground"> · {crewMeta[u.crew_id]}</span>
                    )}
                  </TableCell>
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
