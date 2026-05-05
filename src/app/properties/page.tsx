import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { getServerClient } from '@/lib/supabase';
import { ImportForm } from './import-form';
import type { Property } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: { page?: string; q?: string };
}) {
  const page = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1);
  const q = (searchParams.q ?? '').trim();
  const supabase = getServerClient();

  let query = supabase
    .from('properties')
    .select('*', { count: 'exact' })
    .eq('is_active', true)
    .order('name')
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (q) query = query.ilike('name', `%${q}%`);

  const { data, count, error } = await query;
  const properties = (data ?? []) as Property[];

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  const ungeocoded = properties.filter((p) => p.lat == null).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Properties</h1>
          <p className="text-sm text-muted-foreground">
            {count ?? 0} active properties · {ungeocoded} on this page need geocoding
          </p>
        </div>
      </div>

      <ImportForm />

      {error && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Could not load properties</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>All properties</CardTitle>
            <form className="flex gap-2">
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search name…"
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              />
            </form>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Est hrs</TableHead>
                <TableHead>Geocoded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {properties.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-muted-foreground">{p.address}</TableCell>
                  <TableCell>{p.city}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.service_type}</Badge>
                  </TableCell>
                  <TableCell>{p.est_labor_hours.toFixed(1)}</TableCell>
                  <TableCell>
                    {p.lat != null ? (
                      <Badge variant="success">✓</Badge>
                    ) : (
                      <Badge variant="warning">pending</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {properties.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No properties yet. Import an Aspire CSV above to get started.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex items-center justify-between border-t px-6 py-3 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <a className="rounded-md border px-3 py-1" href={`/properties?page=${page - 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`}>
                Prev
              </a>
            )}
            {page < totalPages && (
              <a className="rounded-md border px-3 py-1" href={`/properties?page=${page + 1}${q ? `&q=${encodeURIComponent(q)}` : ''}`}>
                Next
              </a>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
