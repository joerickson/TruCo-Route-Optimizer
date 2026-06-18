import Link from 'next/link';
import { getServerClient } from '@/lib/supabase';
import { getActiveScenarioId } from '@/lib/scenario';
import { getPropertyMapData } from '../properties/map-data';
import { CoverageClient } from './coverage-client';

export const dynamic = 'force-dynamic';

export default async function CoveragePage() {
  const scenarioId = await getActiveScenarioId();

  if (!scenarioId) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">Bid area</h1>
        <p className="text-sm text-muted-foreground">
          No scenario yet.{' '}
          <Link href="/scenarios" className="text-primary hover:underline">
            Create a scenario
          </Link>{' '}
          to get started.
        </p>
      </div>
    );
  }

  const supabase = getServerClient();
  const { properties, branches } = await getPropertyMapData(supabase, { scenarioId });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Bid area</h1>
        <p className="text-sm text-muted-foreground">
          Pick branches and a radius to see which sites fall within range — on the map and as a downloadable list.
          Distance is straight-line (as the crow flies). {properties.length} geocoded sites · {branches.length} branches
          in this scenario.
        </p>
      </div>
      <CoverageClient branches={branches} properties={properties} />
    </div>
  );
}
