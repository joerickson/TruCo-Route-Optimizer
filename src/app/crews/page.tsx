import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getServerClient } from '@/lib/supabase';
import type { Crew, Branch } from '@/lib/types';

export const dynamic = 'force-dynamic';

const DAYS: Array<[keyof Crew, string]> = [
  ['works_monday', 'M'],
  ['works_tuesday', 'T'],
  ['works_wednesday', 'W'],
  ['works_thursday', 'Th'],
  ['works_friday', 'F'],
  ['works_saturday', 'Sa'],
  ['works_sunday', 'Su'],
];

export default async function CrewsPage() {
  const supabase = getServerClient();
  const [{ data: crewsData }, { data: branchesData }] = await Promise.all([
    supabase.from('crews').select('*').eq('is_active', true).order('name'),
    supabase.from('branches').select('*').eq('is_active', true).order('name'),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Branch[];
  const branchById = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Crews</h1>
        <p className="text-sm text-muted-foreground">
          {crews.length} active crews · expected mix is 27 two-person + 3 three-person
        </p>
      </div>

      {crews.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No crews configured</CardTitle>
            <CardDescription>
              Run the seed migration to create the default 30-crew roster, or add crews manually.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Active crews</CardTitle>
          <CardDescription>Edit by clicking a row (coming next pass — for now these are managed via SQL/seed).</CardDescription>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {crews.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    <Badge variant={c.crew_size >= 3 ? 'default' : 'secondary'}>{c.crew_size}p</Badge>
                  </TableCell>
                  <TableCell>{branchById[c.home_branch_id] ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {DAYS.map(([k, label]) => (
                      <span key={k} className={c[k] ? 'mr-1 text-foreground' : 'mr-1 text-muted-foreground/40 line-through'}>
                        {label}
                      </span>
                    ))}
                  </TableCell>
                  <TableCell>{Number(c.max_clock_hours_per_day).toFixed(1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
