import { ArrowDown, ArrowUp } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, formatHours } from '@/lib/utils';
import type { CrewDelta } from '@/lib/schedule-compare';

function flagBadge(flag: CrewDelta['flag']) {
  if (flag === 'overloaded') return <Badge variant="destructive">overloaded</Badge>;
  if (flag === 'underused') return <Badge variant="warning">underused</Badge>;
  return <Badge variant="success">ok</Badge>;
}

// Directional color only: green = the optimizer takes work off this crew,
// amber = it adds work (rebalancing toward the sustainable band).
function deltaCell(delta: number) {
  if (delta === 0) return <span className="text-muted-foreground">0</span>;
  const Icon = delta < 0 ? ArrowDown : ArrowUp;
  return (
    <span
      className={cn(
        'inline-flex items-center justify-end gap-0.5',
        delta < 0 ? 'text-emerald-600' : 'text-amber-700'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {delta > 0 ? '+' : ''}
      {delta.toFixed(1)}
    </span>
  );
}

export function CrewDeltas({ crews }: { crews: CrewDelta[] }) {
  const sorted = [...crews].sort((a, b) => b.currentClock - a.currentClock);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per-crew rebalancing</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {sorted.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No crew data.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Crew</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">Optimized</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Current load</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((c) => (
                <TableRow key={c.crewId}>
                  <TableCell className="font-medium">{c.crewName}</TableCell>
                  <TableCell className="text-right">{formatHours(c.currentClock)}</TableCell>
                  <TableCell className="text-right">{formatHours(c.optimizedClock)}</TableCell>
                  <TableCell className="text-right">{deltaCell(c.deltaClock)}</TableCell>
                  <TableCell className="text-right">{flagBadge(c.flag)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
