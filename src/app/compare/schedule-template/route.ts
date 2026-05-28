import * as XLSX from 'xlsx';
import { getServerClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// Pre-filled template for the current-schedule upload (Compare tab). The "Schedule" sheet lists every
// active property with its External ID + reference columns and blank Crew/Day to fill in; round-tripping
// it guarantees the headers (External ID / Crew / Day) and external_id matching are correct. The
// "Reference" sheet lists the valid crew names to enter and the accepted Day formats.
export async function GET() {
  const supabase = getServerClient();
  const [{ data: props }, { data: crews }] = await Promise.all([
    supabase.from('properties').select('external_id, name, city, service_type').eq('is_active', true).order('name'),
    supabase.from('crews').select('name').eq('is_active', true).order('name'),
  ]);

  const scheduleRows = (props ?? []).map((p) => ({
    'External ID': p.external_id ?? '',
    name: p.name,
    city: p.city ?? '',
    service_type: p.service_type,
    Crew: '',
    Day: '',
  }));

  const referenceRows = [
    { 'Valid Crew names (enter in the Crew column)': 'Day column accepts: Monday–Sunday, or 1–7 (1 = Monday)' },
    ...(crews ?? []).map((c) => ({ 'Valid Crew names (enter in the Crew column)': c.name as string })),
  ];

  const wb = XLSX.utils.book_new();
  const scheduleWs = XLSX.utils.json_to_sheet(scheduleRows, {
    header: ['External ID', 'name', 'city', 'service_type', 'Crew', 'Day'],
  });
  XLSX.utils.book_append_sheet(wb, scheduleWs, 'Schedule');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(referenceRows), 'Reference');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Response(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="current-schedule-template.xlsx"',
    },
  });
}
