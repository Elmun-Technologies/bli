'use client';

/**
 * The Phase 7 reports section.
 *
 * Report history for the *selected* project: title, type, status, who created it
 * and when, and the actions the caller's role actually allows. Ready reports can
 * be previewed, downloaded or regenerated from the same immutable snapshot;
 * failed ones can be retried. Nothing here decides authorization — the server
 * and the database do — this panel only avoids offering an impossible action.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CircleAlert,
  FileText,
  LoaderCircle,
  Lock,
  RefreshCw,
  ScrollText,
  TriangleAlert,
  Upload,
} from 'lucide-react';

import { ReportPreview } from '@/lib/reports/preview/report-preview';
import {
  clearReportLogo,
  createReport,
  generateReport,
  getReport,
  listReports,
  reportArtifactUrl,
  reportDownloadUrl,
  ReportsApiError,
  updateReport,
  uploadReportLogo,
} from '@/lib/reports/client';
import { NO_PROJECT_MESSAGE, resolveProjectContext } from '@/lib/scoring/projects';
import { listWorkspaceProjects, ScoringApiError } from '@/lib/scoring/client';
import type { WorkspaceProjectSummary } from '@/lib/scoring/projects';
import type { ReportStatus, ReportSummary, ReportViewModel } from '@/lib/reports/types';

const RUN_ROLES = new Set(['owner', 'admin', 'analyst']);
const MANAGE_ROLES = new Set(['owner', 'admin']);

const STATUS_LABELS: Record<ReportStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  ready: 'Ready',
  failed: 'Failed',
};

interface ProjectsState {
  status: 'loading' | 'ready' | 'error';
  projects: WorkspaceProjectSummary[];
  errorMessage: string | null;
}

function apiMessage(error: unknown, fallback: string): string {
  if (error instanceof ReportsApiError || error instanceof ScoringApiError) return error.message;
  return fallback;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function statusClass(status: ReportStatus): string {
  return `report-status report-status--${status}`;
}

export function ReportsPanel({
  workspaceId,
  workspaceRole,
  initialProjectId,
  focusedReportId,
}: {
  workspaceId: string;
  workspaceRole: string;
  initialProjectId: string | null;
  focusedReportId: string | null;
}) {
  const canRun = RUN_ROLES.has(workspaceRole);
  const canManage = MANAGE_ROLES.has(workspaceRole);

  const [projectsState, setProjectsState] = useState<ProjectsState>({
    status: 'loading',
    projects: [],
    errorMessage: null,
  });
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [listStatus, setListStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(focusedReportId);
  const [detail, setDetail] = useState<{ report: ReportSummary; viewModel: ReportViewModel | null } | null>(
    null,
  );
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  // The caller's own projects, resolved server-side. The panel never guesses a
  // project when several exist: it asks the user to choose, exactly like Phase 6.5.
  useEffect(() => {
    let cancelled = false;

    void listWorkspaceProjects(workspaceId)
      .then((projects) => {
        if (cancelled) return;
        setProjectsState({ status: 'ready', projects, errorMessage: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjectsState({
          status: 'error',
          projects: [],
          errorMessage: apiMessage(error, 'The projects of this workspace could not be loaded.'),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const resolution = useMemo(
    () => resolveProjectContext(projectsState.projects, initialProjectId ?? projectId),
    [initialProjectId, projectId, projectsState.projects],
  );

  useEffect(() => {
    if (projectsState.status !== 'ready') return;
    if (resolution.status === 'resolved' && resolution.projectId !== projectId) {
      setProjectId(resolution.projectId);
    }
  }, [projectId, projectsState.status, resolution]);

  const refreshHistory = useCallback(async () => {
    if (resolution.status !== 'resolved') {
      setReports([]);
      setListStatus('ready');
      return;
    }

    setListStatus('loading');
    try {
      const response = await listReports(workspaceId, resolution.projectId);
      setReports(response.reports);
      setListError(null);
      setListStatus('ready');
    } catch (error) {
      setListError(apiMessage(error, 'The report history could not be loaded.'));
      setListStatus('error');
    }
  }, [resolution, workspaceId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  const loadDetail = useCallback(
    async (reportId: string) => {
      setSelectedReportId(reportId);
      setDetailStatus('loading');
      setDetailError(null);
      try {
        const response = await getReport(workspaceId, reportId);
        setDetail(response);
        setRenameValue(response.report.title);
        setDetailStatus('ready');
      } catch (error) {
        setDetail(null);
        setDetailError(apiMessage(error, 'The report could not be loaded.'));
        setDetailStatus('error');
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    if (focusedReportId) void loadDetail(focusedReportId);
  }, [focusedReportId, loadDetail]);

  const handleGenerate = useCallback(
    async (report: ReportSummary) => {
      setBusyReportId(report.id);
      setActionError(null);
      setActionMessage(null);
      try {
        await generateReport(workspaceId, report.id);
        setActionMessage(
          report.status === 'ready' ? 'The PDF was regenerated from the stored snapshot.' : 'The report PDF was generated.',
        );
        await refreshHistory();
        if (selectedReportId === report.id) await loadDetail(report.id);
      } catch (error) {
        setActionError(apiMessage(error, 'The report PDF could not be generated.'));
        await refreshHistory();
      } finally {
        setBusyReportId(null);
      }
    },
    [loadDetail, refreshHistory, selectedReportId, workspaceId],
  );

  const handleRename = useCallback(async () => {
    if (!detail) return;
    setBusyReportId(detail.report.id);
    setActionError(null);
    setActionMessage(null);
    try {
      const updated = await updateReport(workspaceId, detail.report.id, {
        title: renameValue,
        subtitle: detail.report.subtitle,
        companyName: detail.report.companyName,
      });
      setDetail((current) => (current ? { ...current, report: updated } : current));
      setActionMessage('The report title was updated. The snapshot is unchanged.');
      await refreshHistory();
    } catch (error) {
      setActionError(apiMessage(error, 'The report could not be updated.'));
    } finally {
      setBusyReportId(null);
    }
  }, [detail, refreshHistory, renameValue, workspaceId]);

  const handleLogoSelected = useCallback(
    async (file: File) => {
      if (!detail) return;
      setBusyReportId(detail.report.id);
      setActionError(null);
      setActionMessage(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
        const updated = await uploadReportLogo(workspaceId, detail.report.id, bytes, mimeType);
        setDetail((current) => (current ? { ...current, report: updated } : current));
        setActionMessage('The logo was stored. Regenerate the PDF to print it.');
        await refreshHistory();
      } catch (error) {
        setActionError(apiMessage(error, 'The logo could not be stored.'));
      } finally {
        if (logoInputRef.current) logoInputRef.current.value = '';
        setBusyReportId(null);
      }
    },
    [detail, refreshHistory, workspaceId],
  );

  const handleClearLogo = useCallback(async () => {
    if (!detail) return;
    setBusyReportId(detail.report.id);
    setActionError(null);
    try {
      const updated = await clearReportLogo(workspaceId, detail.report.id);
      setDetail((current) => (current ? { ...current, report: updated } : current));
      setActionMessage('The logo reference was removed.');
      await refreshHistory();
    } catch (error) {
      setActionError(apiMessage(error, 'The logo could not be removed.'));
    } finally {
      setBusyReportId(null);
    }
  }, [detail, refreshHistory, workspaceId]);

  const handleCreateSample = useCallback(
    async (analysisId: string) => {
      if (resolution.status !== 'resolved') return;
      setBusyReportId(analysisId);
      setActionError(null);
      setActionMessage(null);
      try {
        const created = await createReport(workspaceId, {
          projectId: resolution.projectId,
          analysisId,
        });
        setActionMessage('The report was created from the stored analysis. Generate its PDF next.');
        await refreshHistory();
        await loadDetail(created.id);
      } catch (error) {
        setActionError(apiMessage(error, 'The report could not be created.'));
      } finally {
        setBusyReportId(null);
      }
    },
    [loadDetail, refreshHistory, resolution, workspaceId],
  );

  return (
    <section aria-label="Reports" className="reports-panel">
      <header className="section-heading-row">
        <div>
          <h1>
            <ScrollText aria-hidden="true" size={16} /> Reports
          </h1>
          <p>
            Every report is generated from an immutable stored analysis snapshot. Regenerating a PDF
            never reruns the analysis, and a newer model or newer data never changes an old report.
          </p>
        </div>
      </header>

      {projectsState.status === 'error' ? (
        <p className="scoring-error">
          <TriangleAlert aria-hidden="true" size={13} /> {projectsState.errorMessage}
        </p>
      ) : null}

      {projectsState.status === 'ready' && projectsState.projects.length > 1 ? (
        <div className="reports-project">
          <label htmlFor="reports-project-select">Project</label>
          <select
            id="reports-project-select"
            onChange={(event) => setProjectId(event.target.value)}
            value={projectId ?? ''}
          >
            <option disabled value="">
              Select a project
            </option>
            {projectsState.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {projectsState.status === 'ready' && projectsState.projects.length === 0 ? (
        <p className="scoring-empty">{NO_PROJECT_MESSAGE}</p>
      ) : null}

      {resolution.status === 'required' ? (
        <p className="scoring-empty">
          Select a project before working with reports. Reports are always limited to one project and
          never mix two.
        </p>
      ) : null}

      {resolution.status === 'unknown' ? (
        <p className="scoring-empty">
          Select a project before working with reports. Reports are always limited to one project and
          never mix two.
        </p>
      ) : null}

      {actionMessage ? <p className="scoring-success">{actionMessage}</p> : null}
      {actionError ? (
        <p className="scoring-error">
          <TriangleAlert aria-hidden="true" size={13} /> {actionError}
        </p>
      ) : null}

      {resolution.status === 'resolved' ? (
        <>
          <div className="section-heading-row scoring-history__heading">
            <div>
              <h2>Report history</h2>
              <p>Newest first. A report can only belong to the selected project.</p>
            </div>
            <button
              className="scoring-button scoring-button--quiet"
              disabled={listStatus === 'loading'}
              onClick={() => void refreshHistory()}
              type="button"
            >
              {listStatus === 'loading' ? (
                <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
              ) : (
                <RefreshCw aria-hidden="true" size={13} />
              )}
              Refresh
            </button>
          </div>

          {listStatus === 'error' ? (
            <p className="scoring-error">
              <TriangleAlert aria-hidden="true" size={13} /> {listError}
            </p>
          ) : null}

          {listStatus === 'ready' && reports.length === 0 ? (
            <p className="scoring-empty">
              No report has been created for this project yet. Run or open an analysis, then choose
              “Generate report”.
            </p>
          ) : null}

          {reports.length > 0 ? (
            <ul className="report-history">
              {reports.map((report) => (
                <li key={report.id}>
                  <div className="report-history__row">
                    <div className="report-history__copy">
                      <span className="report-history__title">
                        {report.title}
                        <span className={statusClass(report.status)}>{STATUS_LABELS[report.status]}</span>
                      </span>
                      <span className="report-history__meta">
                        {report.type === 'comparison' ? 'Comparison' : 'Single location'} · created{' '}
                        {formatTimestamp(report.createdAt)} · generated {formatTimestamp(report.generatedAt)}
                      </span>
                      {report.status === 'failed' ? (
                        <span className="report-history__failure">
                          <CircleAlert aria-hidden="true" size={12} /> The last generation attempt failed.
                          The snapshot was preserved, so a retry is safe.
                        </span>
                      ) : null}
                    </div>
                    <div className="report-history__actions">
                      <button
                        className="scoring-button scoring-button--quiet"
                        onClick={() => void loadDetail(report.id)}
                        type="button"
                      >
                        <FileText aria-hidden="true" size={13} /> Preview
                      </button>
                      {report.status === 'ready' ? (
                        <a
                          className="scoring-button scoring-button--quiet"
                          href={reportDownloadUrl(workspaceId, report.id)}
                        >
                          Download PDF
                        </a>
                      ) : null}
                      {canRun && report.status !== 'generating' ? (
                        <button
                          className="scoring-button scoring-button--quiet"
                          disabled={busyReportId === report.id}
                          onClick={() => void handleGenerate(report)}
                          type="button"
                        >
                          {busyReportId === report.id ? (
                            <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
                          ) : (
                            <RefreshCw aria-hidden="true" size={13} />
                          )}
                          {report.status === 'ready'
                            ? 'Regenerate PDF'
                            : report.status === 'failed'
                              ? 'Retry generation'
                              : 'Generate PDF'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {!canRun ? (
            <p className="report-permission-note">
              <Lock aria-hidden="true" size={13} /> Your role can preview and download ready reports. An
              owner, admin or analyst generates them.
            </p>
          ) : null}

          {detailStatus === 'loading' ? (
            <p className="scoring-empty">
              <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} /> Loading the
              report preview…
            </p>
          ) : null}

          {detailStatus === 'error' ? (
            <p className="scoring-error">
              <TriangleAlert aria-hidden="true" size={13} /> {detailError}
            </p>
          ) : null}

          {detailStatus === 'ready' && detail ? (
            <div className="report-detail">
              <div className="section-heading-row">
                <div>
                  <h2>{detail.report.title}</h2>
                  <p>
                    {detail.report.type === 'comparison' ? 'Comparison report' : 'Single-location report'} ·
                    status {STATUS_LABELS[detail.report.status]} · created{' '}
                    {formatTimestamp(detail.report.createdAt)}
                  </p>
                </div>
                {detail.report.status === 'ready' ? (
                  <a
                    className="scoring-button"
                    href={reportDownloadUrl(workspaceId, detail.report.id)}
                  >
                    Download PDF
                  </a>
                ) : null}
              </div>

              {canRun ? (
                <div className="report-detail__tools">
                  <label htmlFor="report-title-input">Title</label>
                  <input
                    id="report-title-input"
                    maxLength={160}
                    onChange={(event) => setRenameValue(event.target.value)}
                    type="text"
                    value={renameValue}
                  />
                  <button
                    className="scoring-button scoring-button--quiet"
                    disabled={busyReportId === detail.report.id || renameValue.trim().length === 0}
                    onClick={() => void handleRename()}
                    type="button"
                  >
                    Save title
                  </button>
                </div>
              ) : null}

              {canManage ? (
                <div className="report-detail__tools">
                  <span className="report-detail__tools-label">Branding</span>
                  <input
                    accept="image/png,image/jpeg"
                    aria-label="Upload report logo"
                    className="report-detail__file"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleLogoSelected(file);
                    }}
                    ref={logoInputRef}
                    type="file"
                  />
                  {detail.report.hasLogo ? (
                    <button
                      className="scoring-button scoring-button--quiet"
                      disabled={busyReportId === detail.report.id}
                      onClick={() => void handleClearLogo()}
                      type="button"
                    >
                      Remove logo
                    </button>
                  ) : (
                    <span className="report-detail__tools-label">
                      <Upload aria-hidden="true" size={12} /> PNG or JPEG, 2 MB maximum
                    </span>
                  )}
                </div>
              ) : null}

              {detail.viewModel ? (
                <ReportPreview
                  logoUrl={detail.report.hasLogo ? reportArtifactUrl(workspaceId, detail.report.id, 'logo') : null}
                  mapUrl={detail.report.hasMap ? reportArtifactUrl(workspaceId, detail.report.id, 'map') : null}
                  viewModel={detail.viewModel}
                />
              ) : (
                <p className="scoring-empty">
                  This report has no stored snapshot yet, so there is nothing to preview.
                </p>
              )}
            </div>
          ) : null}

          {canRun ? (
            <details className="report-create-from-analysis">
              <summary>Create a report from an existing stored analysis</summary>
              <p>
                Paste the identifier of a stored analysis of this project. Reports are always built from
                the stored snapshot, never from live data.
              </p>
              <CreateFromAnalysisForm busy={busyReportId !== null} onCreate={handleCreateSample} />
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CreateFromAnalysisForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (analysisId: string) => Promise<void>;
}) {
  const [analysisId, setAnalysisId] = useState('');
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  return (
    <div className="report-create-from-analysis__form">
      <label htmlFor="report-analysis-id">Analysis id</label>
      <input
        id="report-analysis-id"
        onChange={(event) => setAnalysisId(event.target.value.trim())}
        placeholder="00000000-0000-4000-8000-000000000000"
        type="text"
        value={analysisId}
      />
      <button
        className="scoring-button scoring-button--quiet"
        disabled={busy || !UUID_PATTERN.test(analysisId)}
        onClick={() => void onCreate(analysisId)}
        type="button"
      >
        Generate report
      </button>
    </div>
  );
}
