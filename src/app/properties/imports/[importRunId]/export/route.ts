import { getServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Stable column order for round-trippable re-import.
const ASPIRE_COLUMNS = [
  'Property',
  'Property Address 1',
  'Property City',
  'Service Abr',
  'Est Hrs',
  'Opportunity Start Date',
  'Opportunity End Date',
  'Opportunity Name',
  'Property ID',
  'External ID',
];

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(_req: Request, { params }: { params: { importRunId: string } }) {
  const supabase = getServiceClient();
  const [{ data: run }, { data: skipped, error }] = await Promise.all([
    supabase.from('import_runs').select('id, filename').eq('id', params.importRunId).maybeSingle(),
    supabase
      .from('import_skipped_rows')
      .select('row_number, reason, raw_data')
      .eq('import_run_id', params.importRunId)
      .order('row_number', { ascending: true }),
  ]);

  if (error || !run) {
    return new Response(error?.message ?? 'not found', { status: 404 });
  }

  // Discover any extra columns present in raw_data that aren't in our default list,
  // so the export captures everything Aspire actually exported.
  const extraColumns = new Set<string>();
  for (const row of skipped ?? []) {
    const raw = (row.raw_data ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (!ASPIRE_COLUMNS.includes(k)) extraColumns.add(k);
    }
  }
  const dataColumns = [...ASPIRE_COLUMNS, ...Array.from(extraColumns).sort()];

  // Prepend the metadata columns. The re-import parser ignores unknown columns,
  // so "Original Row" and "Skip Reason" are safe to leave in when re-uploading.
  const header = ['Original Row', 'Skip Reason', ...dataColumns];
  const lines: string[] = [header.map(csvCell).join(',')];

  for (const row of skipped ?? []) {
    const raw = (row.raw_data ?? {}) as Record<string, unknown>;
    const cells = [
      csvCell(row.row_number),
      csvCell(row.reason),
      ...dataColumns.map((c) => csvCell(raw[c])),
    ];
    lines.push(cells.join(','));
  }

  const filenameBase = (run.filename ?? 'import').replace(/\.[^.]+$/, '');
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="${filenameBase}-skipped.csv"`,
    },
  });
}
