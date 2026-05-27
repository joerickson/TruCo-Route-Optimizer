import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { UnassignedSummary } from '@/lib/property-coverage';
import { ApplyFixButton } from './apply-fix-button';
import type { FixPlan } from '@/lib/unassigned-fix';

// Shown in every completed-run view when work couldn't be fully scheduled.
export function UnassignedBanner({
  count,
  totalUnplacedHours,
  underUtilizedCount,
  currentView,
}: {
  count: number;
  totalUnplacedHours: number;
  underUtilizedCount: number;
  currentView: 'list' | 'map' | 'calendar';
}) {
  return (
    <Card className="border-amber-300 bg-amber-50/50">
      <CardContent className="pt-4 text-sm text-amber-900">
        <strong>{count}</strong> propert{count === 1 ? 'y' : 'ies'} (~{totalUnplacedHours.toFixed(1)}{' '}
        person-hours) not fully scheduled.
        {underUtilizedCount > 0
          ? ` ${underUtilizedCount} crew${underUtilizedCount === 1 ? '' : 's'} ${
              underUtilizedCount === 1 ? 'is' : 'are'
            } under 40 h/week, so this is likely a day-balancing or capacity gap — not a property problem.`
          : ' The fleet looks fully loaded — likely a true capacity shortfall (more crews needed).'}{' '}
        {currentView === 'list' ? 'Details are listed below.' : 'See the Unassigned list in the List view.'}
      </CardContent>
    </Card>
  );
}

export function UnassignedFix({ plan, runId }: { plan: FixPlan; runId: string }) {
  const nothing = plan.relocations.length === 0 && plan.additions.length === 0;
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle>Suggested fix</CardTitle>
        <CardDescription>
          {nothing
            ? 'No automatic fix available for this run.'
            : 'Relocate under-utilized crews to the short branch(es), then add crews where needed, and re-optimize.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!plan.hadIdleCrews && !nothing && (
          <p className="text-muted-foreground">No under-utilized crews to relocate &mdash; this needs added capacity.</p>
        )}
        <ul className="list-disc space-y-1 pl-5">
          {plan.relocations.map((r) => (
            <li key={r.crew_id}>
              Move <strong>{r.crew_name}</strong> ({r.crew_size}-person) from {r.from_branch_name} &rarr; {r.to_branch_name}.
            </li>
          ))}
          {plan.additions.map((a) => (
            <li key={`${a.branch_id}-${a.size}`}>
              Add <strong>{a.count} {a.size}-person crew{a.count === 1 ? '' : 's'}</strong> at {a.branch_name}.
            </li>
          ))}
        </ul>
        {plan.unresolvedPropertyIds.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {plan.unresolvedPropertyIds.length} unassigned propert
            {plan.unresolvedPropertyIds.length === 1 ? 'y' : 'ies'} couldn&rsquo;t be attributed to a branch and aren&rsquo;t covered by this fix.
          </p>
        )}
        {!nothing && <ApplyFixButton runId={runId} />}
        {!nothing && (
          <p className="text-xs text-muted-foreground">
            Applies these changes to the Crews page (reversible there) and starts a fresh optimization. The new run is
            the real test &mdash; capacity here is estimated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Detailed list (List view): each unassigned property with how much of its labor got placed.
export function UnassignedCard({ summary }: { summary: UnassignedSummary }) {
  return (
    <Card className="border-amber-300">
      <CardHeader>
        <CardTitle>Unassigned properties</CardTitle>
        <CardDescription>
          {summary.count} not fully scheduled · ~{summary.totalUnplacedHours.toFixed(0)} of{' '}
          {summary.totalLaborHours.toFixed(0)} person-hours unplaced
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Property</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Service</TableHead>
              <TableHead className="text-right">Coverage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-muted-foreground">{r.city ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{r.serviceType}</TableCell>
                <TableCell className="text-right">
                  {r.coveredHours.toFixed(0)} / {r.totalHours.toFixed(0)} h ({(r.pct * 100).toFixed(0)}%)
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
