import { getServiceClient } from '@/lib/supabase';
import type { OptimizationRun } from '@/lib/types';
import { compareSchedules } from '@/lib/schedule-compare';
import { dayName } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const baselineId = url.searchParams.get('baseline');
  const optimizedId = url.searchParams.get('optimized');
  if (!baselineId || !optimizedId) return new Response('baseline and optimized query params required', { status: 400 });

  const supabase = getServiceClient();
  const [{ data: b }, { data: o }] = await Promise.all([
    supabase.from('optimization_runs').select('*').eq('id', baselineId).maybeSingle(),
    supabase.from('optimization_runs').select('*').eq('id', optimizedId).maybeSingle(),
  ]);
  if (!b || !o) return new Response('run not found', { status: 404 });

  const comparison = compareSchedules(b as OptimizationRun, o as OptimizationRun);
  const header = ['property', 'from_crew', 'from_day', 'to_crew', 'to_day', 'changed_crew', 'changed_day'];
  const lines = [header.join(',')];
  for (const c of comparison.changes) {
    const cells = [
      c.propertyName,
      c.from.crewName ?? '', dayName(c.from.day),
      c.to.crewName ?? '', dayName(c.to.day),
      String(c.changedCrew), String(c.changedDay),
    ].map((v) => `"${(v ?? '').replace(/"/g, '""')}"`);
    lines.push(cells.join(','));
  }

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv',
      'content-disposition': `attachment; filename="reassignments-${baselineId.slice(0, 8)}.csv"`,
    },
  });
}
