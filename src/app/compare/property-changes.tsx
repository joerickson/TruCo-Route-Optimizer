import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayName } from '@/lib/utils';
import type { PropertyChange, CoverageNote } from '@/lib/schedule-compare';

export function PropertyChanges({
  changes, coverage, baselineId, optimizedId,
}: {
  changes: PropertyChange[]; coverage: CoverageNote; baselineId: string; optimizedId: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Per-property reassignments</CardTitle>
          <CardDescription>{changes.length} properties move crew or day</CardDescription>
        </div>
        <Link
          href={`/compare/export?baseline=${baselineId}&optimized=${optimizedId}`}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          Export CSV →
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        {changes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No reassignments — the current schedule already matches the optimized plan.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>From (current)</TableHead>
                <TableHead>To (optimized)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((c) => (
                <TableRow key={c.propertyId}>
                  <TableCell className="font-medium">{c.propertyName}</TableCell>
                  <TableCell className="text-muted-foreground">{c.from.crewName ?? '—'} · {dayName(c.from.day)}</TableCell>
                  <TableCell>{c.to.crewName ?? '—'} · {dayName(c.to.day)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(coverage.onlyInCurrent.length > 0 || coverage.onlyInOptimized.length > 0) && (
          <p className="border-t p-3 text-xs text-muted-foreground">
            Coverage note: {coverage.onlyInCurrent.length} propert{coverage.onlyInCurrent.length === 1 ? 'y' : 'ies'} scheduled
            only in the current plan, {coverage.onlyInOptimized.length} only in the optimized plan. Deltas cover the overlap.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
