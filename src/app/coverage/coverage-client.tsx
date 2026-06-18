'use client';
import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { sitesWithinRadius } from '@/lib/coverage';
import type { MapBranch, MapProperty } from '../properties/properties-map';
import { CoverageMapLoader } from './coverage-map-loader';

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function CoverageClient({ branches, properties }: { branches: MapBranch[]; properties: MapProperty[] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>(branches.map((b) => b.id));
  const [radius, setRadius] = useState<number>(25);
  const branchIds = useMemo(() => branches.map((b) => b.id), [branches]);
  const selectedBranchIds = useMemo(() => {
    const branchIdSet = new Set(branchIds);
    const retained = selectedIds.filter((id) => branchIdSet.has(id));
    return retained.length === 0 && selectedIds.length > 0 ? branchIds : retained;
  }, [branchIds, selectedIds]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const branchIdSet = new Set(branchIds);
      const retained = prev.filter((id) => branchIdSet.has(id));
      const next = retained.length === 0 && prev.length > 0 ? branchIds : retained;
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [branchIds]);

  const matches = useMemo(
    () => sitesWithinRadius(properties, branches, selectedBranchIds, radius),
    [properties, branches, selectedBranchIds, radius]
  );
  const matchedIds = useMemo(() => new Set(matches.map((m) => m.property.id)), [matches]);

  function toggleBranch(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function updateRadius(value: string) {
    const next = Number(value);
    setRadius(Number.isFinite(next) ? Math.max(0, next) : 0);
  }

  function downloadCsv() {
    const header = ['Name', 'Address', 'City', 'Nearest Branch', 'Distance (mi)'];
    const rows = matches.map((m) => [
      m.property.name,
      m.property.address,
      m.property.city,
      m.nearestBranchName,
      m.distanceMiles.toFixed(1),
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bid-area-sites.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Service area</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-32">
              <Label htmlFor="radius">Radius (miles)</Label>
              <Input
                id="radius"
                type="number"
                min="1"
                value={radius}
                onChange={(e) => updateRadius(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {branches.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No branches in this scenario yet — add offices on the Branches page first.
                </p>
              )}
              {branches.map((b) => {
                const on = selectedBranchIds.includes(b.id);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => toggleBranch(b.id)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                      on ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {b.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <p className="text-sm">
              <strong>{matches.length}</strong> site{matches.length === 1 ? '' : 's'} within {radius} mi of{' '}
              {selectedBranchIds.length} branch{selectedBranchIds.length === 1 ? '' : 'es'} (straight-line)
            </p>
            <Button type="button" variant="outline" onClick={downloadCsv} disabled={matches.length === 0}>
              Download CSV
            </Button>
          </div>
        </CardContent>
      </Card>

      <CoverageMapLoader
        properties={properties}
        branches={branches}
        selectedBranchIds={selectedBranchIds}
        radiusMiles={radius}
        matchedIds={matchedIds}
      />

      <Card>
        <CardHeader>
          <CardTitle>Matching sites ({matches.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Nearest branch</TableHead>
                <TableHead className="text-right">Distance (mi)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {matches.map((m) => (
                <TableRow key={m.property.id}>
                  <TableCell className="font-medium">{m.property.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.property.address}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.property.city}</TableCell>
                  <TableCell className="text-sm">{m.nearestBranchName}</TableCell>
                  <TableCell className="text-right tabular-nums">{m.distanceMiles.toFixed(1)}</TableCell>
                </TableRow>
              ))}
              {matches.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Select one or more branches and a radius to see matching sites.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
