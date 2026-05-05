'use client';
import 'mapbox-gl/dist/mapbox-gl.css';
import mapboxgl from 'mapbox-gl';
import { useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ServiceType } from '@/lib/types';

export interface DetailMapBranch {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export interface PropertyDetailMapProps {
  property: {
    id: string;
    name: string;
    lat: number;
    lng: number;
    service_type: ServiceType;
  };
  branches: DetailMapBranch[];
}

const SERVICE_COLORS: Record<ServiceType, string> = {
  weekly: '#10b981',
  biweekly: '#f59e0b',
  monthly: '#3b82f6',
};

const BRANCH_COLOR = '#ef4444';

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

export default function PropertyDetailMap({ property, branches }: PropertyDetailMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

  useEffect(() => {
    if (!containerRef.current || mapRef.current || !token) return;
    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [property.lng, property.lat],
      zoom: 16,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    new mapboxgl.Marker({ color: SERVICE_COLORS[property.service_type] })
      .setLngLat([property.lng, property.lat])
      .setPopup(new mapboxgl.Popup({ offset: 24 }).setHTML(`<strong>${escapeHtml(property.name)}</strong>`))
      .addTo(map);

    for (const b of branches) {
      new mapboxgl.Marker({ color: BRANCH_COLOR })
        .setLngLat([b.lng, b.lat])
        .setPopup(
          new mapboxgl.Popup({ offset: 24 }).setHTML(
            `<strong>${escapeHtml(b.name)}</strong><br/><span style="font-size:12px;color:#64748b">${escapeHtml(b.address)}</span>`
          )
        )
        .addTo(map);
    }

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Map unavailable</CardTitle>
          <CardDescription>
            <code>NEXT_PUBLIC_MAPBOX_TOKEN</code> is not configured.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const gmapsUrl = `https://www.google.com/maps?q=${property.lat},${property.lng}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Map</CardTitle>
        <CardDescription>Zoom 16 · property + branch markers</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div ref={containerRef} className="h-[400px] w-full overflow-hidden rounded-md border" />
        <a
          href={gmapsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-primary hover:underline"
        >
          Open in Google Maps ↗
        </a>
      </CardContent>
    </Card>
  );
}
