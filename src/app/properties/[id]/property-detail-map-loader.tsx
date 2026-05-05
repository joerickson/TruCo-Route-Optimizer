'use client';
import dynamic from 'next/dynamic';
import type { PropertyDetailMapProps } from './property-detail-map';

const PropertyDetailMap = dynamic(() => import('./property-detail-map'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[460px] w-full items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

export function PropertyDetailMapLoader(props: PropertyDetailMapProps) {
  return <PropertyDetailMap {...props} />;
}
