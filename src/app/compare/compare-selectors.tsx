'use client';
import { useRouter, useSearchParams } from 'next/navigation';

interface RunOption { id: string; name: string; created_at: string; }

export function CompareSelectors({
  baselines, optimized, baselineId, optimizedId,
}: {
  baselines: RunOption[]; optimized: RunOption[]; baselineId: string | null; optimizedId: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();

  function set(key: 'baseline' | 'optimized', value: string) {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.push(`/compare?${next.toString()}`);
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Current (baseline)</span>
        <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={baselineId ?? ''} onChange={(e) => set('baseline', e.target.value)}>
          <option value="" disabled>Select a baseline…</option>
          {baselines.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Optimized run</span>
        <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={optimizedId ?? ''} onChange={(e) => set('optimized', e.target.value)}>
          <option value="" disabled>Select an optimized run…</option>
          {optimized.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
    </div>
  );
}
