'use client';
import dynamic from 'next/dynamic';
import type { RoutesMapProps } from './routes-map';

// Lazy-load mapbox-gl only when the map view mounts. ssr:false because
// mapbox-gl references `window`.
const RoutesMap = dynamic(() => import('./routes-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[640px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function RoutesMapLoader(props: RoutesMapProps) {
  return <RoutesMap {...props} />;
}
