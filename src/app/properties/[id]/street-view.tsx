import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function StreetView({ lat, lng }: { lat: number | null; lng: number | null }) {
  if (lat == null || lng == null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Street View</CardTitle>
          <CardDescription>Property has no coordinates — re-geocode to enable Street View.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Server-rendered: API key appears in the iframe URL (visible in HTML source)
  // but is protected by HTTP-referer restrictions in Google Cloud Console.
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Street View unavailable</CardTitle>
          <CardDescription>
            <code>GOOGLE_MAPS_API_KEY</code> is not configured on this environment.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const embedUrl = new URL('https://www.google.com/maps/embed/v1/streetview');
  embedUrl.searchParams.set('key', apiKey);
  embedUrl.searchParams.set('location', `${lat},${lng}`);
  embedUrl.searchParams.set('heading', '210');
  embedUrl.searchParams.set('pitch', '10');
  embedUrl.searchParams.set('fov', '80');

  // Click-out URL (no API key required) — drops the user into Street View directly.
  const directUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Street View</CardTitle>
        <CardDescription>
          If this iframe is blank, check that Maps Embed API is enabled and the deployed domain is on the API key&apos;s
          allowed referers list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="aspect-[4/3] overflow-hidden rounded-md border bg-muted">
          <iframe
            title="Google Street View"
            src={embedUrl.toString()}
            className="h-full w-full border-0"
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
            allowFullScreen
          />
        </div>
        <a
          href={directUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-block text-sm text-primary hover:underline"
        >
          Open in Google Street View ↗
        </a>
      </CardContent>
    </Card>
  );
}
