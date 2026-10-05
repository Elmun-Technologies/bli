'use client';

/**
 * The Phase 6 locations section.
 *
 * The user explicitly picks saved candidate locations, a radius and a model, and
 * then runs the analysis. Nothing here scores a map click on its own: a click
 * only selects a candidate. Every number shown comes from a stored payload the
 * database wrote, and the panel explains it as raw metric -> normalized value ->
 * weight -> contribution -> total.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Calculator,
  Download,
  Layers,
  LoaderCircle,
  MapPin,
  Play,
  Plus,
  Save,
  TriangleAlert,
} from 'lucide-react';

import { ReportCreateButton } from '@/components/app/report-create-button';
import { ScoringModelEditor } from '@/components/app/scoring-model-editor';
import {
  analysisFreshnessMessage,
  analysisHeadline,
  bandCaption,
  comparisonReady,
  mapCandidatesFromPayload,
  SCORING_TABS,
  retainProjectScopedSelection,
  scoringTabLabel,
  selectionMessage,
  snapshotSummary,
  toggleCandidateSelection,
  type ScoringMapCandidate,
  type ScoringSectionTab,
} from '@/components/app/scoring-state';
import type { SelectedLocation } from '@/lib/domain/map-location';
import type { DataSourceMode } from '@/lib/spatial/data-source';
import {
  formatMetricValue,
  formatRadius,
  formatScore,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
  RADIUS_PRESETS,
  SCORE_BANDS,
  scoreBandLabel,
} from '@/lib/scoring/catalogue';
import {
  createWorkspaceProject,
  listSavedCandidates,
  listScoringModels,
  listStoredAnalyses,
  listWorkspaceProjects,
  runAnalysis,
  saveCandidate,
  ScoringApiError,
} from '@/lib/scoring/client';
import {
  NO_PROJECT_MESSAGE,
  resolveProjectContext,
  type WorkspaceProjectSummary,
} from '@/lib/scoring/projects';
import { downloadComparisonCsv } from '@/lib/scoring/export';
import type {
  SavedCandidate,
  ScoringAnalysisPayload,
  ScoringModelSummary,
} from '@/lib/scoring/types';
import {
  buildBreakdown,
  buildComparisonRows,
  comparisonSortLabel,
  COMPARISON_SORT_KEYS,
  sortComparisonRows,
  type ComparisonSortKey,
} from '@/lib/scoring/view';

const RUN_ROLES = new Set(['owner', 'admin', 'analyst']);
const MANAGE_ROLES = new Set(['owner', 'admin']);

interface ScoringContext {
  status: 'loading' | 'ready' | 'error';
  /** The caller's own selectable projects, from the server. */
  projects: WorkspaceProjectSummary[];
  /** The project the loaded data belongs to; null while none is selected. */
  projectId: string | null;
  /** Several projects exist and the caller has not chosen one yet. */
  needsProjectSelection: boolean;
  models: ScoringModelSummary[];
  candidates: SavedCandidate[];
  history: ScoringAnalysisPayload[];
  errorMessage: string | null;
}

const INITIAL_CONTEXT: ScoringContext = {
  status: 'loading',
  projects: [],
  projectId: null,
  needsProjectSelection: false,
  models: [],
  candidates: [],
  history: [],
  errorMessage: null,
};

function apiMessage(error: unknown, fallback: string): string {
  return error instanceof ScoringApiError ? error.message : fallback;
}

