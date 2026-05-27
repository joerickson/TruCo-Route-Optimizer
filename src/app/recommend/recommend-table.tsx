import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecommendationResult, BranchRecommendation } from '@/lib/types';

function formatCrews(crews: { two: number; three: number }): string {
  if (crews.two === 0 && crews.three === 0) return '—';
  const parts: string[] = [];
  if (crews.two > 0) parts.push(`${crews.two}×2p`);
  if (crews.three > 0) parts.push(`${crews.three}×3p`);
  return parts.join(' + ');
}

function threePersonDrivers(b: BranchRecommendation): string {
  return [
    ...b.drivers_three_person,
    ...b.split_properties.map((s) => `${s} (split)`),
  ].join(', ') || '—';
}

export function RecommendTable({
  result,
  runId,
}: {
  result: RecommendationResult;
  runId: string | null;
}) {
  const t = result.totals;
  const c = result.changes;

  const redeployments = c.redeployments ?? [];
  const disbanded = c.disbanded ?? [];
  const hasRelocations = c.relocations.length > 0;
  const hasUpsizes = c.upsizes.length > 0;
  const hasAdditions = c.additions.length > 0;
  const hasRedeployments = redeployments.length > 0;
  const hasDisbanded = disbanded.length > 0;
  const hasSurplus = c.surplus_idle.length > 0;
  const noChanges = !hasRelocations && !hasUpsizes && !hasAdditions
    && !hasRedeployments && !hasDisbanded && !hasSurplus;

  return (
    <div className="space-y-4">
      {/* 1. Headline card */}
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Recommended fleet</CardDescription>
          <CardTitle className="text-2xl">
            Net new capital: ${t.net_capital_usd.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>
            Fleet {t.fleet_before} {'->'} {t.fleet_after} &middot; {t.new_crews} new crew(s) @ ${t.capex_usd.toLocaleString()}
          </p>
          {result.residual_unassigned.count > 0 && (
            <p className="text-amber-700">
              &#x26A0;&#xFE0F; {result.residual_unassigned.count} properties (~{result.residual_unassigned.labor_hours.toFixed(0)} h)
              still uncovered &mdash; a true capacity limit.
            </p>
          )}
        </CardContent>
      </Card>

      {/* 2. What-if link */}
      {runId && (
        <div>
          <Link
            href={`/runs/${runId}`}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            View optimized schedule for this fleet &rarr;
          </Link>
        </div>
      )}

      {/* 3. Changes card */}
      <Card>
        <CardHeader>
          <CardTitle>Fleet changes</CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-3">
          {noChanges && (
            <p className="text-muted-foreground">
              No fleet changes needed &mdash; current crews cover demand within the sustainable ceiling.
            </p>
          )}

          {hasRelocations && (
            <div>
              <p className="font-medium mb-1">Relocations</p>
              <ul className="space-y-1">
                {c.relocations.map((r, i) => (
                  <li key={i}>
                    Move {r.crew_name}: {r.from_branch_name} &rarr; {r.to_branch_name}
                    <span className="ml-2 text-muted-foreground">$0 &middot; {r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasUpsizes && (
            <div>
              <p className="font-medium mb-1">Upsizes</p>
              <ul className="space-y-1">
                {c.upsizes.map((u, i) => (
                  <li key={i}>
                    Upsize {u.count} crew(s) at {u.branch_name} to 3-person
                    <span className="ml-2 text-muted-foreground">labor only</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasAdditions && (
            <div>
              <p className="font-medium mb-1">Additions</p>
              <ul className="space-y-1">
                {c.additions.map((a, i) => (
                  <li key={i}>
                    Add {a.count} {a.size}-person crew(s) at {a.branch_name}
                    <span className="ml-2 text-muted-foreground">
                      ${(a.count * t.capex_usd).toLocaleString()} capital
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasRedeployments && (
            <div>
              <p className="font-medium mb-1">Disband &amp; redeploy</p>
              <ul className="space-y-1">
                {redeployments.map((r, i) => (
                  <li key={i}>
                    Disband {r.count} crew(s) at {r.from_branch_name} &rarr; redeploy asset to {r.to_branch_name} ({r.size}-person)
                    <span className="ml-2 text-muted-foreground">$0 capital</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasDisbanded && (
            <div>
              <p className="font-medium mb-1">Disband (downsize)</p>
              <ul className="space-y-1">
                {disbanded.map((d, i) => (
                  <li key={i} className="text-muted-foreground">
                    Disband {d.count} surplus crew(s) at {d.branch_name} &mdash; frees the asset
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasSurplus && (
            <div>
              <p className="font-medium mb-1">Surplus / Idle</p>
              <ul className="space-y-1">
                {c.surplus_idle.map((s, i) => (
                  <li key={i} className="text-muted-foreground">
                    {s.count} idle crew(s) at {s.branch_name} &mdash; could be redeployed
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 4. By-branch table */}
      <Card>
        <CardHeader>
          <CardTitle>By branch</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Demand (h/wk)</TableHead>
                <TableHead className="text-right">Crews before</TableHead>
                <TableHead className="text-right">Crews after</TableHead>
                <TableHead className="text-right">Util before &rarr; after</TableHead>
                <TableHead>3-person driven by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.branches.map((b) => (
                <TableRow key={b.branch_id}>
                  <TableCell className="font-medium">{b.branch_name}</TableCell>
                  <TableCell className="text-right">{b.demand_hours.toFixed(0)}</TableCell>
                  <TableCell className="text-right">{formatCrews(b.crews_before)}</TableCell>
                  <TableCell className="text-right">{formatCrews(b.crews_after)}</TableCell>
                  <TableCell className="text-right">
                    {b.util_before_pct.toFixed(0)}% &rarr; {b.util_after_pct.toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {threePersonDrivers(b)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 5. Unattributable footnote */}
      {result.unattributable_property_ids.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {result.unattributable_property_ids.length} properties couldn&apos;t be attributed to a branch (missing coordinates) and were excluded.
        </p>
      )}
    </div>
  );
}
