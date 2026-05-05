'use client';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CrewForm } from './crew-form';
import type { Branch } from '@/lib/types';

export function AddCrewButton({ branches }: { branches: Pick<Branch, 'id' | 'name' | 'is_active'>[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-4 w-4" />
        Add crew
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add crew</DialogTitle>
            <DialogDescription>
              Configure name, size, home branch, working days, and max hours per day.
            </DialogDescription>
          </DialogHeader>
          <CrewForm branches={branches} onSuccess={() => setOpen(false)} onCancel={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
