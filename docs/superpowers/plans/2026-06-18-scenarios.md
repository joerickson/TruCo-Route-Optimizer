# Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user create isolated Scenarios — each owning its own properties, crews, and branches — and optimize a branch-radius subset of a scenario's properties, all under a single login.

**Architecture:** A `scenarios` table plus a `scenario_id` FK on `properties`, `crews`, `branches`, and `optimization_runs`. Existing data backfills into a default "TruCo Portfolio" scenario. The active scenario is held in an `active_scenario_id` cookie, resolved server-side, and applied as `.eq('scenario_id', …)` on every relevant query and stamped on every insert. The optimize form gains an optional branch-anchor + radius filter that narrows the run's `active_property_ids` via the existing haversine helper.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase Postgres (`@supabase/supabase-js`/`ssr`), Vitest, Tailwind/shadcn primitives.

**Spec:** `docs/superpowers/specs/2026-06-18-scenarios-design.md`

---

## File Structure

**Create:**
- `supabase/migrations/20260618000000_scenarios.sql` — schema + backfill
- `src/lib/scenario.ts` — pure `resolveActiveScenarioId()` + server `getActiveScenarioId()`
- `src/lib/scenario.test.ts` — resolver tests
- `src/lib/property-radius.ts` — pure `filterPropertiesWithinRadius()`
- `src/lib/property-radius.test.ts` — radius tests
- `src/app/scenarios/page.tsx` — manage scenarios (list/create/rename/delete)
- `src/app/scenarios/actions.ts` — create/rename/delete/setActive server actions
- `src/app/scenarios/scenarios-ui.tsx` — client form pieces for the manage page
- `src/components/scenario-switcher.tsx` — client dropdown for the nav

**Modify:**
- `src/lib/types.ts` — add `Scenario`; add `scenario_id` to `Branch`/`Crew`/`Property`/`OptimizationRun`
- `src/app/layout.tsx` — fetch scenarios + active id, pass to nav
- `src/components/top-nav.tsx` — render the switcher; add `/scenarios` is reachable
- `src/app/optimize/optimize-form.tsx` — anchor + radius inputs
- `src/app/optimize/actions.ts` — scope by scenario + apply radius filter
- All read/write query sites listed in **Task 8** and **Task 9**

---

## Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260618000000_scenarios.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Scenarios — isolated property/crew/branch/run sets for bid analysis.

create table if not exists scenarios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamp with time zone default now()
);

-- At most one default scenario.
create unique index if not exists scenarios_one_default on scenarios (is_default) where is_default;

-- Default scenario for all pre-existing data (idempotent).
insert into scenarios (name, description, is_default)
select 'TruCo Portfolio', 'Live 30-crew SLC portfolio', true
where not exists (select 1 from scenarios where is_default);

-- Add scenario_id (nullable first so the backfill can run).
alter table properties         add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table crews              add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table branches           add column if not exists scenario_id uuid references scenarios(id) on delete cascade;
alter table optimization_runs  add column if not exists scenario_id uuid references scenarios(id) on delete cascade;

-- Backfill everything into the default scenario.
update properties        set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update crews             set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update branches          set scenario_id = (select id from scenarios where is_default) where scenario_id is null;
update optimization_runs set scenario_id = (select id from scenarios where is_default) where scenario_id is null;

-- Enforce not null now that every row has a scenario.
alter table properties        alter column scenario_id set not null;
alter table crews             alter column scenario_id set not null;
alter table branches          alter column scenario_id set not null;
alter table optimization_runs alter column scenario_id set not null;

create index if not exists properties_scenario_idx        on properties(scenario_id);
create index if not exists crews_scenario_idx             on crews(scenario_id);
create index if not exists branches_scenario_idx          on branches(scenario_id);
create index if not exists optimization_runs_scenario_idx on optimization_runs(scenario_id);
```

- [ ] **Step 2: Verify SQL parses locally (optional, if supabase CLI/psql available)**

Run: `psql "$DATABASE_URL" -f supabase/migrations/20260618000000_scenarios.sql --dry-run 2>/dev/null || echo "no local db — paste-ready SQL handed to user in Task 12"`
Expected: no syntax error, or the fallback message. Migrations are never auto-applied (see CLAUDE.md) — the paste-ready SQL is delivered in Task 12.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618000000_scenarios.sql
git commit -m "feat(db): scenarios table + scenario_id on properties/crews/branches/runs"
```

