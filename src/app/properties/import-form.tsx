'use client';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { importAspireCsv, geocodePending, type ImportSummary } from './actions';

export function ImportForm() {
  const [pending, startTransition] = useTransition();
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geoResult, setGeoResult] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aspire import</CardTitle>
        <CardDescription>
          Upload an Aspire export (.xlsx or .csv). Columns expected: <code>Property</code>,{' '}
          <code>Property Address 1</code>, <code>Property City</code>, <code>Service Abr</code>, <code>Est Hrs</code>,{' '}
          <code>Opportunity Start Date</code>, <code>Opportunity End Date</code>. Re-uploading is safe — existing properties
          (matched by external ID, or by name + address) are updated rather than duplicated. Not sure of the format?{' '}
          <a href="/properties/aspire-template" className="text-primary underline-offset-2 hover:underline">
            Download a template
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={(fd) => {
            setSummary(null);
            setError(null);
            startTransition(async () => {
              try {
                const r = await importAspireCsv(fd);
                if (r.ok) setSummary(r);
                else setError(r.error);
              } catch (e) {
                // Catches network failures, server crashes, function timeouts —
                // anything that prevents the action from returning a structured result.
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
            {pending ? 'Importing…' : 'Import'}
          </Button>
        </form>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {summary && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                <strong>{summary.inserted}</strong> inserted
              </span>
              <span>
                <strong>{summary.updated}</strong> updated
              </span>
              <span className={summary.skipped > 0 ? 'text-amber-700' : ''}>
                <strong>{summary.skipped}</strong> skipped
              </span>
            </div>
            {summary.skipped > 0 && (
              <div className="mt-2">
                <Link
                  href={`/properties/imports/${summary.import_run_id}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  View skipped rows →
                </Link>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-3 border-t pt-4">
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => {
              setGeoResult(null);
              startTransition(async () => {
                const r = await geocodePending(100);
                setGeoResult(
                  r.ok
                    ? `Geocoded ${r.processed ?? 0} properties (${r.failed ?? 0} failures). Run again for the next batch.`
                    : `Error: ${r.error}`
                );
              });
            }}
          >
            Geocode pending (batch of 100)
          </Button>
          {geoResult && <p className="text-sm">{geoResult}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
