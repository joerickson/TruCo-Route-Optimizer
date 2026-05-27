import Link from 'next/link';
import { cn } from '@/lib/utils';

// Pill row to filter the run's schedule views by branch. Server-rendered like RunViewToggle:
// each pill links to ?view=<view>&branch=<id> (empty = all). Only shown when a run spans >1 branch.
export function BranchFilter({
  runId,
  view,
  current,
  branches,
}: {
  runId: string;
  view: string;
  current: string | null;
  branches: { id: string; name: string }[];
}) {
  const options = [{ id: '', name: 'All branches' }, ...branches];
  return (
    <div className="inline-flex flex-wrap rounded-md border bg-background p-0.5 text-sm">
      {options.map((b) => {
        const active = (current ?? '') === b.id;
        const href = `/runs/${runId}?view=${view}${b.id ? `&branch=${b.id}` : ''}`;
        return (
          <Link
            key={b.id || 'all'}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded px-3 py-1.5 transition-colors',
              active
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {b.name}
          </Link>
        );
      })}
    </div>
  );
}
