import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getServerClient } from '@/lib/supabase';
import type { Branch } from '@/lib/types';
import { createBranch } from './actions';

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
          <form action={createBranch} className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" placeholder="Salt Lake City HQ" required />
            </div>
            <div>
              <Label htmlFor="address">Street address</Label>
              <Input id="address" name="address" placeholder="2120 S 700 W" required />
            </div>
            <div>
              <Label htmlFor="city">City</Label>
              <Input id="city" name="city" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="state">State</Label>
                <Input id="state" name="state" defaultValue="UT" />
              </div>
              <div>
                <Label htmlFor="postal_code">Postal</Label>
                <Input id="postal_code" name="postal_code" />
              </div>
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Add branch</Button>
            </div>
          </form>
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
