'use client';

/**
 * "Generate report" for one stored analysis.
 *
 * The button creates the report from the stored analysis the user is looking at
 * and immediately generates its PDF from the snapshot that was just frozen. It
 * never reruns the analysis and never reads the workspace's current data.
 */

import { useCallback, useState } from 'react';
import { FileText, LoaderCircle, TriangleAlert } from 'lucide-react';

import { createReport, generateReport, ReportsApiError } from '@/lib/reports/client';

export function ReportCreateButton({
  workspaceId,
  projectId,
  analysisId,
  disabled = false,
  onCreated,
}: {
  workspaceId: string;
  projectId: string;
  analysisId: string;
  /** Hidden entirely for a role the server would refuse. */
  disabled?: boolean;
  onCreated: (reportId: string) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'creating' | 'generating'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setErrorMessage(null);
    setStatus('creating');
    try {
      const report = await createReport(workspaceId, { projectId, analysisId });
      setStatus('generating');
      try {
        await generateReport(workspaceId, report.id);
      } catch (error) {
        // The report exists and is marked failed; the reports section offers the
        // retry, so the new report is still opened.
        setErrorMessage(
          error instanceof ReportsApiError
            ? error.message
            : 'The report was created, but its PDF could not be generated. Retry it in Reports.',
        );
      }
      setStatus('idle');
      onCreated(report.id);
    } catch (error) {
      setStatus('idle');
      setErrorMessage(
        error instanceof ReportsApiError ? error.message : 'The report could not be created.',
      );
    }
  }, [analysisId, onCreated, projectId, workspaceId]);

  if (disabled) return null;

  return (
    <span className="report-create-button">
      <button
        className="scoring-button scoring-button--quiet"
        disabled={status !== 'idle'}
        onClick={() => void handleClick()}
        type="button"
      >
        {status === 'idle' ? (
          <FileText aria-hidden="true" size={13} />
        ) : (
          <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
        )}
        {status === 'creating'
          ? 'Creating report…'
          : status === 'generating'
            ? 'Generating PDF…'
            : 'Generate report'}
      </button>
      {errorMessage ? (
        <span className="report-create-button__error">
          <TriangleAlert aria-hidden="true" size={12} /> {errorMessage}
        </span>
      ) : null}
    </span>
  );
}
