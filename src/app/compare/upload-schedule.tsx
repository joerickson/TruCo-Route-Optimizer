'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { uploadAndScoreSchedule } from './actions';

// Upload + score lives behind a dialog so the comparison itself leads the page.
// On success we route to the run page, which polls until the baseline finishes
// scoring (a baseline can't be compared until it's `completed`).
export function UploadScheduleButton({ defaultWeek }: { defaultWeek: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload className="mr-1.5 h-4 w-4" />
        Upload schedule
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload current schedule</DialogTitle>
            <DialogDescription>
              A CSV/XLSX keyed by <code>External ID</code> with <code>Crew</code> and <code>Day</code>{' '}
              columns. Properties must already exist (from an Aspire import). Scoring runs the same
              solver in evaluate mode and creates a baseline run.{' '}
              <a href="/compare/schedule-template" className="text-primary underline-offset-2 hover:underline">
                Download a pre-filled template
              </a>{' '}
              (your active properties with blank Crew/Day to fill).
            </DialogDescription>
          </DialogHeader>
          <form
            action={(fd) => {
              setError(null);
              startTransition(async () => {
                try {
                  const r = await uploadAndScoreSchedule(fd);
                  if (r.ok) {
                    setOpen(false);
                    router.push(`/runs/${r.run_id}`);
                  } else {
                    setError(r.error);
                  }
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Upload failed');
                }
              });
            }}
            className="space-y-4"
          >
            <div>
              <Label htmlFor="name">Baseline name</Label>
              <Input id="name" name="name" placeholder="Current schedule — June 2026" />
            </div>
            <div>
              <Label htmlFor="target_week_start_date">Week starting (Monday)</Label>
              <Input
                id="target_week_start_date"
                name="target_week_start_date"
                type="date"
                defaultValue={defaultWeek}
                required
              />
            </div>
            <div>
              <Label htmlFor="schedule_file">Schedule file</Label>
              <input
                id="schedule_file"
                type="file"
                name="file"
                required
                accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? 'Scoring…' : 'Upload & score'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
