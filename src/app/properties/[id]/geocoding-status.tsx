'use client';
import { useState, useTransition } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { regeocodeProperty } from './actions';

export function GeocodingStatus({
  propertyId,
  lat,
  lng,
  geocodedAt,
}: {
  propertyId: string;
  lat: number | null;
  lng: number | null;
  geocodedAt: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const hasCoords = lat != null && lng != null;
  const coordsStr = hasCoords ? `${lat!.toFixed(6)}, ${lng!.toFixed(6)}` : null;

  function copy() {
    if (!coordsStr) return;
    void navigator.clipboard.writeText(coordsStr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function regeocode() {
    setError(null);
    setSuccess(false);
    startTransition(async () => {
      try {
        const result = await regeocodeProperty(propertyId);
        if (result.ok) setSuccess(true);
        else setError(result.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Re-geocode failed');
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Geocoding</CardTitle>
            <CardDescription>
              {hasCoords ? (
                <>
                  Last geocoded:{' '}
                  {geocodedAt ? new Date(geocodedAt).toLocaleString() : <span className="italic">unknown</span>}
                </>
              ) : (
                <span className="text-amber-700">No coordinates — property is excluded from map and optimizer.</span>
              )}
            </CardDescription>
          </div>
          {hasCoords ? <Badge variant="success">geocoded</Badge> : <Badge variant="warning">missing</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
            {coordsStr ?? '— no coordinates —'}
          </code>
          {coordsStr && (
            <Button variant="ghost" size="sm" onClick={copy} title="Copy to clipboard">
              {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={regeocode} disabled={pending}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
            {pending ? 'Re-geocoding…' : 'Re-geocode'}
          </Button>
          {success && <span className="text-sm text-emerald-700">Updated.</span>}
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
