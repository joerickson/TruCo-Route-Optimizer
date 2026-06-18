'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ScenarioSwitcher } from '@/components/scenario-switcher';
import type { Scenario } from '@/lib/types';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/properties', label: 'Properties' },
  { href: '/crews', label: 'Crews' },
  { href: '/branches', label: 'Branches' },
  { href: '/optimize', label: 'Optimize' },
  { href: '/capacity', label: 'Capacity' },
  { href: '/compare', label: 'Compare' },
  { href: '/recommend', label: 'Recommend' },
];

export function TopNav({
  scenarios,
  activeScenarioId,
}: {
  scenarios: Pick<Scenario, 'id' | 'name'>[];
  activeScenarioId: string | null;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/" className="font-semibold tracking-tight">
          TruCo<span className="text-primary"> Routes</span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  active ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <ScenarioSwitcher scenarios={scenarios} activeId={activeScenarioId} />
      </div>
    </header>
  );
}
