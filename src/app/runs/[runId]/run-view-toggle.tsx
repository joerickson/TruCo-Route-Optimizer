import Link from 'next/link';
import { cn } from '@/lib/utils';

export function RunViewToggle({ runId, current }: { runId: string; current: 'list' | 'map' }) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      <Link
        href={`/runs/${runId}?view=list`}
        aria-current={current === 'list' ? 'page' : undefined}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'list'
            ? 'bg-secondary font-medium text-secondary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        List
      </Link>
      <Link
        href={`/runs/${runId}?view=map`}
        aria-current={current === 'map' ? 'page' : undefined}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'map'
            ? 'bg-secondary font-medium text-secondary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
      >
        Map
      </Link>
    </div>
  );
}
