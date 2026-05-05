import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getServerClient } from '@/lib/supabase';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

async function getCounts() {
  const supabase = getServerClient();
  const [{ count: propCount }, { count: crewCount }, { count: branchCount }, { data: latestRun }] = await Promise.all([
    supabase.from('properties').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('crews').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('branches').select('*', { count: 'exact', head: true }).eq('is_active', true),
    supabase
      .from('optimization_runs')
      .select('id, name, status, created_at, capacity_recommendation')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    propCount: propCount ?? 0,
    crewCount: crewCount ?? 0,
    branchCount: branchCount ?? 0,
    latestRun,
  };
}

export default async function HomePage() {
  let data: Awaited<ReturnType<typeof getCounts>> | null = null;
  let error: string | null = null;
  try {
    data = await getCounts();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not connect to Supabase';
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">TruCo Route Optimizer</h1>
        <p className="mt-2 text-muted-foreground">
          Strategic routing analysis for the 30-crew landscape maintenance portfolio. Capacity planning and bid analysis.
        </p>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Supabase not connected</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code>,
            then run the migrations under <code>supabase/migrations/</code>.
          </CardContent>
        </Card>
      )}

      {data && (
        <div className="grid gap-4 md:grid-cols-3">
          <StatCard label="Properties" value={data.propCount} href="/properties" />
          <StatCard label="Crews" value={data.crewCount} href="/crews" />
          <StatCard label="Branches" value={data.branchCount} href="/branches" />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Latest optimization run</CardTitle>
          <CardDescription>Most recent solver result</CardDescription>
        </CardHeader>
        <CardContent>
          {data?.latestRun ? (
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{data.latestRun.name}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(data.latestRun.created_at).toLocaleString()} · {data.latestRun.status}
                  {data.latestRun.capacity_recommendation && ` · ${data.latestRun.capacity_recommendation}`}
                </div>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link href={`/runs/${data.latestRun.id}`}>View</Link>
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">No optimization runs yet.</p>
              <Button asChild size="sm">
                <Link href="/optimize">Run optimization</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href}>
      <Card className="transition-colors hover:border-primary/40">
        <CardHeader className="pb-2">
          <CardDescription>{label}</CardDescription>
          <CardTitle className="text-3xl">{value.toLocaleString()}</CardTitle>
        </CardHeader>
      </Card>
    </Link>
  );
}
