'use client';
import { useRef, useState, useTransition } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import type { Property, ServiceType } from '@/lib/types';
import { updateProperty } from './actions';

const SERVICE_LABELS: Record<ServiceType, string> = {
  weekly: 'Weekly MT',
  biweekly: 'Bi-Weekly',
  monthly: 'Monthly MT',
};

export function PropertyEditForm({ property }: { property: Property }) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  if (!editing) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight">{property.name}</h1>
            <p className="text-sm text-muted-foreground">
              {property.address} · {property.city}, {property.state} {property.postal_code ?? ''}
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2 text-sm">
              <Badge variant="secondary">{SERVICE_LABELS[property.service_type]}</Badge>
              <span>
                <strong>{property.est_labor_hours.toFixed(1)}</strong> labor hrs / visit
              </span>
              {(property.contract_start_date || property.contract_end_date) && (
                <span className="text-muted-foreground">
                  Contract: {property.contract_start_date ?? '—'} → {property.contract_end_date ?? '—'}
                </span>
              )}
            </div>
            {property.notes && (
              <div className="pt-3 text-sm">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Notes</div>
                <div className="mt-1 whitespace-pre-wrap">{property.notes}</div>
              </div>
            )}
            {warning && (
              <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {warning}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" />
            Edit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6">
      <form
        ref={formRef}
        action={(fd) => {
          setError(null);
          setWarning(null);
          startTransition(async () => {
            try {
              const result = await updateProperty(property.id, fd);
              if (result.ok) {
                if (result.warning) setWarning(result.warning);
                setEditing(false);
              } else {
                setError(result.error);
              }
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Save failed (network error)');
            }
          });
        }}
        className="grid gap-4 md:grid-cols-2"
      >
        <div className="md:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" defaultValue={property.name} required />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="address">Address</Label>
          <Input id="address" name="address" defaultValue={property.address} required />
        </div>
        <div>
          <Label htmlFor="city">City</Label>
          <Input id="city" name="city" defaultValue={property.city} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="state">State</Label>
            <Input id="state" name="state" defaultValue={property.state} />
          </div>
          <div>
            <Label htmlFor="postal_code">Postal</Label>
            <Input id="postal_code" name="postal_code" defaultValue={property.postal_code ?? ''} />
          </div>
        </div>
        <div>
          <Label htmlFor="service_type">Service type</Label>
          <select
            id="service_type"
            name="service_type"
            defaultValue={property.service_type}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="weekly">Weekly MT</option>
            <option value="biweekly">Bi-Weekly</option>
            <option value="monthly">Monthly MT</option>
          </select>
        </div>
        <div>
          <Label htmlFor="est_labor_hours">Est labor hours / visit</Label>
          <Input
            id="est_labor_hours"
            name="est_labor_hours"
            type="number"
            min={0.25}
            step={0.25}
            defaultValue={property.est_labor_hours}
            required
          />
        </div>
        <div>
          <Label htmlFor="contract_start_date">Contract start</Label>
          <Input
            id="contract_start_date"
            name="contract_start_date"
            type="date"
            defaultValue={property.contract_start_date ?? ''}
          />
        </div>
        <div>
          <Label htmlFor="contract_end_date">Contract end</Label>
          <Input
            id="contract_end_date"
            name="contract_end_date"
            type="date"
            defaultValue={property.contract_end_date ?? ''}
          />
        </div>
        <div className="md:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" defaultValue={property.notes ?? ''} rows={3} />
        </div>

        {error && (
          <div className="md:col-span-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="md:col-span-2 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
        <p className="md:col-span-2 text-xs text-muted-foreground">
          Changing the address will trigger a re-geocode. If geocoding fails, the address is saved with empty
          coordinates and the property is excluded from the map and optimizer until corrected.
        </p>
      </form>
    </div>
  );
}
