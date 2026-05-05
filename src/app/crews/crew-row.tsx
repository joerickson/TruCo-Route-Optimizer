'use client';
import { useState, useTransition } from 'react';
import { TableCell, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CrewForm } from './crew-form';
import { deactivateCrew, reactivateCrew } from './actions';
import type { Crew, Branch } from '@/lib/types';

const DAYS: Array<[keyof Crew, string]> = [
  ['works_monday', 'M'],
  ['works_tuesday', 'T'],
  ['works_wednesday', 'W'],
  ['works_thursday', 'Th'],
  ['works_friday', 'F'],
  ['works_saturday', 'Sa'],
  ['works_sunday', 'Su'],
];

export function CrewRow({
  crew,
  branchName,
  branches,
}: {
  crew: Crew;
  branchName: string;
  branches: Pick<Branch, 'id' | 'name' | 'is_active'>[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <TableRow className={crew.is_active ? '' : 'opacity-60'}>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {crew.name}
            {!crew.is_active && <Badge variant="secondary">inactive</Badge>}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant={crew.crew_size >= 3 ? 'default' : 'secondary'}>{crew.crew_size}p</Badge>
        </TableCell>
        <TableCell>{branchName}</TableCell>
        <TableCell className="font-mono text-xs">
          {DAYS.map(([k, label]) => (
            <span
              key={k}
              className={crew[k] ? 'mr-1 text-foreground' : 'mr-1 text-muted-foreground/40 line-through'}
            >
              {label}
            </span>
          ))}
        </TableCell>
        <TableCell>{Number(crew.max_clock_hours_per_day).toFixed(1)}</TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={
                crew.is_active
                  ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
                  : ''
              }
              onClick={() => {
                setConfirmError(null);
                setConfirmOpen(true);
              }}
            >
              {crew.is_active ? 'Deactivate' : 'Reactivate'}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit crew</DialogTitle>
            <DialogDescription>
              Changes apply to future optimization runs. Past run results are preserved.
            </DialogDescription>
          </DialogHeader>
          <CrewForm
            crew={crew}
            branches={branches}
            onSuccess={() => setEditOpen(false)}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {crew.is_active ? 'Deactivate' : 'Reactivate'} &ldquo;{crew.name}&rdquo;?
            </DialogTitle>
            <DialogDescription>
              {crew.is_active ? (
                <>
                  The crew will be excluded from future optimizations. Past run results that include this crew are
                  preserved. You can reactivate later.
                </>
              ) : (
                <>The crew will be included in future optimizations.</>
              )}
            </DialogDescription>
          </DialogHeader>

          {confirmError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {confirmError}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant={crew.is_active ? 'destructive' : 'default'}
              disabled={pending}
              onClick={() => {
                setConfirmError(null);
                startTransition(async () => {
                  const result = crew.is_active ? await deactivateCrew(crew.id) : await reactivateCrew(crew.id);
                  if (result.ok) setConfirmOpen(false);
                  else setConfirmError(result.error);
                });
              }}
            >
              {pending
                ? crew.is_active
                  ? 'Deactivating…'
                  : 'Reactivating…'
                : crew.is_active
                  ? 'Deactivate crew'
                  : 'Reactivate crew'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
