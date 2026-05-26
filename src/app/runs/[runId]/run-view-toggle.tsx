import Link from 'next/link';
import { cn } from '@/lib/utils';

const VIEWS: Array<{ value: 'list' | 'map' | 'calendar'; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'map', label: 'Map' },
  { value: 'calendar', label: 'Calendar' },
];

export function RunViewToggle({
  runId,
  current,
}: {
  runId: string;
  current: 'list' | 'map' | 'calendar';
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      {VIEWS.map((v) => (
        <Link
          key={v.value}
          href={`/runs/${runId}?view=${v.value}`}
          aria-current={current === v.value ? 'page' : undefined}
          className={cn(
            'rounded px-3 py-1.5 transition-colors',
            current === v.value
              ? 'bg-secondary font-medium text-secondary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {v.label}
        </Link>
      ))}
    </div>
  );
}
