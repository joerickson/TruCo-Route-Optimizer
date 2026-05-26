'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { uploadAndScoreSchedule } from './actions';

export function UploadSchedule({ defaultWeek }: { defaultWeek: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload current schedule</CardTitle>
        <CardDescription>
          A CSV/XLSX keyed by <code>External ID</code> with <code>Crew</code> and <code>Day</code> columns. Properties must
          already exist (from an Aspire import). Scoring runs the same solver in evaluate mode and creates a baseline run.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={(fd) => {
            setError(null);
            startTransition(async () => {
              try {
                const r = await uploadAndScoreSchedule(fd);
                if (r.ok) router.push(`/compare?baseline=${r.run_id}`);
                else setError(r.error);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Upload failed');
              }
            });
          }}
          className="grid gap-4 md:grid-cols-3"
        >
          <div className="md:col-span-2">
            <Label htmlFor="name">Baseline name</Label>
            <Input id="name" name="name" placeholder="Current schedule — June 2026" />
          </div>
          <div>
            <Label htmlFor="target_week_start_date">Week starting (Monday)</Label>
            <Input id="target_week_start_date" name="target_week_start_date" type="date" defaultValue={defaultWeek} required />
          </div>
          <div className="md:col-span-3 flex items-center gap-3">
            <Label htmlFor="schedule_file" className="sr-only">Schedule file</Label>
            <input
              id="schedule_file"
              type="file" name="file" required
              accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
            />
            <Button type="submit" disabled={pending}>{pending ? 'Scoring…' : 'Upload & score'}</Button>
          </div>
          {error && <p className="md:col-span-3 text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
