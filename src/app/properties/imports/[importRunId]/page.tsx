import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getServerClient } from '@/lib/supabase';
import { SkippedRowsTable, type SkippedRowDTO } from './skipped-table';

export const dynamic = 'force-dynamic';

interface ImportRunRow {
  id: string;
  filename: string | null;
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  created_at: string;
}

export default async function ImportRunPage({ params }: { params: { importRunId: string } }) {
  const supabase = getServerClient();
  const [{ data: run }, { data: skipped }] = await Promise.all([
    supabase.from('import_runs').select('*').eq('id', params.importRunId).maybeSingle(),
    supabase
      .from('import_skipped_rows')
      .select('*')
      .eq('import_run_id', params.importRunId)
      .order('row_number', { ascending: true }),
  ]);

  if (!run) notFound();
  const importRun = run as ImportRunRow;
  const skippedRows: SkippedRowDTO[] = (skipped ?? []).map((s) => ({
    row_number: s.row_number,
    property_name: s.property_name,
    city: s.city,
    reason: s.reason,
    raw_data: s.raw_data ?? {},
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import: {importRun.filename ?? 'unknown file'}</h1>
          <p className="text-sm text-muted-foreground">
            {new Date(importRun.created_at).toLocaleString()} · {importRun.total_rows} total rows
          </p>
        </div>
        <Link href="/properties" className="text-sm text-primary hover:underline">
          ← Back to properties
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Stat label="Inserted" value={importRun.inserted_count} variant="success" />
        <Stat label="Updated" value={importRun.updated_count} variant="default" />
        <Stat label="Skipped" value={importRun.skipped_count} variant={importRun.skipped_count > 0 ? 'warning' : 'default'} />
      </div>

      {skippedRows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing skipped</CardTitle>
            <CardDescription>Every row was imported cleanly.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle>Skipped rows ({skippedRows.length})</CardTitle>
              <CardDescription>
                Click a column header to sort. Export to CSV to fix in your spreadsheet, then re-upload via the import form —
                already-imported properties won&apos;t be duplicated.
              </CardDescription>
            </div>
            <Button asChild size="sm" variant="outline">
              <a href={`/properties/imports/${importRun.id}/export`}>Export CSV</a>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <SkippedRowsTable rows={skippedRows} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: 'default' | 'success' | 'warning';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="flex items-center gap-3 text-3xl">
          {value.toLocaleString()}
          {variant === 'success' && value > 0 && <Badge variant="success">ok</Badge>}
          {variant === 'warning' && value > 0 && <Badge variant="warning">review</Badge>}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
