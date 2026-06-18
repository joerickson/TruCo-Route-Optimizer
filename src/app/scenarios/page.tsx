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
