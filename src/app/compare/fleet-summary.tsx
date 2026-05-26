import { ArrowDown, ArrowRight, ArrowUp, Clock, MapPin, Minus, Route, Users, type LucideIcon } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ScheduleComparison } from '@/lib/schedule-compare';
import { BAND_LABELS } from '@/lib/schedule-compare';

type Band = ScheduleComparison['capacity']['currentBand'];

function bandLabel(b: Band): string {
  return b ? BAND_LABELS[b] : '—';
}

function bandVariant(b: Band): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (b) {
    case 'sufficient':
      return 'success';
    case 'tight_but_feasible':
    case 'add_crew_recommended':
      return 'warning';
    case 'add_crew_required':
      return 'destructive';
    default:
      return 'secondary'; // over_provisioned / null
  }
}

// Every fleet metric here is lower-is-better (drive hours/miles, clock hours,
// and crews used), so a negative delta is always the win.
function Stat({
  label,
  icon: Icon,
  current,
  optimized,
  delta,
  unit,
  pct,
}: {
  label: string;
  icon: LucideIcon;
  current: number;
  optimized: number;
  delta: number;
  unit: string;
  pct?: number;
}) {
  const fmt = (n: number) => `${n.toFixed(0)}${unit ? ` ${unit}` : ''}`;
  const isZero = delta === 0;
  const improved = delta < 0;
  const DirIcon = isZero ? Minus : improved ? ArrowDown : ArrowUp;
  const color = isZero ? 'text-muted-foreground' : improved ? 'text-emerald-600' : 'text-amber-700';
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </CardDescription>
        <CardTitle className={cn('flex items-center gap-1 text-2xl', color)}>
          <DirIcon className="h-5 w-5 shrink-0" />
          {delta > 0 ? '+' : ''}
          {fmt(delta)}
          {pct != null && !isZero && (
            <span className="text-sm font-normal">
              ({pct > 0 ? '+' : ''}
              {(pct * 100).toFixed(0)}%)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs text-muted-foreground">
        {fmt(current)} → {fmt(optimized)}
      </CardContent>
    </Card>
  );
}

export function FleetSummary({ comparison }: { comparison: ScheduleComparison }) {
  const f = comparison.fleet;
  const { currentBand, optimizedBand, verdict } = comparison.capacity;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Drive hrs/wk" icon={Route} {...f.driveHours} unit="hr" />
        <Stat label="Drive miles/wk" icon={MapPin} {...f.driveMiles} unit="mi" />
        <Stat label="Clock hrs/wk" icon={Clock} {...f.clockHours} unit="hr" />
        <Stat label="Active crews" icon={Users} {...f.activeCrews} unit="" />
      </div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Capacity verdict</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">{verdict}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>current</span>
            <Badge variant={bandVariant(currentBand)}>{bandLabel(currentBand)}</Badge>
            <ArrowRight className="h-3.5 w-3.5" />
            <span>optimized</span>
            <Badge variant={bandVariant(optimizedBand)}>{bandLabel(optimizedBand)}</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
