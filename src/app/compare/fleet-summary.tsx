import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScheduleComparison } from '@/lib/schedule-compare';
import { BAND_LABELS } from '@/lib/schedule-compare';

function bandLabel(b: ScheduleComparison['capacity']['currentBand']): string {
  return b ? BAND_LABELS[b] : '—';
}

function Stat({ label, current, optimized, delta, unit, lowerIsBetter = true }: {
  label: string; current: number; optimized: number; delta: number; unit: string; lowerIsBetter?: boolean;
}) {
  const improved = lowerIsBetter ? delta < 0 : delta > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">
          {optimized.toFixed(0)}{unit ? <span className="text-sm font-normal text-muted-foreground"> {unit}</span> : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        current {current.toFixed(0)}{unit ? ` ${unit}` : ''} ·{' '}
        <span className={improved ? 'text-emerald-600' : delta === 0 ? '' : 'text-amber-700'}>
          {delta > 0 ? '+' : ''}{delta.toFixed(0)}{unit ? ` ${unit}` : ''}
        </span>
      </CardContent>
    </Card>
  );
}

export function FleetSummary({ comparison }: { comparison: ScheduleComparison }) {
  const f = comparison.fleet;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Drive hrs/wk" current={f.driveHours.current} optimized={f.driveHours.optimized} delta={f.driveHours.delta} unit="hr" />
        <Stat label="Drive miles/wk" current={f.driveMiles.current} optimized={f.driveMiles.optimized} delta={f.driveMiles.delta} unit="mi" />
        <Stat label="Clock hrs/wk" current={f.clockHours.current} optimized={f.clockHours.optimized} delta={f.clockHours.delta} unit="hr" />
        <Stat label="Active crews" current={f.activeCrews.current} optimized={f.activeCrews.optimized} delta={f.activeCrews.delta} unit="" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Capacity verdict</CardTitle>
          <CardDescription>
            current: {bandLabel(comparison.capacity.currentBand)} · optimized: {bandLabel(comparison.capacity.optimizedBand)}
          </CardDescription>
        </CardHeader>
        <CardContent><p className="text-sm">{comparison.capacity.verdict}</p></CardContent>
      </Card>
    </div>
  );
}
