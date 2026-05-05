import Link from 'next/link';
import { cn } from '@/lib/utils';

export function ViewToggle({
  current,
  search,
}: {
  current: 'list' | 'map';
  search?: string;
}) {
  const baseQuery = search ? `&q=${encodeURIComponent(search)}` : '';
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
      <Link
        href={`/properties?view=list${baseQuery}`}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'list' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        List
      </Link>
      <Link
        href={`/properties?view=map${baseQuery}`}
        className={cn(
          'rounded px-3 py-1.5 transition-colors',
          current === 'map' ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'
        )}
      >
        Map
      </Link>
    </div>
  );
}
