'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { applyUnassignedFix } from './fix-actions';

export function ApplyFixButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const r = await applyUnassignedFix(runId);
            if (r.ok) router.push(`/runs/${r.run_id}`);
            else setError(r.error);
          })
        }
        disabled={pending}
      >
        {pending ? 'Applying…' : 'Apply fix & re-optimize'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
