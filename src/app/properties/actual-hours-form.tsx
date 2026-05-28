'use client';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { uploadActualHours, type ActualHoursUploadResult } from './actual-hours-actions';

export function ActualHoursForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActualHoursUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Actual hours</CardTitle>
        <CardDescription>
          Upload measured <strong>average hours per week</strong> per job. Start from the{' '}
          <a href="/properties/actual-hours-template" className="text-primary underline-offset-2 hover:underline">
            pre-filled template
          </a>{' '}
          (all active properties with their IDs) — fill the <code>actual_hours_per_week</code> column and upload it back.
          When an actual diverges from the budgeted hours by more than 15%, scheduling uses the actual; the budget is kept
          otherwise. Matched by Aspire <code>external_id</code> (or name).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={(fd) => {
            setResult(null);
            setError(null);
            startTransition(async () => {
              try {
                const r = await uploadActualHours(fd);
                if (r.ok) setResult(r);
                else setError(r.error ?? 'Upload failed');
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Upload failed (network or server error)');
              }
            });
          }}
          className="flex items-center gap-3"
        >
          <input
            type="file"
            name="file"
            accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
          />
          <Button type="submit" disabled={pending}>
            {pending ? 'Uploading…' : 'Upload'}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {result && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-muted-foreground">
                <strong>{result.parsed ?? 0}</strong> values read
              </span>
              <span>
                <strong>{result.updated}</strong> properties updated
              </span>
              {!!result.skippedRows && (
                <span className="text-amber-700">
                  <strong>{result.skippedRows}</strong> malformed rows skipped
                </span>
              )}
              {!!result.unmatched?.length && (
                <span className="text-amber-700">
                  <strong>{result.unmatched.length}</strong> unmatched
                </span>
              )}
            </div>
            {!!result.unmatched?.length && (
              <p className="text-muted-foreground">
                No active property matched: {result.unmatched.slice(0, 8).join(', ')}
                {result.unmatched.length > 8 ? ` … (+${result.unmatched.length - 8})` : ''}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
