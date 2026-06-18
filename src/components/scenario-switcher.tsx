'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { setActiveScenario } from '@/app/scenarios/actions';
import type { Scenario } from '@/lib/types';

export function ScenarioSwitcher({
  scenarios,
  activeId,
}: {
  scenarios: Pick<Scenario, 'id' | 'name'>[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Scenario</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={activeId ?? ''}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(async () => {
            await setActiveScenario(id);
            router.refresh();
          });
        }}
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Link href="/scenarios" className="text-sm text-muted-foreground hover:text-foreground">
        Manage
      </Link>
    </div>
  );
}
