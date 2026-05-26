import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatHours } from '@/lib/utils';
import type { CrewDelta } from '@/lib/schedule-compare';

function flagBadge(flag: CrewDelta['flag']) {
  if (flag === 'overloaded') return <Badge variant="destructive">overloaded</Badge>;
  if (flag === 'underused') return <Badge variant="secondary">underused</Badge>;
  return <Badge variant="success">ok</Badge>;
}

export function CrewDeltas({ crews }: { crews: CrewDelta[] }) {
  const sorted = [...crews].sort((a, b) => a.currentClock - b.currentClock).reverse();
  return (
    <Card>
      <CardHeader><CardTitle>Per-crew rebalancing</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Crew</TableHead>
              <TableHead className="text-right">Current</TableHead>
              <TableHead className="text-right">Optimized</TableHead>
              <TableHead className="text-right">Δ clock</TableHead>
              <TableHead className="text-right">Status (today)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((c) => (
              <TableRow key={c.crewId}>
                <TableCell className="font-medium">{c.crewName}</TableCell>
                <TableCell className="text-right">{formatHours(c.currentClock)}</TableCell>
                <TableCell className="text-right">{formatHours(c.optimizedClock)}</TableCell>
                <TableCell className="text-right">{c.deltaClock > 0 ? '+' : ''}{c.deltaClock.toFixed(1)}</TableCell>
                <TableCell className="text-right">{flagBadge(c.flag)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
