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
