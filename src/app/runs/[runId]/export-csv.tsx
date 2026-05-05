'use client';
import { Button } from '@/components/ui/button';

export function ExportCsvButton({ runId }: { runId: string }) {
  return (
    <Button asChild size="sm" variant="outline">
      <a href={`/api/runs/${runId}/export`}>Export CSV</a>
    </Button>
  );
}
