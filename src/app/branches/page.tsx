import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { Branch } from '@/lib/types';
import { AddBranchButton } from './add-branch-button';
import { BranchRow } from './branch-row';

export const dynamic = 'force-dynamic';

export default async function BranchesPage() {
  const supabase = getServerClient();
  const [{ data: branchesData }, { data: crewsData }] = await Promise.all([
    supabase.from('branches').select('*').order('name'),
    supabase.from('crews').select('home_branch_id').eq('is_active', true),
  ]);

  const branches = (branchesData ?? []) as Branch[];
  const crewCounts = new Map<string, number>();
  for (const c of crewsData ?? []) {
    const id = (c as { home_branch_id: string }).home_branch_id;
    crewCounts.set(id, (crewCounts.get(id) ?? 0) + 1);
  }

  const activeCount = branches.filter((b) => b.is_active).length;
  const ungeocoded = branches.filter((b) => b.lat == null || b.lng == null).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Branches</h1>
          <p className="text-sm text-muted-foreground">
            {activeCount} active · {branches.length} total
            {ungeocoded > 0 && ` · ${ungeocoded} need geocoding`}
          </p>
        </div>
        <AddBranchButton />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All branches</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Lat / Lng</TableHead>
                <TableHead className="text-right">Crews</TableHead>
                <TableHead className="text-right w-32"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.map((b) => (
                <BranchRow key={b.id} branch={b} crewCount={crewCounts.get(b.id) ?? 0} />
              ))}
              {branches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No branches yet. Add one above to get started.
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
