'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { startOptimization } from './actions';

export function OptimizeForm({ defaultWeek, ready }: { defaultWeek: string; ready: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const result = await startOptimization(fd);
          if (result.ok) {
            router.push(`/runs/${result.run_id}`);
          } else {
            setError(result.error ?? 'Failed to start optimization');
          }
        });
      }}
      className="grid gap-4 md:grid-cols-3"
    >
      <div className="md:col-span-2">
        <Label htmlFor="name">Run name</Label>
        <Input id="name" name="name" placeholder="Peak Summer Week 2026" />
      </div>
      <div>
        <Label htmlFor="target_week_start_date">Week starting (Monday)</Label>
        <Input id="target_week_start_date" name="target_week_start_date" type="date" defaultValue={defaultWeek} required />
      </div>
      <div className="md:col-span-3 flex items-center gap-3">
        <Button type="submit" disabled={!ready || pending}>
          {pending ? 'Starting…' : 'Run optimizer'}
        </Button>
        {!ready && (
          <p className="text-sm text-muted-foreground">
            Need at least one branch, one crew, and one geocoded property to run.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </form>
  );
}
