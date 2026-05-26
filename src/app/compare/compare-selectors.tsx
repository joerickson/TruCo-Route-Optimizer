'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RunOption {
  id: string;
  name: string;
  created_at: string;
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function CompareSelectors({
  baselines,
  optimized,
  baselineId,
  optimizedId,
}: {
  baselines: RunOption[];
  optimized: RunOption[];
  baselineId: string | null;
  optimizedId: string | null;
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
      <div className="text-sm">
        <span className="mb-1 block text-muted-foreground">Current (baseline)</span>
        <Select value={baselineId ?? undefined} onValueChange={(v) => set('baseline', v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select a baseline…" />
          </SelectTrigger>
          <SelectContent>
            {baselines.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name} · {shortDate(r.created_at)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="text-sm">
        <span className="mb-1 block text-muted-foreground">Optimized run</span>
        <Select value={optimizedId ?? undefined} onValueChange={(v) => set('optimized', v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select an optimized run…" />
          </SelectTrigger>
          <SelectContent>
            {optimized.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name} · {shortDate(r.created_at)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
