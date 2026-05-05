import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServerClient } from '@/lib/supabase';
import type { Branch } from '@/lib/types';
import { BranchForm } from './branch-form';

export const dynamic = 'force-dynamic';

export default async function BranchesPage() {
  const supabase = getServerClient();
  const { data } = await supabase.from('branches').select('*').eq('is_active', true).order('name');
  const branches = (data ?? []) as Branch[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Branches</h1>
        <p className="text-sm text-muted-foreground">
          {branches.length} active · address is geocoded automatically on create
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add a branch</CardTitle>
          <CardDescription>Used as crew start/end depots in the routing solver.</CardDescription>
        </CardHeader>
        <CardContent>
          <BranchForm />
        </CardContent>
      </Card>

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
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="font-medium">{b.name}</TableCell>
                  <TableCell className="text-muted-foreground">{b.address}</TableCell>
                  <TableCell>
                    {b.city}, {b.state} {b.postal_code ?? ''}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {Number(b.lat).toFixed(4)}, {Number(b.lng).toFixed(4)}
                  </TableCell>
                </TableRow>
              ))}
              {branches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No branches yet. Add one above.
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
