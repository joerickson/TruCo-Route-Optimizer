'use client';
import { useState, useTransition, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createBranch } from './actions';

export function BranchForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const result = await createBranch(fd);
          if (result.ok) {
            formRef.current?.reset();
          } else {
            setError(result.error ?? 'Failed to create branch');
          }
        });
      }}
      className="grid gap-4 md:grid-cols-2"
    >
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" placeholder="Salt Lake City HQ" required />
      </div>
      <div>
        <Label htmlFor="address">Street address</Label>
        <Input id="address" name="address" placeholder="2120 S 700 W" required />
      </div>
      <div>
        <Label htmlFor="city">City</Label>
        <Input id="city" name="city" required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="state">State</Label>
          <Input id="state" name="state" defaultValue="UT" />
        </div>
        <div>
          <Label htmlFor="postal_code">Postal</Label>
          <Input id="postal_code" name="postal_code" />
        </div>
      </div>
      <div className="md:col-span-2 flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add branch'}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </form>
  );
}
