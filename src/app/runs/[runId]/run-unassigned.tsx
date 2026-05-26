import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { UnassignedSummary } from '@/lib/property-coverage';

// Shown in every completed-run view when work couldn't be fully scheduled.
export function UnassignedBanner({
  count,
  totalUnplacedHours,
  underUtilizedCount,
}: {
  count: number;
  totalUnplacedHours: number;
  underUtilizedCount: number;
}) {
  return (
    <Card className="border-amber-300 bg-amber-50/50">
      <CardContent className="pt-4 text-sm text-amber-900">
        <strong>{count}</strong> propert{count === 1 ? 'y' : 'ies'} (~{totalUnplacedHours.toFixed(0)}{' '}
        person-hours) not fully scheduled.
        {underUtilizedCount > 0
          ? ` ${underUtilizedCount} crew${underUtilizedCount === 1 ? '' : 's'} ${
              underUtilizedCount === 1 ? 'is' : 'are'
            } under 40 h/week, so this is likely a day-balancing or capacity gap — not a property problem.`
          : ' The fleet looks fully loaded — likely a true capacity shortfall (more crews needed).'}{' '}
        See the Unassigned list in the List view.
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
              <TableHead className="text-right">Scheduled</TableHead>
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
