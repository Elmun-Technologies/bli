/**
 * The production static-map provider: Mapbox Static Images API.
 *
 * Server-side only. The access token is read from `MAPBOX_ACCESS_TOKEN` (never
 * `NEXT_PUBLIC_*`), is never returned in an API response, and never reaches the
 * browser: the PDF is rendered on the server, and the stored map image is served
 * back through an authenticated route.
 *
 * What is drawn: the candidate markers with their report labels and the analysis
 * circle. What is never drawn: individual customer points. The provider receives
 * only what a marker needs — a label and a coordinate — plus the radius.
 *
 * Attribution: the request keeps Mapbox's rendered attribution and logo on by
 * default, and the report additionally prints the attribution line explicitly
 * (`attribution=true` in the API call and the text in the PDF/preview), so the
 * requirement holds even for a style or a print path where the baked-in text is
 * unreadable.
 */

import {
  ReportMapError,
  type ComparisonMapRequest,
  type ReportMapProvider,
  type ReportMapResult,
  type SingleLocationMapRequest,
} from './provider';

/** The style used for report maps; overridable per deployment. */
export const DEFAULT_REPORT_MAP_STYLE = 'mapbox/light-v11';

export const MAPBOX_ATTRIBUTION = '© Mapbox © OpenStreetMap contributors';

export interface MapboxProviderOptions {
  accessToken: string;
  style?: string;
  /** Injected for tests: the fetch implementation. */
  fetchImpl?: typeof fetch;
}

/** A circle of `segments` points around a center, as a GeoJSON polygon ring. */
export function circleRing(
  longitude: number,
  latitude: number,
  radiusMeters: number,
  segments = 64,
): Array<[number, number]> {
  const earthRadius = 6_371_008.8;
  const angular = radiusMeters / earthRadius;
  const latRadians = (latitude * Math.PI) / 180;
  const ring: Array<[number, number]> = [];

  for (let index = 0; index <= segments; index += 1) {
    const bearing = (2 * Math.PI * index) / segments;
    const pointLat = Math.asin(
      Math.sin(latRadians) * Math.cos(angular) +
        Math.cos(latRadians) * Math.sin(angular) * Math.cos(bearing),
    );
    const pointLon =
      (longitude * Math.PI) / 180 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(latRadians),
        Math.cos(angular) - Math.sin(latRadians) * Math.sin(pointLat),
      );

    ring.push([(pointLon * 180) / Math.PI, (pointLat * 180) / Math.PI]);
  }

  return ring;
}

/**
 * Builds the Static Images overlay path.
 *
 *   pin-s-a(69.2797,41.3111)            candidate A
 *   pin-s-b(69.2600,41.2950)            candidate B
 *   geojson(<url-encoded Feature>)      the radius circle
 *
 * The circle is drawn to scale so the reader can see the measured area; it is a
 * visualization, not a measurement — PostGIS remains the authority on what is
 * inside the radius.
 */
export function buildOverlayPath(
  markers: Array<{ label: string; longitude: number; latitude: number }>,
  radiusMeters: number | null,
): string {
  const parts: string[] = [];

  if (radiusMeters !== null && markers.length === 1) {
    const [marker] = markers;
    const feature = {
      type: 'Feature',
      properties: {
        stroke: '#1f6feb',
        'stroke-width': 2,
        'stroke-opacity': 0.9,
        fill: '#1f6feb',
        'fill-opacity': 0.12,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [circleRing(marker.longitude, marker.latitude, radiusMeters)],
      },
    };
    parts.push(`geojson(${encodeURIComponent(JSON.stringify(feature))})`);
  }

  for (const marker of markers) {
    const label = marker.label.toLowerCase().slice(0, 3).replace(/[^a-z0-9]/g, '');
    parts.push(
      `pin-s-${label}(${marker.longitude.toFixed(5)},${marker.latitude.toFixed(5)})`,
    );
  }

  return parts.join(',');
}

/** The `auto` viewport with padding, so every marker is inside the image. */
export function buildViewport(width: number, height: number, padding: number): string {
  return `auto${width}x${height}@2x${padding > 0 ? `,${padding}` : ''}`;
}

export class MapboxReportMapProvider implements ReportMapProvider {
  readonly name = 'mapbox-static';
  readonly attribution = MAPBOX_ATTRIBUTION;
  readonly available = true;

  private readonly token: string;
  private readonly style: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MapboxProviderOptions) {
    this.token = options.accessToken;
    this.style = options.style ?? DEFAULT_REPORT_MAP_STYLE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The request URL for one render. Exported behaviour for tests and docs. */
  buildUrl(
    markers: Array<{ label: string; longitude: number; latitude: number }>,
    radiusMeters: number | null,
    width: number,
    height: number,
    padding: number,
  ): string {
    const overlay = buildOverlayPath(markers, radiusMeters);
    const viewport = buildViewport(width, height, padding);
    const params = new URLSearchParams({
      access_token: this.token,
      logo: 'true',
      attribution: 'true',
    });

    return `https://api.mapbox.com/styles/v1/${this.style}/static/${overlay}/${viewport}?${params.toString()}`;
  }

  private async render(
    markers: Array<{ label: string; longitude: number; latitude: number }>,
    radiusMeters: number | null,
    width: number,
    height: number,
    padding: number,
  ): Promise<ReportMapResult> {
    const url = this.buildUrl(markers, radiusMeters, width, height, padding);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { cache: 'no-store' });
    } catch (cause) {
      throw new ReportMapError('The map provider could not be reached.', { cause });
    }

    if (!response.ok) {
      throw new ReportMapError(`The map provider answered ${response.status}.`);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.startsWith('image/')) {
      throw new ReportMapError('The map provider did not return an image.');
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new ReportMapError('The map provider returned an empty image.');
    }

    return {
      bytes,
      mimeType: contentType.includes('jpeg') ? 'image/jpeg' : 'image/png',
      provider: this.name,
      attribution: this.attribution,
      width,
      height,
    };
  }

  renderSingleLocationMap(request: SingleLocationMapRequest): Promise<ReportMapResult> {
    return this.render(
      request.markers,
      request.radiusMeters,
      request.width,
      request.height,
      request.padding ?? 40,
    );
  }

  renderComparisonMap(request: ComparisonMapRequest): Promise<ReportMapResult> {
    return this.render(
      request.markers,
      request.radiusMeters,
      request.width,
      request.height,
      request.padding ?? 48,
    );
  }
}
