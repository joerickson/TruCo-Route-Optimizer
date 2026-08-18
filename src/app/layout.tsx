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
  // Resolve the scenario list + active scenario for the nav. Wrapped in try/catch
  // so a missing Supabase env (e.g. the build-time prerender of /_not-found, where
  // no env vars are present) degrades to an empty switcher instead of throwing.
  let scenarios: { id: string; name: string; kind?: string }[] = [];
  let activeId: string | null = null;
  try {
    const supabase = getServiceClient();
    const [{ data }, resolvedId] = await Promise.all([
      supabase.from('scenarios').select('id, name, kind').order('created_at', { ascending: true }),
      getActiveScenarioId(),
    ]);
    scenarios = data ?? [];
    activeId = resolvedId;
  } catch {
    // Supabase not configured at this point — render the shell without scenarios.
  }

  const activeKind = scenarios.find((s) => s.id === activeId)?.kind === 'snow' ? 'snow' : 'maintenance';

  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <TopNav
          scenarios={scenarios.map((s) => ({ id: s.id, name: s.name }))}
          activeScenarioId={activeId}
          activeScenarioKind={activeKind}
        />
        <main className="container py-6">{children}</main>
      </body>
    </html>
  );
}
