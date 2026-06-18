'use client';
import dynamic from 'next/dynamic';
import type { CoverageMapProps } from './coverage-map';

// Lazy-load mapbox-gl only when the bid-area map mounts (it references `window`).
const CoverageMap = dynamic(() => import('./coverage-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[560px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function CoverageMapLoader(props: CoverageMapProps) {
  return <CoverageMap {...props} />;
}
