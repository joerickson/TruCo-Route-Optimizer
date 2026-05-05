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
import { BranchForm } from './branch-form';
import { deleteBranch } from './actions';
import type { Branch } from '@/lib/types';

export function BranchRow({ branch, crewCount }: { branch: Branch; crewCount: number }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [assignedCrews, setAssignedCrews] = useState<Array<{ id: string; name: string }>>([]);
  const [pending, startTransition] = useTransition();

  const hasCoords = branch.lat != null && branch.lng != null;

  return (
    <>
      <TableRow className={branch.is_active ? '' : 'opacity-60'}>
        <TableCell className="font-medium">
          <div className="flex items-center gap-2">
            {branch.name}
            {!branch.is_active && <Badge variant="secondary">inactive</Badge>}
            {!hasCoords && <Badge variant="warning">no coords</Badge>}
          </div>
        </TableCell>
        <TableCell className="text-muted-foreground">{branch.address}</TableCell>
        <TableCell>
          {branch.city}, {branch.state} {branch.postal_code ?? ''}
        </TableCell>
        <TableCell className="font-mono text-xs">
          {hasCoords
            ? `${Number(branch.lat).toFixed(4)}, ${Number(branch.lng).toFixed(4)}`
            : <span className="text-amber-700">—</span>}
        </TableCell>
        <TableCell className="text-right">
          {crewCount} {crewCount === 1 ? 'crew' : 'crews'}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                setDeleteError(null);
                setAssignedCrews([]);
                setDeleteOpen(true);
              }}
            >
              Delete
            </Button>
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit branch</DialogTitle>
            <DialogDescription>
              Address changes trigger a re-geocode. If geocoding fails, the address is saved but the branch will be excluded
              from the map and optimizer until corrected.
            </DialogDescription>
          </DialogHeader>
          <BranchForm
            branch={branch}
            onSuccess={() => setEditOpen(false)}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete branch &ldquo;{branch.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This cannot be undone.
              {crewCount > 0 && (
                <>
                  {' '}
                  <strong>
                    {crewCount} {crewCount === 1 ? 'crew is' : 'crews are'} assigned to this branch
                  </strong>{' '}
                  and will need reassignment before it can be deleted.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {deleteError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </div>
          )}

          {assignedCrews.length > 0 && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="mb-1 font-medium">Assigned crews:</div>
              <ul className="list-disc pl-5 text-muted-foreground">
                {assignedCrews.map((c) => (
                  <li key={c.id}>{c.name}</li>
                ))}
              </ul>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setDeleteError(null);
                startTransition(async () => {
                  const result = await deleteBranch(branch.id);
                  if (result.ok) {
                    setDeleteOpen(false);
                  } else {
                    setDeleteError(result.error);
                    if (result.assignedCrews) setAssignedCrews(result.assignedCrews);
                  }
                });
              }}
            >
              {pending ? 'Deleting…' : 'Delete branch'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
