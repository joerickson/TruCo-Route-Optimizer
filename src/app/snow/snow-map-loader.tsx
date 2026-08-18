'use client';
import dynamic from 'next/dynamic';
import type { SnowMapProps } from './snow-map';

// Lazy-load mapbox-gl only when this mounts; ssr:false because mapbox references `window`.
const SnowMap = dynamic(() => import('./snow-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[560px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function SnowMapLoader(props: SnowMapProps) {
  return <SnowMap {...props} />;
}
