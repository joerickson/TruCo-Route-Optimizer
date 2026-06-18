'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createScenario, deleteScenario } from './actions';

export function CreateScenarioForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const r = await createScenario(fd);
          if (r.ok) router.refresh();
          else setError(r.error);
        });
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <div>
        <Label htmlFor="name">New scenario name</Label>
        <Input id="name" name="name" placeholder="Park City Bid" />
      </div>
      <div className="min-w-[16rem] flex-1">
        <Label htmlFor="description">Description (optional)</Label>
        <Input id="description" name="description" placeholder="Prospective 2027 contract" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create scenario'}
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}

export function DeleteScenarioButton({ id, isDefault }: { id: string; isDefault: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (isDefault) return <span className="text-xs text-muted-foreground">default</span>;
  return (
    <form
      action={(fd) => {
        if (!confirm('Delete this scenario and ALL its properties, crews, branches, and runs?')) return;
        startTransition(async () => {
          const r = await deleteScenario(fd);
          if (r.ok) router.refresh();
          else alert(r.error);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? 'Deleting…' : 'Delete'}
      </Button>
    </form>
  );
}
