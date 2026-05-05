import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { Crew, Branch } from '@/lib/types';
import { CrewRow } from './crew-row';
import { AddCrewButton } from './add-crew-button';

export const dynamic = 'force-dynamic';

export default async function CrewsPage() {
  const supabase = getServerClient();
  const [{ data: crewsData }, { data: branchesData }] = await Promise.all([
    supabase.from('crews').select('*').order('name'),
    supabase.from('branches').select('id, name, is_active').order('name'),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Pick<Branch, 'id' | 'name' | 'is_active'>[];
  const branchById = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  const activeCount = crews.filter((c) => c.is_active).length;
  const noActiveBranches = branches.filter((b) => b.is_active).length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Crews</h1>
          <p className="text-sm text-muted-foreground">
            {activeCount} active · {crews.length} total · expected mix is 27 two-person + 3 three-person
          </p>
        </div>
        <AddCrewButton branches={branches} />
      </div>

      {noActiveBranches && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader>
            <CardTitle className="text-amber-900">No active branches</CardTitle>
            <CardDescription className="text-amber-900">
              Crews must be assigned to a branch. Add one on the Branches page first.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All crews</CardTitle>
          <CardDescription>Click Edit on a row to change name, size, branch, working days, or max hours.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Working days</TableHead>
                <TableHead>Hrs/day</TableHead>
                <TableHead className="text-right w-44"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crews.map((c) => (
                <CrewRow key={c.id} crew={c} branchName={branchById[c.home_branch_id] ?? '—'} branches={branches} />
              ))}
              {crews.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No crews yet. Add one above.
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
