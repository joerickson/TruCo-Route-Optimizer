'use client';
import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { importAspireCsv, geocodePending } from './actions';

export function ImportForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [geoResult, setGeoResult] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aspire CSV import</CardTitle>
        <CardDescription>
          Upload an Aspire export. Columns expected: <code>Property</code>, <code>Property Address 1</code>,{' '}
          <code>Property City</code>, <code>Service Abr</code>, <code>Est Hrs</code>, <code>Opportunity Start Date</code>,{' '}
          <code>Opportunity End Date</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          action={(fd) => {
            setResult(null);
            startTransition(async () => {
              const r = await importAspireCsv(fd);
              if (r.ok) {
                setResult(
                  `Imported. Inserted ${r.inserted ?? 0}, upserted ${r.upserted ?? 0}.${
                    r.errorCount ? ` ${r.errorCount} errors skipped.` : ''
                  }`
                );
              } else {
                setResult(`Error: ${r.error}`);
              }
            });
          }}
          className="flex items-center gap-3"
        >
          <input
            type="file"
            name="file"
            accept=".csv"
            required
            className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
          />
          <Button type="submit" disabled={pending}>
            {pending ? 'Importing…' : 'Import'}
          </Button>
        </form>
        {result && <p className="text-sm">{result}</p>}

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