---

## Task 2: Domain types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add the `Scenario` interface**

Add near the top, after the `CapacityRecommendation` type:

```ts
export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  created_at: string;
}
```

- [ ] **Step 2: Add `scenario_id` to the four scoped interfaces**

In `Branch`, `Crew`, `Property`, and `OptimizationRun`, add this field (place it right after `id: string;`):

```ts
  scenario_id: string;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors; later tasks fix any insert/select sites the compiler flags).

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): Scenario type + scenario_id on scoped entities"
```

---

## Task 3: Scenario resolver (pure + server helper)

**Files:**
- Create: `src/lib/scenario.ts`
- Test: `src/lib/scenario.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveActiveScenarioId } from './scenario';

const scenarios = [
  { id: 'default-1', is_default: true },
  { id: 'bid-2', is_default: false },
];

describe('resolveActiveScenarioId', () => {
  it('returns the cookie id when it matches a scenario', () => {
    expect(resolveActiveScenarioId('bid-2', scenarios)).toBe('bid-2');
  });

  it('falls back to the default when cookie is null', () => {
    expect(resolveActiveScenarioId(null, scenarios)).toBe('default-1');
  });

  it('falls back to the default when cookie id is unknown', () => {
    expect(resolveActiveScenarioId('deleted-9', scenarios)).toBe('default-1');
  });

  it('returns null when there are no scenarios at all', () => {
    expect(resolveActiveScenarioId('anything', [])).toBeNull();
  });

  it('falls back to the first scenario when none is marked default', () => {
    expect(resolveActiveScenarioId(null, [{ id: 'only', is_default: false }])).toBe('only');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/scenario.test.ts`
Expected: FAIL — `resolveActiveScenarioId` is not defined.

- [ ] **Step 3: Write the implementation**

```ts
import { cookies } from 'next/headers';
import { getServiceClient } from './supabase';

export const ACTIVE_SCENARIO_COOKIE = 'active_scenario_id';

type ScenarioRef = { id: string; is_default: boolean };

/** Pure resolver: choose the active scenario id from a cookie value and the
 *  known scenario list. Prefers an exact cookie match, then the default, then
 *  the first scenario, then null if there are none. */
export function resolveActiveScenarioId(
  cookieValue: string | null,
  scenarios: ScenarioRef[]
): string | null {
  if (scenarios.length === 0) return null;
  if (cookieValue && scenarios.some((s) => s.id === cookieValue)) return cookieValue;
  const dflt = scenarios.find((s) => s.is_default);
  return (dflt ?? scenarios[0]).id;
}

/** Server-side: read the cookie and resolve against the live scenario list. */
export async function getActiveScenarioId(): Promise<string | null> {
  const supabase = getServiceClient();
  const { data } = await supabase.from('scenarios').select('id, is_default');
  const cookieValue = cookies().get(ACTIVE_SCENARIO_COOKIE)?.value ?? null;
  return resolveActiveScenarioId(cookieValue, (data ?? []) as ScenarioRef[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/scenario.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/scenario.ts src/lib/scenario.test.ts
git commit -m "feat(scenario): active-scenario resolver + server helper"
```

---

## Task 4: Property-radius filter (pure)

**Files:**
- Create: `src/lib/property-radius.ts`
- Test: `src/lib/property-radius.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { filterPropertiesWithinRadius } from './property-radius';

// SLC office anchor
const anchor = { lat: 40.7608, lng: -111.891 };

const slcProp = { id: 'slc', lat: 40.75, lng: -111.88 };      // ~1 mi
const provoProp = { id: 'provo', lat: 40.2338, lng: -111.6585 }; // ~45 mi
const ungeocoded = { id: 'none', lat: null, lng: null };

describe('filterPropertiesWithinRadius', () => {
  it('includes properties inside the radius', () => {
    const out = filterPropertiesWithinRadius([slcProp], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('excludes properties outside the radius', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('excludes ungeocoded properties when filtering', () => {
    const out = filterPropertiesWithinRadius([slcProp, ungeocoded], anchor, 25);
    expect(out.map((p) => p.id)).toEqual(['slc']);
  });

  it('passes all properties through when radius is null/undefined', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp, ungeocoded], anchor, null);
    expect(out.map((p) => p.id)).toEqual(['slc', 'provo', 'none']);
  });

  it('passes all through when anchor has no coords', () => {
    const out = filterPropertiesWithinRadius([slcProp, provoProp], { lat: null, lng: null }, 25);
    expect(out.map((p) => p.id)).toEqual(['slc', 'provo']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/property-radius.test.ts`
