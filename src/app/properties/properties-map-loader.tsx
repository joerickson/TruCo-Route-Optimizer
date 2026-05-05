'use client';
import dynamic from 'next/dynamic';
import type { PropertiesMapProps } from './properties-map';

// Lazy-load mapbox-gl only when this component mounts (i.e., view=map).
// `ssr: false` because mapbox-gl references `window`.
const PropertiesMap = dynamic(() => import('./properties-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[640px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function PropertiesMapLoader(props: PropertiesMapProps) {
  return <PropertiesMap {...props} />;
}
