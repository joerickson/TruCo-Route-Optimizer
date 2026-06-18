import * as XLSX from 'xlsx';
import { getServerClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';

export const dynamic = 'force-dynamic';

// Pre-filled template for the actual-hours upload: every active property with its identifier +
// reference columns already populated and a blank actual_hours_per_week to fill in. Round-tripping
// this file guarantees the headers and external_id matching are correct.
export async function GET() {
  const scenarioId = await getActiveScenarioId();
  const supabase = getServerClient();
  const { data } = await supabase
    .from('properties')
    .select('external_id, name, city, service_type, est_labor_hours, actual_hours_per_week')
    .eq('scenario_id', scenarioId ?? '')
    .eq('is_active', true)
    .order('name');

  const rows = (data ?? []).map((p) => ({
    external_id: p.external_id ?? '',
    name: p.name,
    city: p.city ?? '',
    service_type: p.service_type,
    'est_labor_hours (budget, per visit)': p.est_labor_hours,
    actual_hours_per_week: p.actual_hours_per_week ?? '',
  }));

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: ['external_id', 'name', 'city', 'service_type', 'est_labor_hours (budget, per visit)', 'actual_hours_per_week'],
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Actual Hours');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="actual-hours-template.xlsx"',
    },
  });
}