Expected: FAIL — `filterPropertiesWithinRadius` is not defined.

- [ ] **Step 3: Write the implementation**

```ts
import { roadMiles } from './distance';

type Coords = { lat: number | null; lng: number | null };

/** Filter properties to those within `radiusMiles` road-distance of `anchor`.
 *  - A null/undefined radius (or anchor without coords) passes everything
 *    through unchanged — this preserves the pre-scenario "all active" behavior.
 *  - When filtering, ungeocoded properties are excluded (they can't be placed). */
export function filterPropertiesWithinRadius<T extends Coords>(
  properties: T[],
  anchor: Coords,
  radiusMiles: number | null | undefined
): T[] {
  if (radiusMiles == null || anchor.lat == null || anchor.lng == null) return properties;
  const origin = { lat: anchor.lat, lng: anchor.lng };
  return properties.filter((p) => {
    if (p.lat == null || p.lng == null) return false;
    return roadMiles(origin, { lat: p.lat, lng: p.lng }) <= radiusMiles;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/property-radius.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/property-radius.ts src/lib/property-radius.test.ts
git commit -m "feat(optimize): pure branch-radius property filter"
```

---

## Task 5: Scenario actions (create/rename/delete/setActive)

**Files:**
- Create: `src/app/scenarios/actions.ts`

- [ ] **Step 1: Write the server actions**

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { getServiceClient } from '@/lib/supabase';
import { ACTIVE_SCENARIO_COOKIE } from '@/lib/scenario';

type Result = { ok: true } | { ok: false; error: string };

