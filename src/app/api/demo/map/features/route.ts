import type { NextRequest } from 'next/server';

import { resolveDataSourceMode } from '@/lib/spatial/data-source';
import { buildFixtureViewportFeatureCollection } from '@/lib/spatial/fixtures';
import { errorResponse, handleSpatialRouteError, jsonResponse } from '@/lib/spatial/http';
import { fetchDemoViewportFeatures } from '@/lib/spatial/service';
import { parseViewportQuery } from '@/lib/spatial/validation';

// Viewport results depend on live demo data and request bounds.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const { bounds, kinds } = parseViewportQuery(request.nextUrl.searchParams);

    if (resolveDataSourceMode() === 'fixtures') {
      return jsonResponse(buildFixtureViewportFeatureCollection(bounds, kinds));
    }

    return jsonResponse(await fetchDemoViewportFeatures(bounds, kinds));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DATA_SOURCE must be')) {
      return errorResponse(503, 'database_unavailable', 'The demo data source is misconfigured.');
    }
    return handleSpatialRouteError('map/features', error);
  }
}
