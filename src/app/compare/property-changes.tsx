import Link from 'next/link';
import { ArrowRight, Download } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayName } from '@/lib/utils';
import type { PropertyChange, CoverageNote } from '@/lib/schedule-compare';

export function PropertyChanges({
  changes,
  coverage,
  baselineId,
  optimizedId,
}: {
  changes: PropertyChange[];
  coverage: CoverageNote;
  baselineId: string;
  optimizedId: string;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Per-property reassignments</CardTitle>
          <CardDescription>{changes.length} properties move crew or day</CardDescription>
        </div>
        {changes.length > 0 && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/compare/export?baseline=${baselineId}&optimized=${optimizedId}`}>
              <Download className="mr-1.5 h-4 w-4" />
              Export CSV
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {changes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No reassignments — the current schedule already matches the optimized plan.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Property</TableHead>
                <TableHead>From (current)</TableHead>
                <TableHead className="w-8" />
                <TableHead>To (optimized)</TableHead>
                <TableHead className="text-right">Changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((c) => (
                <TableRow key={c.propertyId}>
                  <TableCell className="font-medium">{c.propertyName}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {c.from.crewName ?? '—'} · {dayName(c.from.day)}
                  </TableCell>
                  <TableCell className="px-0 text-muted-foreground">
                    <ArrowRight className="h-4 w-4" />
                  </TableCell>
                  <TableCell>
                    {c.to.crewName ?? '—'} · {dayName(c.to.day)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex gap-1">
                      {c.changedCrew && <Badge variant="secondary">crew</Badge>}
                      {c.changedDay && <Badge variant="secondary">day</Badge>}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {(coverage.onlyInCurrent.length > 0 || coverage.onlyInOptimized.length > 0) && (
          <p className="border-t p-3 text-xs text-muted-foreground">
            Coverage note: {coverage.onlyInCurrent.length} propert
            {coverage.onlyInCurrent.length === 1 ? 'y' : 'ies'} scheduled only in the current plan,{' '}
            {coverage.onlyInOptimized.length} only in the optimized plan. Deltas cover the overlap.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
