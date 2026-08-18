'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { ScenarioSwitcher } from '@/components/scenario-switcher';
import type { Scenario, ScenarioKind } from '@/lib/types';

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/properties', label: 'Properties' },
  { href: '/coverage', label: 'Bid Area' },
  { href: '/snow', label: 'Snow' },
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
  activeScenarioKind = 'maintenance',
}: {
  scenarios: Pick<Scenario, 'id' | 'name'>[];
  activeScenarioId: string | null;
  activeScenarioKind?: ScenarioKind;
}) {
  const pathname = usePathname();
  const isSnow = activeScenarioKind === 'snow';
  // Snow analysis is snow-only; the summer Capacity bands don't apply to snow scenarios.
  const nav = NAV.filter((item) => {
    if (item.href === '/snow') return isSnow;
    if (item.href === '/capacity') return !isSnow;
    return true;
  });
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
      <div className="container flex h-14 items-center gap-6">
        <Link href="/" className="font-semibold tracking-tight">
          TruCo<span className="text-primary"> Routes</span>
        </Link>
        <nav className="flex items-center gap-1">
          {nav.map((item) => {
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