export function LocationsPanel({
  workspaceId,
  workspaceRole,
  dataSource,
  initialProjectId,
  selectedLocation,
  focusedCandidateId,
  onFocusedCandidateHandled,
  onShowOnMap,
  onOpenMap,
  onOpenReport,
}: {
  workspaceId: string;
  workspaceRole: string;
  dataSource: DataSourceMode;
  /** `?project=` from the page URL: a deep link, never an authorization claim. */
  initialProjectId: string | null;
  selectedLocation: SelectedLocation;
  focusedCandidateId: string | null;
  onFocusedCandidateHandled: () => void;
  onShowOnMap: (candidates: ScoringMapCandidate[]) => void;
  onOpenMap: () => void;
  /** Opens the reports section focused on a freshly created report. */
  onOpenReport: (reportId: string) => void;
}) {
  const canRun = RUN_ROLES.has(workspaceRole);
  const canManage = MANAGE_ROLES.has(workspaceRole);
  const router = useRouter();

  const [tab, setTab] = useState<ScoringSectionTab>('analyze');
  const [context, setContext] = useState<ScoringContext>(INITIAL_CONTEXT);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [radiusMeters, setRadiusMeters] = useState(1_000);
  const [modelId, setModelId] = useState<string | null>(null);
  const [payload, setPayload] = useState<ScoringAnalysisPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [sortKey, setSortKey] = useState<ComparisonSortKey>('score');
  const [openBreakdownId, setOpenBreakdownId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  const history = context.history;
  /** The project the URL asks for; a switch updates it without a reload. */
  const urlProjectId = useRef<string | null>(initialProjectId);

  /**
   * Loads one explicitly requested project. The server decides which projects
   * exist, verifies the requested one against the caller's memberships and
   * answers for that project only; the interface never picks a project itself.
   */
  const loadProject = useCallback(
    async (requestedProjectId: string | null) => {
      setContext((current) => ({ ...current, status: 'loading', errorMessage: null }));
      try {
        const [models, projects] = await Promise.all([
          listScoringModels(workspaceId),
          listWorkspaceProjects(workspaceId),
        ]);

        const resolution = resolveProjectContext(projects, requestedProjectId);

        // Several projects and no explicit choice: show the selector, choose
        // nothing, and load no project-scoped data at all.
        if (resolution.status === 'required') {
          setContext({
            status: 'ready',
            projects,
            projectId: null,
            needsProjectSelection: true,
            models,
            candidates: [],
            history: [],
            errorMessage: null,
          });
          return;
        }

        // Zero projects: the safe empty state; nothing is created implicitly.
        if (resolution.status === 'empty') {
          setContext({
            status: 'ready',
            projects,
            projectId: null,
            needsProjectSelection: false,
            models,
            candidates: [],
            history: [],
            errorMessage: null,
          });
          return;
        }

        // The named project is not one of the caller's own: the server answers
        // exactly as it would for a missing project, and the interface shows
        // that safe refusal instead of substituting another project.
        const candidatesResponse = await listSavedCandidates(
          workspaceId,
          resolution.status === 'resolved' ? resolution.projectId : requestedProjectId,
        );
        const selectedProjectId = candidatesResponse.projectId;

        const analysesResponse = selectedProjectId
          ? await listStoredAnalyses(workspaceId, selectedProjectId, { limit: 8 })
          : { analyses: [] };

        setContext({
          status: 'ready',
          projects: candidatesResponse.projects,
          projectId: selectedProjectId,
          needsProjectSelection: false,
          models,
          candidates: candidatesResponse.candidates,
          history: analysesResponse.analyses,
          errorMessage: null,
        });
        if (selectedProjectId && urlProjectId.current !== selectedProjectId) {
          // The URL always names the project that answered, so a copied link and a
          // reload resolve to the same explicit context.
          urlProjectId.current = selectedProjectId;
          router.replace(
            `/workspaces/${workspaceId}?project=${encodeURIComponent(selectedProjectId)}`,
            { scroll: false },
          );
        }
        setModelId((current) => current ?? models.find((model) => model.status === 'active')?.id ?? models[0]?.id ?? null);
        setSelectedCandidateId((current) => {
          // A candidate of the previous project must never survive the switch.
          const retained = retainProjectScopedSelection(
            { selectedCandidateId: current, compareIds: [] },
            candidatesResponse.candidates,
          ).selectedCandidateId;
          return retained ?? candidatesResponse.candidates[0]?.id ?? null;
        });
        setCompareIds((current) =>
          retainProjectScopedSelection(
            { selectedCandidateId: null, compareIds: current },
            candidatesResponse.candidates,
          ).compareIds,
        );
      } catch (error) {
        setContext((current) => ({
          ...current,
          status: 'error',
          projectId: null,
          candidates: [],
          history: [],
          errorMessage: apiMessage(error, 'The scoring workspace could not be loaded.'),
        }));
      }
    },
    [router, workspaceId],
  );

  useEffect(() => {
    void loadProject(urlProjectId.current);
  }, [loadProject]);

  // Deep links and browser back/forward move `?project=`; a project the caller
  // may not use is passed to the server, which refuses it safely.
  useEffect(() => {
    if (initialProjectId === urlProjectId.current) return;
    urlProjectId.current = initialProjectId;
    void loadProject(initialProjectId);
  }, [initialProjectId, loadProject]);

  /**
   * Switching projects clears everything that belonged to the previous one
   * before the new project's data arrives: the selected candidate, the
   * comparison set, the shown payload and the markers on the map.
   */
  function selectProject(nextProjectId: string) {
    if (nextProjectId === context.projectId) return;

    setSelectedCandidateId(null);
    setCompareIds([]);
    setPayload(null);
    setOpenBreakdownId(null);
    setActionError(null);
    setActionMessage(null);
    setSaveOpen(false);
    onShowOnMap([]);

    urlProjectId.current = nextProjectId || null;
    const query = nextProjectId ? `?project=${encodeURIComponent(nextProjectId)}` : '';
    router.replace(`/workspaces/${workspaceId}${query}`, { scroll: false });
    void loadProject(nextProjectId || null);
  }

  async function submitProject() {
    if (!newProjectName.trim()) {
      setActionError('Give the project a name.');
      return;
    }

    setCreatingProject(true);
    setActionError(null);
    try {
      const project = await createWorkspaceProject(workspaceId, { name: newProjectName.trim() });
      setNewProjectName('');
      setSelectedCandidateId(null);
      setCompareIds([]);
      setPayload(null);
      urlProjectId.current = project.id;
      router.replace(`/workspaces/${workspaceId}?project=${encodeURIComponent(project.id)}`, {
        scroll: false,
      });
      await loadProject(project.id);
      setActionMessage(`Created “${project.name}”.`);
    } catch (error) {
      setActionError(apiMessage(error, 'The project could not be created.'));
    } finally {
      setCreatingProject(false);
    }
  }

  // A map marker click opens that candidate's stored breakdown. A marker that
  // belongs to another project never selects anything here: the id is dropped
  // instead of being carried into the current project.
  useEffect(() => {
    if (!focusedCandidateId) return;
    if (!context.candidates.some((candidate) => candidate.id === focusedCandidateId)) {
      onFocusedCandidateHandled();
      return;
    }
    setTab('analyze');
    setSelectedCandidateId(focusedCandidateId);

    const stored = history.find(
      (entry) =>
        entry.analysis.mode === 'analysis' &&
        entry.results.some((result) => result.candidateId === focusedCandidateId),
    );
    if (stored) {
      setPayload(stored);
      onShowOnMap(mapCandidatesFromPayload(stored));
    }
    onFocusedCandidateHandled();
  }, [context.candidates, focusedCandidateId, history, onFocusedCandidateHandled, onShowOnMap]);

  const activeModel = useMemo(
    () => context.models.find((model) => model.id === modelId) ?? null,
    [context.models, modelId],
  );

  async function refreshHistory(projectId: string) {
    try {
      const response = await listStoredAnalyses(workspaceId, projectId, { limit: 8 });
      setContext((current) => ({ ...current, history: response.analyses }));
    } catch {
      // A history refresh failure never invalidates the analysis that just ran.
    }
  }

  async function run(mode: 'analysis' | 'comparison') {
    if (!context.projectId || !modelId) return;
    const candidateIds = mode === 'analysis' ? (selectedCandidateId ? [selectedCandidateId] : []) : compareIds;
    if (candidateIds.length === 0) {
      setActionError('Select at least one saved site first.');
      return;
    }
    if (mode === 'comparison' && !comparisonReady(candidateIds.length)) {
      setActionError('A comparison needs between two and five saved sites.');
      return;
    }

    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await runAnalysis(workspaceId, {
        projectId: context.projectId,
        candidateIds,
        radiusMeters,
        scoringModelId: modelId,
        mode,
      });
      setPayload(result);
      setOpenBreakdownId(null);
      onShowOnMap(mapCandidatesFromPayload(result));
      await refreshHistory(context.projectId);
    } catch (error) {
      setActionError(apiMessage(error, 'The analysis could not be completed.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitCandidate() {
    if (!context.projectId) return;
    if (!saveName.trim()) {
      setActionError('Give the saved site a name.');
      return;
    }

    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const saved = await saveCandidate(workspaceId, {
        projectId: context.projectId,
        name: saveName.trim(),
        longitude: selectedLocation.coordinates[0],
        latitude: selectedLocation.coordinates[1],
      });
      setContext((current) => ({ ...current, candidates: [...current.candidates, saved] }));
      setSelectedCandidateId(saved.id);
      setSaveName('');
      setSaveOpen(false);
      const projectName = context.projects.find((project) => project.id === context.projectId)?.name;
      setActionMessage(
        projectName ? `Saved “${saved.name}” in “${projectName}”.` : `Saved “${saved.name}”.`,
      );
    } catch (error) {
      setActionError(apiMessage(error, 'The site could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  function openStoredAnalysis(entry: ScoringAnalysisPayload) {
    setPayload(entry);
    setTab(entry.analysis.mode === 'comparison' ? 'compare' : 'analyze');
    setOpenBreakdownId(entry.analysis.mode === 'comparison' ? entry.results[0]?.candidateId ?? null : null);
    onShowOnMap(mapCandidatesFromPayload(entry));
  }

  if (dataSource !== 'database') {
    return (
      <section aria-label="Location scoring" className="locations-panel">
        <header className="locations-panel__header">
          <div>
            <p className="section-eyebrow">LOCATION SCORING</p>
            <h1>Scoring needs the database workspace</h1>
          </div>
        </header>
        <p className="scoring-note">
          The fixture preview is a read-only sample of the map. Analyses, comparisons and scoring
          models run against the PostGIS workspace.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Location scoring" className="locations-panel">
      <header className="locations-panel__header">
        <div>
          <p className="section-eyebrow">LOCATION SCORING</p>
          <h1>Score a site, explain the score</h1>
        </div>
        <span className="preview-badge">{workspaceRole.toUpperCase()}</span>
      </header>

      {context.projects.length > 0 ? (
        <div className="locations-project">
          <label className="locations-project__field" htmlFor="locations-project-select">
            <span className="scoring-control__label">Project</span>
            <select
              id="locations-project-select"
              onChange={(event) => selectProject(event.target.value)}
              value={context.projectId ?? ''}
            >
              {context.projectId === null ? (
                <option disabled value="">
                  Select a project…
                </option>
              ) : null}
              {context.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <p className="locations-project__note">
            {context.projectId
              ? 'Saved sites, analyses and comparisons below belong to this project only.'
              : 'Choose a project. Nothing is selected for you, and no project is created automatically.'}
          </p>
        </div>
      ) : null}

      {context.status === 'ready' && context.projects.length === 0 ? (
        <div className="locations-project locations-project--empty">
          <p className="scoring-empty">
            <TriangleAlert aria-hidden="true" size={13} /> {NO_PROJECT_MESSAGE}
          </p>
          {canManage ? (
            <div className="scoring-save__row">
              <input
                maxLength={120}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder="New project name"
                value={newProjectName}
              />
              <button
                className="scoring-button"
                disabled={creatingProject}
                onClick={() => void submitProject()}
                type="button"
              >
                {creatingProject ? (
                  <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
                ) : (
                  <Plus aria-hidden="true" size={13} />
                )}{' '}
                Create project
              </button>
            </div>
          ) : (
            <small>Ask an owner or admin of this workspace to create a project.</small>
          )}
        </div>
      ) : null}

      <nav aria-label="Scoring sections" className="locations-tabs">
        {SCORING_TABS.map((entry) => (
          <button
            aria-current={tab === entry}
            className={`locations-tab${tab === entry ? ' is-active' : ''}`}
            key={entry}
            onClick={() => setTab(entry)}
            type="button"
          >
            {scoringTabLabel(entry)}
          </button>
        ))}
      </nav>

      {context.status === 'error' ? (
        <p className="scoring-error">
          <TriangleAlert aria-hidden="true" size={13} /> {context.errorMessage}
        </p>
      ) : null}

      {tab === 'models' ? (
        <ScoringModelEditor
          canManage={canManage}
          onModelsChanged={(models) => setContext((current) => ({ ...current, models }))}
          workspaceId={workspaceId}
        />
      ) : null}

      {tab !== 'models' && context.status === 'ready' && context.needsProjectSelection ? (
        <p className="scoring-empty">
          Select a project above to load its saved sites and stored analyses.
        </p>
      ) : null}

      {tab !== 'models' && context.status === 'loading' ? (
        <p className="scoring-loading">
          <LoaderCircle aria-hidden="true" className="scoring-spinner" size={14} /> Loading saved
          sites and models…
        </p>
      ) : null}

      {tab !== 'models' && context.status === 'ready' && context.projectId !== null ? (
        <>
          <div className="scoring-controls">
            <div className="scoring-control">
              <span className="scoring-control__label">Radius (shared by every candidate)</span>
              <div aria-label="Choose radius" className="radius-options" role="group">
                {RADIUS_PRESETS.map((preset) => (
                  <button
                    aria-pressed={radiusMeters === preset}
                    className={`radius-option${radiusMeters === preset ? ' is-active' : ''}`}
                    key={preset}
                    onClick={() => setRadiusMeters(preset)}
                    type="button"
                  >
                    {formatRadius(preset)}
                  </button>
                ))}
              </div>
              <label className="scoring-field scoring-field--compact">
                <span>Custom radius ({MIN_RADIUS_METERS}–{MAX_RADIUS_METERS} m)</span>
                <input
                  max={MAX_RADIUS_METERS}
                  min={MIN_RADIUS_METERS}
                  onChange={(event) => setRadiusMeters(Number(event.target.value))}
                  step={100}
                  type="number"
                  value={radiusMeters}
                />
              </label>
            </div>

            <label className="scoring-control scoring-control--field">
              <span className="scoring-control__label">Scoring model</span>
              <select onChange={(event) => setModelId(event.target.value)} value={modelId ?? ''}>
                {context.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.status} · revision {model.version}
                  </option>
                ))}
              </select>
              {activeModel ? (
                <small>
                  {activeModel.enabledFactorCount} enabled factors · weights total{' '}
                  {activeModel.enabledWeightTotal}
                </small>
              ) : (
                <small>No scoring model exists in this workspace yet.</small>
              )}
            </label>
          </div>

          {tab === 'analyze' ? (
            <div className="scoring-sites">
              <div className="section-heading-row">
                <div>
                  <h2>Saved sites</h2>
                  <p>Pick one site to score. A map click only selects; it never runs a score.</p>
                </div>
                <button
                  className="scoring-button scoring-button--quiet"
                  disabled={!canRun}
                  onClick={() => {
                    setSaveOpen((current) => !current);
                    setSaveName(selectedLocation.name);
                  }}
                  type="button"
                >
                  <Save aria-hidden="true" size={13} /> Save current point
                </button>
              </div>

              {saveOpen ? (
                <div className="scoring-save">
                  <p>
                    <MapPin aria-hidden="true" size={12} /> {selectedLocation.name} ·{' '}
                    {selectedLocation.coordinates[1].toFixed(5)}, {selectedLocation.coordinates[0].toFixed(5)}
                  </p>
                  <div className="scoring-save__row">
                    <input
                      maxLength={120}
                      onChange={(event) => setSaveName(event.target.value)}
                      placeholder="Site name"
                      value={saveName}
                    />
                    <button
                      className="scoring-button"
                      disabled={busy || !canRun}
                      onClick={() => void submitCandidate()}
                      type="button"
                    >
                      Save site
                    </button>
                  </div>
                  {!canRun ? (
                    <small>Your role can read analyses but cannot save new sites.</small>
                  ) : null}
                </div>
              ) : null}

              {context.candidates.length === 0 ? (
                <p className="scoring-empty">
                  No saved sites yet. Click the map, then save the point to score it.
                </p>
              ) : (
                <ul className="scoring-candidate-list">
                  {context.candidates.map((candidate) => (
                    <li key={candidate.id}>
                      <button
                        aria-pressed={candidate.id === selectedCandidateId}
                        className={`scoring-candidate${
                          candidate.id === selectedCandidateId ? ' is-active' : ''
                        }`}
                        onClick={() => setSelectedCandidateId(candidate.id)}
                        type="button"
                      >
                        <span className="scoring-candidate__name">{candidate.name}</span>
                        <span className="scoring-candidate__meta">
                          {candidate.latitude.toFixed(5)}, {candidate.longitude.toFixed(5)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button
                className="scoring-button scoring-button--primary"
                disabled={busy || !canRun || !selectedCandidateId || !modelId}
                onClick={() => void run('analysis')}
                type="button"
              >
                {busy ? (
                  <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
                ) : (
                  <Play aria-hidden="true" size={13} />
                )}
                Run analysis
              </button>
              {!canRun ? (
                <p className="scoring-note">
                  Running an analysis needs an owner, admin or analyst role. You can still read every
                  stored analysis.
                </p>
              ) : null}
            </div>
          ) : (
            <div className="scoring-sites">
              <div className="section-heading-row">
                <div>
                  <h2>Compare sites</h2>
                  <p>{selectionMessage(compareIds.length)}</p>
                </div>
                {compareIds.length > 0 ? (
                  <button
                    className="scoring-button scoring-button--quiet"
                    onClick={() => setCompareIds([])}
                    type="button"
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              {context.candidates.length === 0 ? (
                <p className="scoring-empty">
                  Save at least two sites first, then compare them side by side.
                </p>
              ) : (
                <ul className="scoring-candidate-list">
                  {context.candidates.map((candidate) => {
                    const selected = compareIds.includes(candidate.id);
                    return (
                      <li key={candidate.id}>
                        <label className={`scoring-candidate${selected ? ' is-active' : ''}`}>
                          <input
                            checked={selected}
                            onChange={() => setCompareIds((current) => toggleCandidateSelection(current, candidate.id))}
                            type="checkbox"
                          />
                          <span className="scoring-candidate__name">{candidate.name}</span>
                          <span className="scoring-candidate__meta">
                            {candidate.latitude.toFixed(5)}, {candidate.longitude.toFixed(5)}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}

              <button
                className="scoring-button scoring-button--primary"
                disabled={busy || !canRun || !comparisonReady(compareIds.length) || !modelId}
                onClick={() => void run('comparison')}
                type="button"
              >
                {busy ? (
                  <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
                ) : (
                  <Play aria-hidden="true" size={13} />
                )}
                Run comparison
              </button>
            </div>
          )}

          {actionMessage ? <p className="scoring-success">{actionMessage}</p> : null}
          {actionError ? (
            <p className="scoring-error">
              <TriangleAlert aria-hidden="true" size={13} /> {actionError}
            </p>
          ) : null}

          {payload ? (
            <StoredAnalysis
              canRun={canRun}
              onOpenMap={onOpenMap}
              onOpenReport={onOpenReport}
              onShowOnMap={() => onShowOnMap(mapCandidatesFromPayload(payload))}
              workspaceId={workspaceId}
              openBreakdownId={openBreakdownId}
              payload={payload}
              setOpenBreakdownId={setOpenBreakdownId}
              setSortKey={setSortKey}
              sortKey={sortKey}
            />
          ) : null}

          <div className="section-heading-row scoring-history__heading">
            <div>
              <h2>Stored analyses</h2>
              <p>Each row kept the model revision, metrics and score it was run with.</p>
            </div>
          </div>
          {history.length === 0 ? (
            <p className="scoring-empty">No analysis has been stored for this workspace yet.</p>
          ) : (
            <ul className="scoring-history">
              {history.map((entry) => (
                <li key={entry.analysis.id}>
                  <button
                    className="scoring-history__row"
                    onClick={() => openStoredAnalysis(entry)}
                    type="button"
                  >
                    <span className="scoring-history__mode">{entry.analysis.mode}</span>
                    <span className="scoring-history__name">
                      {entry.results[0]?.candidateName ?? 'No candidate'}
                      {entry.results.length > 1 ? ` +${entry.results.length - 1}` : ''}
                    </span>
                    <span className="scoring-history__score">
                      {formatScore(entry.results[0]?.finalScore ?? 0)}
                    </span>
                    <span className="scoring-history__meta">
                      {entry.analysis.modelName} v{entry.analysis.modelVersion} ·{' '}
                      {formatRadius(entry.analysis.radiusMeters)} ·{' '}
                      {entry.analysis.createdAt.slice(0, 16).replace('T', ' ')} UTC
                    </span>
                    <ArrowRight aria-hidden="true" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function StoredAnalysis({
  payload,
  workspaceId,
  canRun,
  sortKey,
  setSortKey,
  openBreakdownId,
  setOpenBreakdownId,
  onShowOnMap,
  onOpenMap,
  onOpenReport,
}: {
  payload: ScoringAnalysisPayload;
  workspaceId: string;
  canRun: boolean;
  sortKey: ComparisonSortKey;
  setSortKey: (key: ComparisonSortKey) => void;
  openBreakdownId: string | null;
  setOpenBreakdownId: (candidateId: string | null) => void;
  onShowOnMap: () => void;
  onOpenMap: () => void;
  onOpenReport: (reportId: string) => void;
}) {
  const headline = analysisHeadline(payload);
  const freshness = analysisFreshnessMessage(payload);
  const rows = useMemo(() => buildComparisonRows(payload), [payload]);
  const sortedRows = useMemo(() => {
    const sorted = sortComparisonRows(rows, sortKey);
    return payload.analysis.mode === 'comparison' ? sorted : rows;
  }, [payload.analysis.mode, rows, sortKey]);
  const breakdown = useMemo(() => {
    const target = payload.results.find((result) => result.candidateId === openBreakdownId) ?? payload.results[0];
    return target ? buildBreakdown(target) : null;
  }, [openBreakdownId, payload.results]);

  if (!headline || !breakdown) return null;

  return (
    <div className="scoring-result">
      <div className="scoring-score-card">
        <div>
          <p className="section-eyebrow">
            {payload.analysis.mode === 'comparison' ? 'TOP OF THE COMPARISON' : 'STORED SCORE'}
          </p>
          <h2>{headline.candidateName}</h2>
          <p className="scoring-score-card__snapshot">{snapshotSummary(payload)}</p>
        </div>
        <div className="scoring-score">
          <strong>{headline.scoreText}</strong>
          <span className={`scoring-band scoring-band--${scoreBandLabel(breakdown.finalScore).toLowerCase()}`}>
            {scoreBandLabel(breakdown.finalScore)}
          </span>
        </div>
      </div>

      <p className="scoring-score-card__caption">{bandCaption()}</p>
      <div className="scoring-bands">
        {SCORE_BANDS.map((band) => (
          <span key={band.label}>
            {band.label} {band.minimum}+
          </span>
        ))}
      </div>

      {freshness ? (
        <p className="scoring-freshness">
          <TriangleAlert aria-hidden="true" size={13} /> Analysis may be outdated. {freshness}
        </p>
      ) : null}

      <div className="scoring-result__actions">
        <button className="scoring-button scoring-button--quiet" onClick={onShowOnMap} type="button">
          <Layers aria-hidden="true" size={13} /> Show candidates on the map
        </button>
        <button className="scoring-button scoring-button--quiet" onClick={onOpenMap} type="button">
          <ArrowRight aria-hidden="true" size={13} /> Open the map
        </button>
        <ReportCreateButton
          analysisId={payload.analysis.id}
          disabled={!canRun}
          onCreated={onOpenReport}
          projectId={payload.analysis.projectId}
          workspaceId={workspaceId}
        />
        {payload.analysis.mode === 'comparison' ? (
          <button
            className="scoring-button scoring-button--quiet"
            onClick={() => downloadComparisonCsv(payload, sortedRows)}
            type="button"
          >
            <Download aria-hidden="true" size={13} /> Export metrics (CSV)
          </button>
        ) : null}
      </div>

      {payload.analysis.mode === 'comparison' ? (
        <div className="scoring-table-wrap">
          <div className="scoring-sort">
            <span>Sort by</span>
            {COMPARISON_SORT_KEYS.map((key) => (
              <button
                aria-pressed={sortKey === key}
                className={`scoring-sort__option${sortKey === key ? ' is-active' : ''}`}
                key={key}
                onClick={() => setSortKey(key)}
                type="button"
              >
                {comparisonSortLabel(key)}
              </button>
            ))}
          </div>
          <table className="scoring-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Score</th>
                <th scope="col">Customers</th>
                <th scope="col">Revenue</th>
                <th scope="col">Competitors</th>
                <th scope="col">Nearest branch</th>
                <th scope="col">POIs</th>
                <th scope="col">Customer density</th>
                <th scope="col">Competition</th>
                <th scope="col">Opportunity</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => (
                <tr key={row.candidateId}>
                  <th scope="row">
                    <button
                      className="scoring-table__site"
                      onClick={() => setOpenBreakdownId(row.candidateId)}
                      type="button"
                    >
                      <span className="scoring-table__label">{row.label}</span>
                      {row.candidateName}
                    </button>
                  </th>
                  <td>
                    {formatScore(row.score)}
                    <small>{row.band}</small>
                  </td>
                  <td>{row.customers}</td>
                  <td>{formatMetricValue('customers_revenue_total', row.revenueTotal)}</td>
                  <td>{row.competitors}</td>
                  <td>
                    {row.nearestBranchDistanceMeters === null
                      ? 'none'
                      : formatMetricValue('nearest_branch_distance_meters', row.nearestBranchDistanceMeters)}
                  </td>
                  <td>{row.poiCount}</td>
                  <td>{row.customerDensity.toFixed(2)}</td>
                  <td>{row.competitionScore === null ? '—' : row.competitionScore.toFixed(2)}</td>
                  <td>{row.opportunityScore.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="scoring-note">
            Every comparison uses one shared radius ({formatRadius(payload.analysis.radiusMeters)}), so
            the candidates are always measured on the same footprint.
          </p>
        </div>
      ) : null}

      <Breakdown
        breakdown={breakdown}
        candidates={payload.results.map((result) => ({
          candidateId: result.candidateId,
          name: result.candidateName,
          score: result.finalScore,
        }))}
        onSelect={(candidateId) => setOpenBreakdownId(candidateId)}
        selectedId={breakdown.candidateId}
      />
    </div>
  );
}

function Breakdown({
  breakdown,
  candidates,
  selectedId,
  onSelect,
}: {
  breakdown: ReturnType<typeof buildBreakdown>;
  candidates: Array<{ candidateId: string; name: string; score: number }>;
  selectedId: string;
  onSelect: (candidateId: string) => void;
}) {
  return (
    <div className="scoring-breakdown">
      <div className="section-heading-row">
        <div>
          <h2>
            <Calculator aria-hidden="true" size={14} /> Why this score
          </h2>
          <p>
            Raw metric → normalized 0–100 → weight → contribution → total. Contributions are rounded
            to two decimals and added, exactly as stored.
          </p>
        </div>
        <span className={`scoring-consistency${breakdown.consistent ? ' is-valid' : ''}`}>
          {breakdown.contributionTotal} = {breakdown.finalScore}
        </span>
      </div>

      {candidates.length > 1 ? (
        <div className="scoring-breakdown__candidates">
          {candidates.map((candidate) => (
            <button
              aria-pressed={candidate.candidateId === selectedId}
              className={`scoring-breakdown__candidate${
                candidate.candidateId === selectedId ? ' is-active' : ''
              }`}
              key={candidate.candidateId}
              onClick={() => onSelect(candidate.candidateId)}
              type="button"
            >
              {candidate.name} · {formatScore(candidate.score)}
            </button>
          ))}
        </div>
      ) : null}

      <table className="scoring-table scoring-table--breakdown">
        <thead>
          <tr>
            <th scope="col">Factor</th>
            <th scope="col">Metric (raw)</th>
            <th scope="col">Normalized</th>
            <th scope="col">Weight</th>
            <th scope="col">Contribution</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                {row.label}
                <small>
                  {row.direction} · {row.normalization}
                </small>
              </th>
              <td>
                {row.rawDisplay}
                <small>{row.metricLabel}</small>
              </td>
              <td>{row.normalized.toFixed(2)}</td>
              <td>{row.weight}%</td>
              <td>{row.contribution.toFixed(2)}</td>
            </tr>
          ))}
          <tr className="scoring-table__total">
            <th scope="row">Total</th>
            <td />
            <td />
            <td>100%</td>
            <td>{breakdown.contributionTotal.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      <ul className="scoring-explanations">
        {breakdown.rows.map((row) => (
          <li key={`${row.key}-explanation`}>
            <strong>{row.label}</strong> {row.explanation} Contribution {row.contribution.toFixed(2)}.
          </li>
        ))}
      </ul>
    </div>
  );
}
