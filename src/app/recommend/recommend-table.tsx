import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { RecommendationResult } from '@/lib/types';

export function RecommendTable({ result }: { result: RecommendationResult }) {
  const t = result.totals;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>Recommended fleet</CardDescription>
          <CardTitle className="text-2xl">
            {t.total_crews} crews · {t.two_person} two-person + {t.three_person} three-person · {t.total_people} people
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Covers ~{t.demand_hours.toFixed(0)} person-hours/week across {result.branches.length} branches.
          {result.residual_unassigned.count > 0 && (
            <span className="text-amber-700">
              {' '}⚠️ {result.residual_unassigned.count} properties (~{result.residual_unassigned.labor_hours.toFixed(0)} h)
              still uncovered — a true capacity limit.
            </span>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>By branch</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">Demand (h/wk)</TableHead>
                <TableHead className="text-right">2-person</TableHead>
                <TableHead className="text-right">3-person</TableHead>
                <TableHead className="text-right">People</TableHead>
                <TableHead className="text-right">Avg util</TableHead>
                <TableHead>3-person driven by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.branches.map((b) => (
                <TableRow key={b.branch_id}>
                  <TableCell className="font-medium">{b.branch_name}</TableCell>
                  <TableCell className="text-right">{b.demand_hours.toFixed(0)}</TableCell>
                  <TableCell className="text-right">{b.two_person}</TableCell>
                  <TableCell className="text-right">{b.three_person}</TableCell>
                  <TableCell className="text-right">{b.total_people}</TableCell>
                  <TableCell className="text-right">{b.avg_util_pct.toFixed(0)}%</TableCell>
                  <TableCell className="text-muted-foreground">
                    {[...b.drivers_three_person, ...b.split_properties.map((s) => `${s} (split)`)].join(', ') || '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {result.unattributable_property_ids.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {result.unattributable_property_ids.length} properties couldn&apos;t be attributed to a branch (missing coordinates) and were excluded.
        </p>
      )}
    </div>
  );
}
