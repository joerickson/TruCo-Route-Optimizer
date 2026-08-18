import Link from 'next/link';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { snowCapacity, type SnowProperty, type SnowBranch } from '@/lib/snow-capacity';
import { SnowAssumptions, type TierRow } from './snow-assumptions';

export const dynamic = 'force-dynamic';

const h = (n: number) => `${n.toFixed(1)}h`;

export default async function SnowPage() {
  const scenarioId = await getActiveScenarioId();
  if (!scenarioId) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Snow bid</h1>
        <p className="text-sm text-muted-foreground">
          No scenario yet.{' '}
          <Link href="/scenarios" className="text-primary hover:underline">
            Create a scenario
          </Link>{' '}
          to get started.
        </p>
      </div>
    );
  }

  const supabase = getServiceClient();

  const [{ data: scenario }, { data: rateData }, { data: propData }, { data: branchData }, { count: ungeocoded }] =
    await Promise.all([
      supabase
        .from('scenarios')
        .select('name, kind, snow_window_hours, snow_sidewalk_hours')
        .eq('id', scenarioId)
        .single(),
      supabase.from('snow_tier_rates').select('tier, plow_hours').eq('scenario_id', scenarioId),
      supabase
        .from('properties')
        .select('id, name, lat, lng, tier, has_sidewalk')
        .eq('scenario_id', scenarioId)
        .eq('is_active', true)
        .not('lat', 'is', null)
        .not('lng', 'is', null)
        .limit(5000),
      supabase
        .from('branches')
        .select('id, name, lat, lng')
        .eq('scenario_id', scenarioId)
        .eq('is_active', true)
        .not('lat', 'is', null)
        .not('lng', 'is', null),
      supabase
        .from('properties')
        .select('*', { count: 'exact', head: true })
        .eq('scenario_id', scenarioId)
        .eq('is_active', true)
        .is('lat', null),
    ]);

  if (!scenario || scenario.kind !== 'snow') {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Snow bid</h1>
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            This scenario is a maintenance scenario, so the snow crews-needed model doesn&apos;t apply. Snow analysis
            appears for scenarios marked as snow (set <code>kind = &apos;snow&apos;</code> — the migration flips any
            scenario whose name contains &quot;snow&quot;).
          </CardContent>
        </Card>
      </div>
    );
  }

  const windowHours = Number(scenario.snow_window_hours);
  const sidewalkHours = Number(scenario.snow_sidewalk_hours);

  const properties: SnowProperty[] = ((propData ?? []) as Array<Record<string, unknown>>).map((p) => ({
    id: String(p.id),
    name: String(p.name ?? ''),
    lat: Number(p.lat),
    lng: Number(p.lng),
    tier: p.tier == null ? null : String(p.tier),
    has_sidewalk: Boolean(p.has_sidewalk),
  }));

  const branches: SnowBranch[] = ((branchData ?? []) as Array<Record<string, unknown>>).map((b) => ({
    id: String(b.id),
    name: String(b.name ?? ''),
    lat: Number(b.lat),
    lng: Number(b.lng),
  }));

  // Tier list = union of seeded rates and distinct property tiers, sorted for stable display.
  const rateMap = new Map<string, number>();
  for (const r of (rateData ?? []) as Array<{ tier: string; plow_hours: number }>) {
    rateMap.set(String(r.tier), Number(r.plow_hours));
  }
  const propTiers = new Set(properties.map((p) => p.tier).filter((t): t is string => t != null));
  const tierList = Array.from(new Set([...rateMap.keys(), ...propTiers])).sort();
  const tierRows: TierRow[] = tierList.map((tier) => ({ tier, plowHours: rateMap.get(tier) ?? 1 }));
  const tierPlowHours: Record<string, number> = {};
  for (const t of tierRows) tierPlowHours[t.tier] = t.plowHours;

  const result = snowCapacity({ properties, branches, tierPlowHours, sidewalkHours, windowHours });

  const sidewalkCount = properties.filter((p) => p.has_sidewalk).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Snow bid — crews needed</h1>
        <p className="text-sm text-muted-foreground">
          As-needed snow work sized against a per-storm window. Two fleets are sized independently per branch: plow
          trucks (every rated property) and sidewalk crews (only properties with sidewalks). Crews dispatch from home,
          so routes are open — travel is inter-stop only, no depot leg. {properties.length} geocoded properties ·{' '}
          {branches.length} branches · {sidewalkCount} with sidewalks.
        </p>
      </div>

      {/* Headline totals */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Plow trucks needed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{result.totals.plowCrews}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Sidewalk crews needed</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold">{result.totals.sidewalkCrews}</div>
          </CardContent>
        </Card>
      </div>

      {(result.unrated.length > 0 || (ungeocoded ?? 0) > 0) && (
        <div className="flex flex-wrap gap-2">
          {result.unrated.length > 0 && (
            <Badge variant="secondary">
              {result.unrated.length} unrated (no tier) — excluded from plow counts
            </Badge>
          )}
          {(ungeocoded ?? 0) > 0 && <Badge variant="secondary">{ungeocoded} not geocoded — excluded</Badge>}
        </div>
      )}

      <SnowAssumptions windowHours={windowHours} sidewalkHours={sidewalkHours} tiers={tierRows} />

      <Card>
        <CardHeader>
          <CardTitle>Per-branch breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right">Plow trucks</TableHead>
                  <TableHead className="text-right">Sidewalk crews</TableHead>
                  <TableHead className="text-right">Plow labor</TableHead>
                  <TableHead className="text-right">Sidewalk labor</TableHead>
                  <TableHead className="text-right">Est. travel</TableHead>
                  <TableHead className="text-right">Plow stops</TableHead>
                  <TableHead className="text-right">Sidewalk stops</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.branches.map((b) => (
                  <TableRow key={b.branchId || 'all'}>
                    <TableCell className="font-medium">{b.branchName}</TableCell>
                    <TableCell className="text-right">{b.plow.crews}</TableCell>
                    <TableCell className="text-right">{b.sidewalk.crews}</TableCell>
                    <TableCell className="text-right">{h(b.plow.laborHours)}</TableCell>
                    <TableCell className="text-right">{h(b.sidewalk.laborHours)}</TableCell>
                    <TableCell className="text-right">{h(b.plow.travelHours + b.sidewalk.travelHours)}</TableCell>
                    <TableCell className="text-right">{b.plow.stops}</TableCell>
                    <TableCell className="text-right">{b.sidewalk.stops}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell>Portfolio</TableCell>
                  <TableCell className="text-right">{result.totals.plowCrews}</TableCell>
                  <TableCell className="text-right">{result.totals.sidewalkCrews}</TableCell>
                  <TableCell className="text-right">
                    {h(result.branches.reduce((n, b) => n + b.plow.laborHours, 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {h(result.branches.reduce((n, b) => n + b.sidewalk.laborHours, 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {h(result.branches.reduce((n, b) => n + b.plow.travelHours + b.sidewalk.travelHours, 0))}
                  </TableCell>
                  <TableCell className="text-right">
                    {result.branches.reduce((n, b) => n + b.plow.stops, 0)}
                  </TableCell>
                  <TableCell className="text-right">
                    {result.branches.reduce((n, b) => n + b.sidewalk.stops, 0)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
