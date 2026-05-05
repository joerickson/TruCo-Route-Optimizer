'use client';
import { useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Crew, Branch } from '@/lib/types';
import { createCrew, updateCrew } from './actions';

const DAY_KEYS = [
  'works_monday',
  'works_tuesday',
  'works_wednesday',
  'works_thursday',
  'works_friday',
  'works_saturday',
  'works_sunday',
] as const;

const DAY_LABELS = ['M', 'T', 'W', 'Th', 'F', 'Sa', 'Su'] as const;

type DayState = Record<(typeof DAY_KEYS)[number], boolean>;

export interface CrewFormProps {
  crew?: Crew | null;
  branches: Pick<Branch, 'id' | 'name' | 'is_active'>[];
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function CrewForm({ crew, branches, onSuccess, onCancel }: CrewFormProps) {
  const isEdit = Boolean(crew);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [active, setActive] = useState<boolean>(crew?.is_active ?? true);
  const [days, setDays] = useState<DayState>(() =>
    crew
      ? {
          works_monday: crew.works_monday,
          works_tuesday: crew.works_tuesday,
          works_wednesday: crew.works_wednesday,
          works_thursday: crew.works_thursday,
          works_friday: crew.works_friday,
          works_saturday: crew.works_saturday,
          works_sunday: crew.works_sunday,
        }
      : {
          works_monday: true,
          works_tuesday: true,
          works_wednesday: true,
          works_thursday: true,
          works_friday: true,
          works_saturday: false,
          works_sunday: false,
        }
  );

  const formRef = useRef<HTMLFormElement>(null);

  const activeBranches = branches.filter((b) => b.is_active);

  return (
    <form
      ref={formRef}
      action={(fd) => {
        setError(null);
        // Inject controlled state — Switch and chip-buttons don't submit by default.
        fd.set('is_active', active ? 'on' : 'false');
        for (const k of DAY_KEYS) fd.set(k, days[k] ? 'on' : 'false');

        startTransition(async () => {
          const result = isEdit ? await updateCrew(crew!.id, fd) : await createCrew(fd);
          if (result.ok) {
            if (!isEdit) formRef.current?.reset();
            onSuccess?.();
          } else {
            setError(result.error);
          }
        });
      }}
      className="grid gap-4 md:grid-cols-2"
    >
      <div className="md:col-span-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" defaultValue={crew?.name ?? ''} placeholder="Crew 1" required />
      </div>

      <div>
        <Label htmlFor="crew_size">Crew size (people)</Label>
        <Input
          id="crew_size"
          name="crew_size"
          type="number"
          min={1}
          max={10}
          step={1}
          defaultValue={crew?.crew_size ?? 2}
        />
      </div>

      <div>
        <Label htmlFor="max_clock_hours_per_day">Max hours / day</Label>
        <Input
          id="max_clock_hours_per_day"
          name="max_clock_hours_per_day"
          type="number"
          min={1}
          max={16}
          step={0.5}
          defaultValue={crew?.max_clock_hours_per_day ?? 8}
        />
      </div>

      <div className="md:col-span-2">
        <Label htmlFor="home_branch_id">Home branch</Label>
        <select
          id="home_branch_id"
          name="home_branch_id"
          defaultValue={crew?.home_branch_id ?? activeBranches[0]?.id ?? ''}
          required
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {activeBranches.length === 0 && <option value="">No active branches — add one first</option>}
          {activeBranches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="md:col-span-2">
        <Label>Working days</Label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {DAY_KEYS.map((k, i) => (
            <button
              key={k}
              type="button"
              onClick={() => setDays((prev) => ({ ...prev, [k]: !prev[k] }))}
              className={cn(
                'h-9 min-w-[2.5rem] rounded-md border px-2 text-sm font-medium transition-colors',
                days[k]
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input bg-background text-muted-foreground hover:bg-accent'
              )}
            >
              {DAY_LABELS[i]}
            </button>
          ))}
        </div>
      </div>

      <div className="md:col-span-2 flex items-center gap-3">
        <Switch id="is_active" checked={active} onCheckedChange={setActive} />
        <Label htmlFor="is_active" className="cursor-pointer">
          Active
        </Label>
      </div>

      <div className="md:col-span-2">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" name="notes" defaultValue={crew?.notes ?? ''} rows={2} />
      </div>

      {error && (
        <div className="md:col-span-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="md:col-span-2 flex items-center justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending || activeBranches.length === 0}>
          {pending ? (isEdit ? 'Saving…' : 'Adding…') : isEdit ? 'Save changes' : 'Add crew'}
        </Button>
      </div>
    </form>
  );
}
