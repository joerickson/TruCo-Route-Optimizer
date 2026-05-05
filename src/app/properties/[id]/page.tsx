import Link from 'next/link';
import { ArrowLeft, ArrowRight, ChevronLeft } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getServiceClient } from '@/lib/supabase';
import type { Property } from '@/lib/types';
import { PropertyEditForm } from './property-edit-form';
import { PropertyDetailMapLoader } from './property-detail-map-loader';
import { StreetView } from './street-view';
import { GeocodingStatus } from './geocoding-status';

export const dynamic = 'force-dynamic';

interface BranchRow {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

export default async function PropertyDetailPage({ params }: { params: { id: string } }) {
  const supabase = getServiceClient();

  const { data, error } = await supabase.from('properties').select('*').eq('id', params.id).maybeSingle();

  if (error || !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle>Property not found</CardTitle>
          <CardDescription>
            No property with id <code className="font-mono text-xs">{params.id}</code>.
            {error && <> The database returned: <em>{error.message}</em>.</>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/properties" className="text-sm text-primary hover:underline">
            ← Back to properties
          </Link>
        </CardContent>
      </Card>
    );
  }

  const property = data as Property;

  const [{ data: branchesData }, { data: prev }, { data: next }] = await Promise.all([
    supabase.from('branches').select('id, name, address, lat, lng').eq('is_active', true),
    supabase
      .from('properties')
      .select('id, name')
      .eq('is_active', true)
      .lt('name', property.name)
      .order('name', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('properties')
      .select('id, name')
      .eq('is_active', true)
      .gt('name', property.name)
      .order('name', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const branches = ((branchesData ?? []) as BranchRow[])
    .filter((b): b is BranchRow & { lat: number; lng: number } => b.lat != null && b.lng != null)
    .map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      lat: Number(b.lat),
      lng: Number(b.lng),
    }));

  const hasCoords = property.lat != null && property.lng != null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/properties"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Back to properties
        </Link>
        <div className="flex items-center gap-2">
          {prev ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/properties/${prev.id}`} title={prev.name}>
                <ArrowLeft className="mr-1 h-4 w-4" />
                Prev
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Prev
            </Button>
          )}
          {next ? (
            <Button asChild variant="outline" size="sm">
              <Link href={`/properties/${next.id}`} title={next.name}>
                Next
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Next
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <PropertyEditForm property={property} />

      <div className="grid gap-6 lg:grid-cols-2">
        {hasCoords ? (
          <PropertyDetailMapLoader
            property={{
              id: property.id,
              name: property.name,
              lat: Number(property.lat),
              lng: Number(property.lng),
              service_type: property.service_type,
            }}
            branches={branches}
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Map</CardTitle>
              <CardDescription>Property has no coordinates — re-geocode to enable the map.</CardDescription>
            </CardHeader>
          </Card>
        )}

        <StreetView lat={property.lat == null ? null : Number(property.lat)} lng={property.lng == null ? null : Number(property.lng)} />
      </div>

      <GeocodingStatus
        propertyId={property.id}
        lat={property.lat == null ? null : Number(property.lat)}
        lng={property.lng == null ? null : Number(property.lng)}
        geocodedAt={property.geocoded_at}
      />
    </div>
  );
}
