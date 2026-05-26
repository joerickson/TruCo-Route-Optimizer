import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { getServerClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { OptimizeForm } from './optimize-form';

export const dynamic = 'force-dynamic';
// Solver runs can take 60-90s; with waitUntil() the function must stay alive
// at least that long after responding to the client.
export const maxDuration = 300;

function defaultPeakWeek(): string {
  // First Monday of June (peak summer for SLC landscape)
  const year = new Date().getFullYear();
  const d = new Date(Date.UTC(year, 5, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export default async function OptimizePage() {
  const supabase = getServerClient();
  const [{ data: runs }, { count: propCount }, { count: crewCount }, { count: branchCount }] = await Promise.all([
    supabase.from('optimization_runs').select('*').eq('run_kind', 'optimized').order('created_at', { ascending: false }).limit(20),
    supabase.from('properties').select('*', { count: 'exact', head: true }).eq('is_active', true).not('lat', 'is', null),
    supabase.from('crews').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('branches').select('*', { count: 'exact', head: true }).eq('is_active', true),
  ]);

  const ready = (propCount ?? 0) > 0 && (crewCount ?? 0) > 0 && (branchCount ?? 0) > 0;
  const recentRuns = (runs ?? []) as OptimizationRun[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Optimize</h1>
        <p className="text-sm text-muted-foreground">
          {propCount ?? 0} geocoded properties · {crewCount ?? 0} crews · {branchCount ?? 0} branches
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New optimization run</CardTitle>
          <CardDescription>
            Solver runs OR-Tools VRP per weekday with soft same-day preference and a max-clock-hours-per-day cap. Travel time is
            estimated from straight-line distance × 1.3 road factor; actual times will vary.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OptimizeForm defaultWeek={defaultPeakWeek()} ready={ready} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Target week</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentRuns.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{r.target_week_start_date}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Link className="text-primary hover:underline" href={`/runs/${r.id}`}>
                      View →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {recentRuns.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No runs yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
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
