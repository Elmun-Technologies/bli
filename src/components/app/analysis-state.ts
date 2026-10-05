import type { AnalysisPanelView } from '@/lib/spatial/analysis-view';
import type { DataSourceMode } from '@/lib/spatial/data-source';

export interface AnalysisState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  view: AnalysisPanelView | null;
  errorMessage: string | null;
  key: string | null;
  stale: boolean;
}

export const IDLE_ANALYSIS_STATE: AnalysisState = {
  status: 'idle',
  view: null,
  errorMessage: null,
  key: null,
  stale: false,
};

/**
 * Results stay visible but are explicitly marked stale until the candidate and
 * radius match a completed server analysis. Stale metrics are never presented
 * as belonging to the new radius.
 */
export function resolveAnalysisState(
  analysis: AnalysisState,
  currentKey: string,
): AnalysisState {
  return {
    ...analysis,
    stale: Boolean(analysis.view) && analysis.key !== currentKey,
  };
}

export function analysisSourceLabel(
  dataSource: DataSourceMode,
  analysis: AnalysisState,
): string {
  if (dataSource !== 'database') return 'FIXTURES · ANALYSIS DISABLED';
  if (analysis.status === 'ready' && analysis.stale) return 'POSTGIS · STALE';
  if (analysis.status === 'ready') return 'POSTGIS · SERVER ANALYZED';

  return 'POSTGIS · DEMO WORKSPACE';
}
