import type { NextRequest } from 'next/server';

import { resolveDataSourceMode } from '@/lib/spatial/data-source';
import { errorResponse, handleSpatialRouteError, jsonResponse } from '@/lib/spatial/http';
import { fetchDemoRadiusAnalysis } from '@/lib/spatial/service';
import { SpatialValidationError, parseRadiusAnalysisRequest } from '@/lib/spatial/validation';

// Radius results depend on the request coordinates/radius and live demo data.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_BODY_BYTES = 2_048;

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new SpatialValidationError('Request body is too large.');
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    throw new SpatialValidationError('Request body is too large.');
  }
  if (rawBody.trim().length === 0) {
    throw new SpatialValidationError('Request body must be a JSON object.');
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new SpatialValidationError('Request body must be valid JSON.');
  }
}

export async function POST(request: NextRequest) {
  try {
    if (resolveDataSourceMode() !== 'database') {
      return errorResponse(
        503,
        'database_required',
        'Radius analysis requires DATA_SOURCE=database; synthetic fixtures are never used for metrics.',
      );
    }

    const parsedRequest = parseRadiusAnalysisRequest(await readJsonBody(request));
    const analysis = await fetchDemoRadiusAnalysis(parsedRequest);

    return jsonResponse({ analysis });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('DATA_SOURCE must be')) {
      return errorResponse(503, 'database_unavailable', 'The demo data source is misconfigured.');
    }
    return handleSpatialRouteError('analysis/radius', error);
  }
}
