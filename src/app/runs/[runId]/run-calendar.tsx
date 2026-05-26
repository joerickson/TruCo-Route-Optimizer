import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { dayName } from '@/lib/utils';
import type { CalendarRow, CalendarCell, CapacityBand } from '@/lib/calendar-grid';

const WEEKDAYS = [1, 2, 3, 4, 5];

const BAND_LABEL: Record<CapacityBand, string> = {
  over_provisioned: 'Over-provisioned',
  sufficient: 'Sustainable',
  tight: 'Tight',
  add_crew: 'Add 1-2 crews',
  unsustainable: 'Unsustainable',
};

const BAND_CLASS: Record<CapacityBand, string> = {
  over_provisioned: 'bg-slate-100 text-slate-700',
  sufficient: 'bg-emerald-100 text-emerald-800',
  tight: 'bg-yellow-100 text-yellow-800',
  add_crew: 'bg-orange-100 text-orange-800',
  unsustainable: 'bg-red-100 text-red-800',
};

export function RunCalendar({
  grid,
  crewMeta = {},
}: {
  grid: CalendarRow[];
  crewMeta?: Record<string, string>;
}) {
  if (grid.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Crew week</CardTitle>
          <CardDescription>No crews in this run.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const idleCount = grid.filter((r) => r.fullyIdle).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Crew week</CardTitle>
        <CardDescription>
          {idleCount} of {grid.length} crews idle all week &middot; Availability reflects crews&rsquo; current schedule; may
          differ from when this run was generated.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium">Crew</th>
                {WEEKDAYS.map((d) => (
                  <th key={d} className="p-2 text-center font-medium">
                    {dayName(d)}
                  </th>
                ))}
                <th className="p-2 text-right font-medium">Week</th>
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.crewId} className="border-t">
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.crewName}</span>
                      {crewMeta[row.crewId] && (
                        <span className="text-xs font-normal text-muted-foreground">· {crewMeta[row.crewId]}</span>
                      )}
                      {row.fullyIdle && <Badge variant="warning">idle all week</Badge>}
                    </div>
                  </td>
                  {WEEKDAYS.map((d) => (
                    <DayCell key={d} cell={row.days[d]} />
                  ))}
                  <td className="p-2 text-right">
                    <span className={`inline-block rounded px-2 py-0.5 ${BAND_CLASS[row.band]}`}>
                      {row.weeklyClockHours.toFixed(1)}h &middot; {row.utilPct.toFixed(0)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <LegendSwatch className="bg-emerald-300" label="Assigned (shaded by fill)" />
          <LegendSwatch className="bg-amber-200" label="Idle (available, unused)" />
          <LegendSwatch className="bg-muted" label="Off (not scheduled)" />
          <span className="ml-2">Week band:</span>
          {(Object.keys(BAND_LABEL) as CapacityBand[]).map((b) => (
            <span key={b} className={`rounded px-1.5 py-0.5 ${BAND_CLASS[b]}`}>
              {BAND_LABEL[b]}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DayCell({ cell }: { cell: CalendarCell }) {
  if (cell.kind === 'assigned') {
    const opacity = 0.15 + 0.85 * (cell.fillPct ?? 0);
    return (
      <td className="p-1 text-center">
        <div className="rounded px-1 py-1" style={{ backgroundColor: `rgba(16, 185, 129, ${opacity})` }}>
          <div className="font-medium">{(cell.clockHours ?? 0).toFixed(1)}h</div>
          <div className="text-xs text-slate-700">{cell.stops ?? 0} stops</div>
        </div>
      </td>
    );
  }
  if (cell.kind === 'idle') {
    return (
      <td className="p-1 text-center">
        <div className="rounded bg-amber-200 px-1 py-1 text-xs font-medium text-amber-900">idle</div>
      </td>
    );
  }
  if (cell.kind === 'off') {
    return (
      <td className="p-1 text-center">
        <div className="rounded bg-muted px-1 py-1 text-xs text-muted-foreground">&mdash;</div>
      </td>
    );
  }
  return <td className="p-1 text-center text-xs text-muted-foreground">&middot;</td>;
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3 rounded ${className}`} />
      {label}
    </span>
  );
}