export async function setActiveScenario(id: string): Promise<Result> {
  cookies().set(ACTIVE_SCENARIO_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function createScenario(formData: FormData): Promise<Result> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || null;
  if (!name) return { ok: false, error: 'Name is required' };
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from('scenarios')
    .insert({ name, description, is_default: false })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create scenario' };
  // Switch into the new (empty) scenario immediately.
  await setActiveScenario(data.id);
  revalidatePath('/scenarios');
  return { ok: true };
}

export async function renameScenario(formData: FormData): Promise<Result> {
  const id = String(formData.get('id') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  if (!id || !name) return { ok: false, error: 'id and name required' };
  const supabase = getServiceClient();
  const { error } = await supabase.from('scenarios').update({ name }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/scenarios');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteScenario(formData: FormData): Promise<Result> {
  const id = String(formData.get('id') ?? '');
  if (!id) return { ok: false, error: 'id required' };
  const supabase = getServiceClient();
  const { data: scn } = await supabase.from('scenarios').select('is_default').eq('id', id).single();
  if (scn?.is_default) return { ok: false, error: 'The default scenario cannot be deleted' };
  // Cascade removes the scenario's properties/crews/branches/runs (FK on delete cascade).
  const { error } = await supabase.from('scenarios').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  // If we just deleted the active scenario, the resolver falls back to default.
  cookies().delete(ACTIVE_SCENARIO_COOKIE);
  revalidatePath('/scenarios');
  revalidatePath('/', 'layout');
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/scenarios/actions.ts
git commit -m "feat(scenarios): create/rename/delete/setActive server actions"
```

---

## Task 6: Scenario switcher (nav) + layout wiring

**Files:**
- Create: `src/components/scenario-switcher.tsx`
- Modify: `src/app/layout.tsx`
- Modify: `src/components/top-nav.tsx`

- [ ] **Step 1: Write the switcher client component**

`src/components/scenario-switcher.tsx`:

```tsx
'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { setActiveScenario } from '@/app/scenarios/actions';
import type { Scenario } from '@/lib/types';

export function ScenarioSwitcher({
  scenarios,
  activeId,
}: {
  scenarios: Pick<Scenario, 'id' | 'name'>[];
  activeId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="ml-auto flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Scenario</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        value={activeId ?? ''}
        disabled={pending}
        onChange={(e) => {
          const id = e.target.value;
          startTransition(async () => {
            await setActiveScenario(id);
            router.refresh();
          });
        }}
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Link href="/scenarios" className="text-sm text-muted-foreground hover:text-foreground">
        Manage
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Pass scenarios + active id from the layout into the nav**

Edit `src/app/layout.tsx` — make the component async and fetch scenarios:

```tsx
import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '@/components/top-nav';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';

export const metadata: Metadata = {
  title: 'TruCo Route Optimizer',
  description: 'Strategic route optimization for TruCo Services landscape maintenance',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = getServiceClient();
  const [{ data: scenarios }, activeId] = await Promise.all([
    supabase.from('scenarios').select('id, name').order('created_at', { ascending: true }),
    getActiveScenarioId(),
  ]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <TopNav scenarios={scenarios ?? []} activeScenarioId={activeId} />
        <main className="container py-6">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Render the switcher inside the nav**

Edit `src/components/top-nav.tsx`: add the `ScenarioSwitcher` import and accept props. Change the signature and add the switcher after the `<nav>`:

```tsx
import { ScenarioSwitcher } from '@/components/scenario-switcher';
import type { Scenario } from '@/lib/types';

export function TopNav({
  scenarios,
  activeScenarioId,
}: {
  scenarios: Pick<Scenario, 'id' | 'name'>[];
  activeScenarioId: string | null;
}) {
```

Then, immediately after the closing `</nav>` and before the closing `</div>` of the flex container, add:

```tsx
        <ScenarioSwitcher scenarios={scenarios} activeId={activeScenarioId} />
```

(The `'use client'` directive, `usePathname`, and the `NAV` array stay as-is.)

- [ ] **Step 4: Build to verify wiring**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/scenario-switcher.tsx src/app/layout.tsx src/components/top-nav.tsx
git commit -m "feat(nav): scenario switcher in top nav"
```

---

## Task 7: Scenarios management page

**Files:**
- Create: `src/app/scenarios/scenarios-ui.tsx`
- Create: `src/app/scenarios/page.tsx`

- [ ] **Step 1: Write the client UI pieces**

`src/app/scenarios/scenarios-ui.tsx`:

```tsx
'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createScenario, deleteScenario } from './actions';

export function CreateScenarioForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={(fd) => {
        setError(null);
        startTransition(async () => {
          const r = await createScenario(fd);
          if (r.ok) router.refresh();
          else setError(r.error);
        });
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <div>
        <Label htmlFor="name">New scenario name</Label>
        <Input id="name" name="name" placeholder="Park City Bid" />
      </div>
      <div className="min-w-[16rem] flex-1">
        <Label htmlFor="description">Description (optional)</Label>
        <Input id="description" name="description" placeholder="Prospective 2027 contract" />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create scenario'}
      </Button>
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </form>
  );
}

export function DeleteScenarioButton({ id, isDefault }: { id: string; isDefault: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (isDefault) return <span className="text-xs text-muted-foreground">default</span>;
  return (
    <form
      action={(fd) => {
        if (!confirm('Delete this scenario and ALL its properties, crews, branches, and runs?')) return;
        startTransition(async () => {
          const r = await deleteScenario(fd);
          if (r.ok) router.refresh();
          else alert(r.error);
        });
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="destructive" size="sm" disabled={pending}>
        {pending ? 'Deleting…' : 'Delete'}
      </Button>
    </form>
  );
}
```

- [ ] **Step 2: Write the page**

`src/app/scenarios/page.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';
import type { Scenario } from '@/lib/types';
import { CreateScenarioForm, DeleteScenarioButton } from './scenarios-ui';

export const dynamic = 'force-dynamic';

export default async function ScenariosPage() {
  const supabase = getServiceClient();
  const [{ data }, activeId] = await Promise.all([
    supabase.from('scenarios').select('*').order('created_at', { ascending: true }),
    getActiveScenarioId(),
  ]);
  const scenarios = (data ?? []) as Scenario[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scenarios</h1>
        <p className="text-sm text-muted-foreground">
          Each scenario has its own properties, crews, and branches. Switch scenarios from the nav.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New scenario</CardTitle>
        </CardHeader>
        <CardContent>
          <CreateScenarioForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All scenarios</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Active</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scenarios.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{s.description ?? '—'}</TableCell>
                  <TableCell>{s.id === activeId ? 'Active' : ''}</TableCell>
                  <TableCell>
                    <DeleteScenarioButton id={s.id} isDefault={s.is_default} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/scenarios/page.tsx src/app/scenarios/scenarios-ui.tsx
git commit -m "feat(scenarios): manage page (create/delete/list)"
```

---

## Task 8: Scope all WRITES to the active scenario

Every insert into `properties`, `crews`, `branches`, `optimization_runs` must stamp `scenario_id`. The pattern: resolve the id at the top of the action, then add `scenario_id: scenarioId` to the inserted object (or each row of a bulk insert).

**Resolve-and-guard snippet (use at the top of each write action):**

```ts
import { getActiveScenarioId } from '@/lib/scenario';
// ...
const scenarioId = await getActiveScenarioId();
if (!scenarioId) return { ok: false, error: 'No scenario selected' };
```

- [ ] **Step 1: Branch create** — `src/app/branches/actions.ts`
Add the resolve snippet; add `scenario_id: scenarioId` to the branch insert payload.

- [ ] **Step 2: Crew create** — `src/app/crews/actions.ts`
Add the resolve snippet; add `scenario_id: scenarioId` to the crew insert payload.

- [ ] **Step 3: Property create/edit** — `src/app/properties/actions.ts` and `src/app/properties/[id]/actions.ts`
On any property **insert**, add `scenario_id: scenarioId`. (Updates by `id` need no change — the row already carries its scenario.)

- [ ] **Step 4: Aspire/CSV import** — `src/app/properties/import-form.tsx` server action / `src/lib/csv-import.ts` callers in `src/app/properties/actions.ts`
For each imported property row inserted into `properties`, set `scenario_id: scenarioId`. The dedup/upsert key stays the same but is now also constrained by scenario in Task 9 reads.

- [ ] **Step 5: Schedule + actual-hours uploads** — `src/app/properties/actual-hours-actions.ts` (and any schedule-import insert path)
Any **insert** into `properties` gets `scenario_id`. Pure update-by-id paths are unchanged.

- [ ] **Step 6: Optimization run insert** — handled in Task 10 (optimize action already rewritten there).

- [ ] **Step 7: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add src/app/branches/actions.ts src/app/crews/actions.ts src/app/properties/actions.ts src/app/properties/[id]/actions.ts src/app/properties/actual-hours-actions.ts
git commit -m "feat(scenarios): stamp scenario_id on all inserts"
```

---

## Task 9: Scope all READS to the active scenario

Add `.eq('scenario_id', scenarioId)` to every select against `properties`, `crews`, `branches`, `optimization_runs`. In **pages** (RSC), resolve with `getActiveScenarioId()` (using `getServiceClient` for the scenarios lookup is fine; keep page reads on `getServerClient`). In **actions**, use the same resolve-and-guard snippet from Task 8.

**Concrete transformation example** (from `src/app/optimize/page.tsx`, before → after):

```ts
// before
supabase.from('crews').select('*', { count: 'exact', head: true }).eq('is_active', true),
// after
supabase.from('crews').select('*', { count: 'exact', head: true }).eq('is_active', true).eq('scenario_id', scenarioId),
```

Where to add the resolver in a page:

```ts
const scenarioId = await getActiveScenarioId();
// if null, render an empty/"create a scenario" state; otherwise scope queries below
```

- [ ] **Step 1: Properties reads** — add `.eq('scenario_id', scenarioId)` to property selects in:
`src/app/properties/page.tsx`, `src/app/properties/[id]/page.tsx`, `src/app/properties/map-data.ts`, `src/app/capacity/page.tsx`, `src/app/page.tsx`, `src/app/optimize/page.tsx`, `src/app/compare/actions.ts`, `src/app/compare/schedule-template/route.ts`, `src/app/recommend/actions.ts`, `src/app/runs/[runId]/page.tsx`, `src/app/runs/[runId]/fix-actions.ts`, `src/app/properties/actual-hours-template/route.ts`.
(Note: `properties/[id]/page.tsx` fetches one property by id — leave that single-row lookup as-is; only scope any "list all properties" query on that page.)

- [ ] **Step 2: Branches reads** — add `.eq('scenario_id', scenarioId)` to branch selects in:
`src/app/branches/page.tsx`, `src/app/crews/page.tsx`, `src/app/optimize/page.tsx`, `src/app/page.tsx`, `src/app/properties/[id]/page.tsx`, `src/app/properties/map-data.ts`, `src/app/compare/actions.ts`, `src/app/recommend/actions.ts`, `src/app/runs/[runId]/page.tsx`, `src/app/runs/[runId]/fix-actions.ts`.

- [ ] **Step 3: Crews reads** — add `.eq('scenario_id', scenarioId)` to crew selects in:
`src/app/crews/page.tsx`, `src/app/branches/page.tsx`, `src/app/capacity/page.tsx`, `src/app/optimize/page.tsx`, `src/app/page.tsx`, `src/app/compare/actions.ts`, `src/app/compare/schedule-template/route.ts`, `src/app/properties/actions.ts`, `src/app/recommend/actions.ts`, `src/app/runs/[runId]/page.tsx`, `src/app/runs/[runId]/fix-actions.ts`.

- [ ] **Step 4: Optimization-runs reads** — add `.eq('scenario_id', scenarioId)` to run-list selects in:
`src/app/optimize/page.tsx` (recent runs), `src/app/page.tsx` (dashboard recent runs), `src/app/compare/actions.ts` (run pickers).
For `src/app/runs/[runId]/page.tsx`, the run is fetched by `id` — leave that single-row lookup unscoped (the id is unguessable and the run carries its own scenario).

- [ ] **Step 5: Empty-scenario guard** — in pages that resolve `scenarioId`, if it is `null` (no scenarios exist yet), render a minimal "Create a scenario to get started" message linking to `/scenarios` instead of running scoped queries. Apply to `src/app/page.tsx`, `src/app/properties/page.tsx`, `src/app/optimize/page.tsx`. Other pages can pass the empty string safely since `.eq('scenario_id', '')` simply returns no rows.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — existing tests unaffected (they target pure `src/lib` logic, not the scoped queries).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(scenarios): scope all reads to the active scenario"
```

---

## Task 10: Optimize form — branch-anchor + radius selection

**Files:**
- Modify: `src/app/optimize/optimize-form.tsx`
- Modify: `src/app/optimize/page.tsx`
- Modify: `src/app/optimize/actions.ts`

- [ ] **Step 1: Pass the scenario's branches into the form**

In `src/app/optimize/page.tsx`: resolve `scenarioId` (Task 9), fetch the scenario's geocoded branches, and pass them to `OptimizeForm`.

```ts
const { data: branchRows } = await supabase
  .from('branches')
  .select('id, name')
  .eq('is_active', true)
  .eq('scenario_id', scenarioId ?? '')
  .not('lat', 'is', null);
const anchorBranches = (branchRows ?? []) as { id: string; name: string }[];
```

Then update the render: `<OptimizeForm defaultWeek={defaultPeakWeek()} ready={ready} branches={anchorBranches} />`

- [ ] **Step 2: Add anchor + radius inputs to the form**

In `src/app/optimize/optimize-form.tsx`, extend the props and add a fieldset. New signature:

```tsx
export function OptimizeForm({
  defaultWeek,
  ready,
  branches,
}: {
  defaultWeek: string;
  ready: boolean;
  branches: { id: string; name: string }[];
}) {
```

Add these fields inside the form grid (before the submit row):

```tsx
      <div>
        <Label htmlFor="anchor_branch_id">Limit to area around (optional)</Label>
        <select
          id="anchor_branch_id"
          name="anchor_branch_id"
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          defaultValue=""
        >
          <option value="">All properties in scenario</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="radius_miles">Radius (miles)</Label>
        <Input id="radius_miles" name="radius_miles" type="number" min="1" placeholder="25" />
      </div>
```

- [ ] **Step 3: Apply scenario scope + radius in the action**

Rewrite `startOptimization`/`launchOptimization` in `src/app/optimize/actions.ts`:
- Resolve `scenarioId` with the Task 8 snippet; return error if null.
- Scope all three selects with `.eq('scenario_id', scenarioId)`.
- Read `anchor_branch_id` and `radius_miles` from the form; if both present, filter `properties` via `filterPropertiesWithinRadius`.
- Stamp `scenario_id` on the run insert and record the filter in `config_snapshot`.

```ts
'use server';
import { revalidatePath } from 'next/cache';
import { getServiceClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';
import { filterPropertiesWithinRadius } from '@/lib/property-radius';
import type { Branch, Crew, Property } from '@/lib/types';
import { withEffectiveLabor } from '@/lib/effective-labor';

const PYTHON_SOLVER_URL = process.env.PYTHON_SOLVER_URL ?? '';

export async function startOptimization(
  formData: FormData
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const targetWeek = String(formData.get('target_week_start_date') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim() || `Run ${new Date().toISOString().slice(0, 16)}`;
  if (!targetWeek) return { ok: false, error: 'target_week_start_date required' };
  const anchorBranchId = String(formData.get('anchor_branch_id') ?? '').trim() || null;
  const radiusRaw = String(formData.get('radius_miles') ?? '').trim();
  const radiusMiles = radiusRaw ? Number(radiusRaw) : null;
  if (radiusMiles != null && (!Number.isFinite(radiusMiles) || radiusMiles <= 0)) {
    return { ok: false, error: 'Radius must be a positive number' };
  }
  return launchOptimization(name, targetWeek, { anchorBranchId, radiusMiles });
}

export async function launchOptimization(
  name: string,
  targetWeek: string,
  filter?: { anchorBranchId: string | null; radiusMiles: number | null }
): Promise<{ ok: true; run_id: string } | { ok: false; error: string }> {
  const supabase = getServiceClient();
  const scenarioId = await getActiveScenarioId();
  if (!scenarioId) return { ok: false, error: 'No scenario selected' };

  const [{ data: crewsData }, { data: branchesData }, { data: propsData }] = await Promise.all([
    supabase.from('crews').select('*').eq('is_active', true).eq('scenario_id', scenarioId),
    supabase.from('branches').select('*').eq('is_active', true).eq('scenario_id', scenarioId).not('lat', 'is', null).not('lng', 'is', null),
    supabase.from('properties').select('*').eq('is_active', true).eq('scenario_id', scenarioId).not('lat', 'is', null).not('lng', 'is', null),
  ]);

  const crews = (crewsData ?? []) as Crew[];
  const branches = (branchesData ?? []) as Branch[];
  let properties = (propsData ?? []) as Property[];

  if (crews.length === 0) return { ok: false, error: 'No active crews in this scenario' };
  if (branches.length === 0) return { ok: false, error: 'No active geocoded branches in this scenario' };

  // Optional branch-radius narrowing.
  let appliedFilter: { anchor_branch_id: string; anchor_branch_name: string; radius_miles: number } | null = null;
  if (filter?.anchorBranchId && filter.radiusMiles != null) {
    const anchor = branches.find((b) => b.id === filter.anchorBranchId);
    if (!anchor) return { ok: false, error: 'Anchor branch not found in scenario' };
    properties = filterPropertiesWithinRadius(properties, { lat: anchor.lat, lng: anchor.lng }, filter.radiusMiles);
    appliedFilter = { anchor_branch_id: anchor.id, anchor_branch_name: anchor.name, radius_miles: filter.radiusMiles };
  }

  if (properties.length === 0) {
    return { ok: false, error: appliedFilter ? 'No geocoded properties within that radius' : 'No geocoded active properties in this scenario' };
  }

  const { data: run, error: runErr } = await supabase
    .from('optimization_runs')
    .insert({
      name,
      scenario_id: scenarioId,
      target_week_start_date: targetWeek,
      active_branch_ids: branches.map((b) => b.id),
      active_crew_ids: crews.map((c) => c.id),
      active_property_ids: properties.map((p) => p.id),
      config_snapshot: { crew_count: crews.length, property_count: properties.length, property_filter: appliedFilter },
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runErr || !run) return { ok: false, error: runErr?.message ?? 'Could not create run' };

  void invokeSolver(run.id, { crews, branches, properties }).catch(async (e) => {
    await supabase
      .from('optimization_runs')
      .update({ status: 'failed', failure_reason: e instanceof Error ? e.message : String(e), completed_at: new Date().toISOString() })
      .eq('id', run.id);
  });

  revalidatePath('/optimize');
  return { ok: true, run_id: run.id };
}

async function invokeSolver(
  runId: string,
  payload: { crews: Crew[]; branches: Branch[]; properties: Property[] }
) {
  if (!PYTHON_SOLVER_URL) {
    throw new Error('PYTHON_SOLVER_URL is not configured. Set it on this project to the deployed Python solver URL.');
  }
  const res = await fetch(PYTHON_SOLVER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ run_id: runId, ...payload, properties: withEffectiveLabor(payload.properties) }),
  });
  if (!res.ok) throw new Error(`Solver returned ${res.status}: ${await res.text()}`);
}
```

> **Note:** `launchOptimization` gained an optional 3rd param. Check other callers (e.g. `src/app/compare/actions.ts` or recommend flows) — they keep working since `filter` is optional, but they will now require an active scenario. Verify they resolve a scenario context or are only called from scenario-scoped pages.

- [ ] **Step 4: Surface the applied filter on the run-detail page**

In `src/app/runs/[runId]/page.tsx`, read `run.config_snapshot.property_filter`; when present, render a line near the run header, e.g.:

```tsx
{filter && (
  <p className="text-sm text-muted-foreground">
    Limited to {filter.radius_miles} mi around {filter.anchor_branch_name}
  </p>
)}
```

(Read it defensively: `const filter = (run.config_snapshot as { property_filter?: { anchor_branch_name: string; radius_miles: number } } | null)?.property_filter ?? null;`)

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/optimize/optimize-form.tsx src/app/optimize/page.tsx src/app/optimize/actions.ts src/app/runs/[runId]/page.tsx
git commit -m "feat(optimize): scenario scope + branch-radius property selection"
```

---

## Task 11: Build verification + manual checklist

- [ ] **Step 1: Full build + tests**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: all PASS, build succeeds.

- [ ] **Step 2: Manual verification (after the user applies the migration in Task 12)**

1. Live portfolio appears under "TruCo Portfolio" with all existing data intact.
2. Create "Park City Bid" via the nav switcher / `/scenarios`; it starts empty.
3. Import properties into the bid scenario; confirm "TruCo Portfolio" property count is unchanged.
4. On Optimize in the bid scenario, choose an anchor branch + 25 mi, run; confirm the run's `active_property_ids` and the run-detail filter line reflect only in-radius properties.
5. Switch back to "TruCo Portfolio"; confirm its data and prior runs are unchanged.

- [ ] **Step 3: Commit any build fixes**

```bash
git add -A
git commit -m "chore: build + lint fixes for scenarios"
```

---

## Task 12: Deliver migration SQL to the user

- [ ] **Step 1: Hand the user the paste-ready SQL**

Per CLAUDE.md, migrations are never auto-applied. In the completion message, paste the full contents of `supabase/migrations/20260618000000_scenarios.sql` and instruct: run it in Supabase (or `supabase db push`) **before** deploying the web app, since the app now requires the `scenarios` table and `scenario_id` columns. No solver redeploy is needed (the solver payload is unchanged).

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1–2), switching/scoping (Tasks 3,5,6,8,9), radius selection (Tasks 4,10), testing (Tasks 3,4,11), migration handoff (Task 12). All spec sections covered.
- **Type consistency:** `getActiveScenarioId()`, `resolveActiveScenarioId()`, `filterPropertiesWithinRadius()`, `ACTIVE_SCENARIO_COOKIE`, and `scenario_id` are used identically across tasks.
- **Out-of-scope honored:** no auth/RLS, no cross-scenario compare, no clone, no manual/attribute property selection — only branch-radius.
