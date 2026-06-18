'use client';
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { importAspireCsv, previewColumns, geocodePending, type ImportSummary } from './actions';
import { EMPTY_MAPPING, REQUIRED_MAPPING_FIELDS, type ColumnMapping } from '@/lib/csv-import';

// Display order + labels for the mapping UI. Required fields are flagged.
const FIELDS: { key: keyof ColumnMapping; label: string }[] = [
  { key: 'name', label: 'Property name' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'external_id', label: 'External ID' },
  { key: 'service_type', label: 'Service frequency' },
  { key: 'est_labor_hours', label: 'Est. labor hours' },
  { key: 'contract_start_date', label: 'Contract start' },
  { key: 'contract_end_date', label: 'Contract end' },
  { key: 'assigned_crew', label: 'Crew' },
  { key: 'assigned_day', label: 'Service day' },
  { key: 'notes', label: 'Notes' },
];

const REQUIRED = new Set<keyof ColumnMapping>(REQUIRED_MAPPING_FIELDS);

export function ImportForm() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewing, startPreview] = useTransition();
  const [importing, startImport] = useTransition();
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(EMPTY_MAPPING);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geoResult, setGeoResult] = useState<string | null>(null);

  const requiredMissing = [...REQUIRED].filter((k) => !mapping[k]);
  const canImport = headers != null && requiredMissing.length === 0;

  function resetMapping() {
    setHeaders(null);
    setMapping(EMPTY_MAPPING);
    setSummary(null);
    setError(null);
  }

  function handlePreview() {
    setError(null);
    setSummary(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    startPreview(async () => {
      try {
        const r = await previewColumns(fd);
        if (r.ok) {
          setHeaders(r.headers);
          setMapping(r.suggested);
        } else {
          setError(r.error);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read the file');
      }
    });
  }

  function handleImport() {
    setError(null);
    setSummary(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mapping', JSON.stringify(mapping));
    startImport(async () => {
      try {
        const r = await importAspireCsv(fd);
        if (r.ok) setSummary(r);
        else setError(r.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed (network or server error)');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import properties</CardTitle>
        <CardDescription>
          Upload a spreadsheet (.xlsx or .csv), then map your columns to ours. Only <strong>name</strong>,{' '}
          <strong>address</strong>, and <strong>city</strong> are required — that&apos;s enough to geocode and map
          each property for a bid. Everything else is optional. Re-uploading is safe — existing properties (matched by
          external ID, or by name + address) are updated rather than duplicated.{' '}
          <a href="/properties/aspire-template" className="text-primary underline-offset-2 hover:underline">
            Download the Aspire template
          </a>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            name="file"
            accept=".csv,.xlsx,.xls,.xlsm,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            required
            onChange={resetMapping}
            className="block text-sm file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-sm file:font-medium file:text-secondary-foreground hover:file:bg-secondary/80"
          />
          {headers == null ? (
            <Button type="button" onClick={handlePreview} disabled={previewing}>
              {previewing ? 'Reading…' : 'Preview columns'}
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={resetMapping} disabled={importing}>
              Choose different file
            </Button>
          )}
        </div>

        {headers != null && (
          <div className="space-y-4 rounded-md border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              Map each field to a column from your file. <span className="text-destructive">*</span> required.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FIELDS.map((f) => {
                const isRequired = REQUIRED.has(f.key);
                const missing = isRequired && !mapping[f.key];
                return (
                  <div key={f.key}>
                    <Label htmlFor={`map_${f.key}`}>
                      {f.label}
                      {isRequired && <span className="text-destructive"> *</span>}
                    </Label>
                    <select
                      id={`map_${f.key}`}
                      value={mapping[f.key] ?? ''}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [f.key]: e.target.value === '' ? null : e.target.value }))
                      }
                      className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${
                        missing ? 'border-destructive' : ''
                      }`}
                    >
                      <option value="">{isRequired ? '— select a column —' : '— none —'}</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={handleImport} disabled={!canImport || importing}>
                {importing ? 'Importing…' : 'Import'}
              </Button>
              {requiredMissing.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  Map all required fields to enable import.
                </p>
              )}
            </div>
          </div>
        )}

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
            disabled={importing || previewing}
            onClick={() => {
              setGeoResult(null);
              startImport(async () => {
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
