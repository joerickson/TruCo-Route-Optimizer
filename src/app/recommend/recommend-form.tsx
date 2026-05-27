'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { startRecommendation } from './actions';

export function RecommendForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const r = await startRecommendation(fd);
          if (r.ok) router.refresh();
          else setError(r.error);
        });
      }}
      className="flex items-end gap-3"
    >
      <div>
        <Label htmlFor="name">Recommendation name</Label>
        <Input id="name" name="name" placeholder="Fleet plan — June 2026" />
      </div>
      <Button type="submit" disabled={pending}>{pending ? 'Starting…' : 'Recommend fleet'}</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
