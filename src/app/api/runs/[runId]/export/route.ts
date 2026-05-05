import { getServiceClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { dayName } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { runId: string } }) {
  const supabase = getServiceClient();
  const { data, error } = await supabase.from('optimization_runs').select('*').eq('id', params.runId).maybeSingle();
  if (error || !data) {
    return new Response(error?.message ?? 'not found', { status: 404 });
  }
  const run = data as OptimizationRun;
  const routes = run.routes_jsonb?.per_day ?? [];

  const header = ['day', 'crew', 'stop_order', 'arrival_time', 'property', 'address', 'service_minutes', 'drive_minutes_to'];
  const lines: string[] = [header.join(',')];

  for (const route of routes) {
    route.stops.forEach((s, i) => {
      const cells = [
        dayName(route.day_of_week),
        route.crew_name,
        String(i + 1),
        s.arrival_time,
        s.property_name,
        s.address,
        String(s.service_minutes),
        String(s.drive_minutes_to),
      ].map((v) => `"${(v ?? '').replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    });
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="run-${run.id.slice(0, 8)}-routes.csv"`,
    },
  });
}
