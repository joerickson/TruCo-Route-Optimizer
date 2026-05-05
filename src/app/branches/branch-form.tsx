'use client';
import { useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { Branch } from '@/lib/types';
import { createBranch, updateBranch } from './actions';

export interface BranchFormProps {
  branch?: Branch | null;
  onSuccess?: () => void;
  onCancel?: () => void;
  submitLabel?: string;
}

export function BranchForm({ branch, onSuccess, onCancel, submitLabel }: BranchFormProps) {
  const isEdit = Boolean(branch);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [active, setActive] = useState<boolean>(branch?.is_active ?? true);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={(fd) => {
        setError(null);
        setWarning(null);
        // Switch state isn't included in FormData by default; inject it.
        fd.set('is_active', active ? 'on' : 'false');
        startTransition(async () => {
          const result = isEdit ? await updateBranch(branch!.id, fd) : await createBranch(fd);
          if (result.ok) {
            if (result.warning) {
              setWarning(result.warning);
              // For create-with-warning, reset the form so the user can try again or close.
              if (!isEdit) formRef.current?.reset();
            } else {
              if (!isEdit) formRef.current?.reset();
              onSuccess?.();
            }
          } else {
            setError(result.error);
          }
        });
      }}
      className="grid gap-4 md:grid-cols-2"
    >
      <div className="md:col-span-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={branch?.name ?? ''} placeholder="Salt Lake City HQ" required />
      </div>
      <div className="md:col-span-2">
        <Label htmlFor="address">Street address</Label>
        <Input id="address" name="address" defaultValue={branch?.address ?? ''} placeholder="2120 S 700 W" required />
      </div>
      <div>
        <Label htmlFor="city">City</Label>
        <Input id="city" name="city" defaultValue={branch?.city ?? ''} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="state">State</Label>
          <Input id="state" name="state" defaultValue={branch?.state ?? 'UT'} />
        </div>
        <div>
          <Label htmlFor="postal_code">Postal</Label>
          <Input id="postal_code" name="postal_code" defaultValue={branch?.postal_code ?? ''} />
        </div>
      </div>
      <div className="md:col-span-2 flex items-center gap-3">
        <Switch id="is_active" checked={active} onCheckedChange={setActive} />
        <Label htmlFor="is_active" className="cursor-pointer">
          Active
        </Label>
      </div>

      {error && (
        <div className="md:col-span-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      {warning && (
        <div className="md:col-span-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {warning}
        </div>
      )}

      <div className="md:col-span-2 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? (isEdit ? 'Saving…' : 'Adding…') : submitLabel ?? (isEdit ? 'Save changes' : 'Add branch')}
        </Button>
        {warning && !pending && (
          <Button type="button" variant="outline" onClick={onSuccess}>
            Done
          </Button>
        )}
      </div>
    </form>
  );
}
