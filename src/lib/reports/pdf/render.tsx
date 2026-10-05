/**
 * PDF rendering entry point.
 *
 * `renderToBuffer` from `@react-pdf/renderer` produces the bytes in Node: no
 * Chromium, no Playwright, no headless browser and no network access at
 * generation time (only the map provider may talk to the outside world, and only
 * for the static map image).
 *
 * Rendering is synchronous with respect to the request: the route awaits these
 * bytes, uploads them and only then marks the report `ready`.
 */

import { renderToBuffer } from '@react-pdf/renderer';

import type { ReportViewModel } from '../types';
import { ReportDocument, type ReportDocumentImages } from './report-document';
import { toDocumentImage } from './image';

export interface RenderReportPdfInput {
  viewModel: ReportViewModel;
  mapImage: Uint8Array | null;
  logoImage: Uint8Array | null;
}

export interface RenderReportPdfResult {
  bytes: Uint8Array;
  /** Human-readable size, recorded in diagnostics only. */
  byteLength: number;
}

export async function renderReportPdf(input: RenderReportPdfInput): Promise<RenderReportPdfResult> {
  const images: ReportDocumentImages = {
    map: toDocumentImage(input.mapImage),
    logo: toDocumentImage(input.logoImage),
  };

  const bytes = await renderToBuffer(<ReportDocument viewModel={input.viewModel} images={images} />);
  const output = new Uint8Array(bytes);

  return { bytes: output, byteLength: output.byteLength };
}
