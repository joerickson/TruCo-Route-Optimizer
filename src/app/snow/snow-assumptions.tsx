'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { updateSnowSettings } from './actions';

export interface TierRow {
  tier: string;
  plowHours: number;
}

// Editable snow-bid assumptions: design window, flat sidewalk time, per-tier plow hours.
// Saving persists to the scenario + snow_tier_rates and refreshes the server-rendered
// results below it.
export function SnowAssumptions({
  windowHours,
  sidewalkHours,
  tiers,
}: {
  windowHours: number;
  sidewalkHours: number;
  tiers: TierRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [win, setWin] = useState(String(windowHours));
  const [walk, setWalk] = useState(String(sidewalkHours));
  const [rows, setRows] = useState<TierRow[]>(tiers);

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const tierPlowHours: Record<string, number> = {};
      for (const r of rows) tierPlowHours[r.tier] = Number(r.plowHours);
      const res = await updateSnowSettings({
        windowHours: Number(win),
        sidewalkHours: Number(walk),
        tierPlowHours,
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assumptions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="snow_window">Design window (hours before open)</Label>
            <Input
              id="snow_window"
              type="number"
              min="0.5"
              step="0.5"
              value={win}
              onChange={(e) => setWin(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="snow_sidewalk">Sidewalk time per property (hours)</Label>
            <Input
              id="snow_sidewalk"
              type="number"
              min="0"
              step="0.25"
              value={walk}
              onChange={(e) => setWalk(e.target.value)}
            />
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">Plow hours per tier</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {rows.map((r, i) => (
              <div key={r.tier}>
                <Label htmlFor={`tier_${r.tier}`}>Tier {r.tier}</Label>
                <Input
                  id={`tier_${r.tier}`}
                  type="number"
                  min="0"
                  step="0.25"
                  value={String(r.plowHours)}
                  onChange={(e) =>
                    setRows((prev) => prev.map((x, j) => (j === i ? { ...x, plowHours: Number(e.target.value) } : x)))
                  }
                />
              </div>
            ))}
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No tiers found yet — import properties with a Tier column first.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save & recalculate'}
          </Button>
          {saved && !pending && <span className="text-sm text-green-700">Saved.</span>}
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
