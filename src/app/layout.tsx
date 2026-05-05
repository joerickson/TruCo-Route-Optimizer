import type { Metadata } from 'next';
import './globals.css';
import { TopNav } from '@/components/top-nav';

export const metadata: Metadata = {
  title: 'TruCo Route Optimizer',
  description: 'Strategic route optimization for TruCo Services landscape maintenance',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <TopNav />
        <main className="container py-6">{children}</main>
      </body>
    </html>
  );
}
