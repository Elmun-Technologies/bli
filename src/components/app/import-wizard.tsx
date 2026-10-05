'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Database,
  Download,
  Loader2,
  MapPin,
  RefreshCw,
  Upload,
} from 'lucide-react';

import {
  applyMapping,
  type CommitSummaryPayload,
  commitImport,
  createImport,
  errorExportUrl,
  getImport,
  ImportRequestFailure,
  listDatasets,
  listImportRows,
  listImports,
  runGeocodeBatch,
  setManualPoint,
  uploadImportFile,
  type ImportJobPayload,
  type PreviewPagePayload,
} from '@/lib/imports/client';
import { IMPORT_LIMITS } from '@/lib/imports/limits';
import {
  EMPTY_COUNTERS,
  buildSummary,
  IMPORT_STEP_LABELS,
  IMPORT_STEPS,
  jobStatusLabel,
  stepForJobStatus,
  type ImportStep,
} from '@/components/app/import-state';

const STATUS_FILTERS = [
  { id: 'all', label: 'All rows' },
  { id: 'valid', label: 'Valid' },
  { id: 'invalid', label: 'Invalid' },
  { id: 'needs_geocoding', label: 'Needs geocoding' },
  { id: 'committed', label: 'Imported' },
] as const;

const CUSTOMER_FIELDS = [
  'name',
  'external_id',
  'phone',
  'company',
  'address',
  'latitude',
  'longitude',
  'revenue',
  'order_count',
  'last_order_date',
  'segment',
  'source',
] as const;

const LOCATION_FIELDS = ['name', 'category', 'subcategory', 'address', 'latitude', 'longitude', 'external_id'] as const;

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  external_id: 'External id',
  phone: 'Phone (never shown on the map)',
  company: 'Company',
  address: 'Address',
  latitude: 'Latitude',
  longitude: 'Longitude',
  revenue: 'Revenue (exact decimal)',
  order_count: 'Order count',
  last_order_date: 'Last order date',
  segment: 'Segment',
  category: 'Category',
  subcategory: 'Subcategory',
  source: 'Source label',
};

interface ImportWizardProps {
  workspaceId: string;
  canWrite: boolean;
  onViewOnMap: () => void;
}

export function ImportWizard({ workspaceId, canWrite, onViewOnMap }: ImportWizardProps) {
  const [step, setStep] = useState<ImportStep>('upload');
  const [imports, setImports] = useState<ImportJobPayload[]>([]);
  const [job, setJob] = useState<ImportJobPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Step 1 state
  const [targetEntity, setTargetEntity] = useState<'customers' | 'locations'>('customers');
  const [destinationMode, setDestinationMode] = useState<'new' | 'existing'>('new');
  const [newDatasetName, setNewDatasetName] = useState('');
  const [datasetId, setDatasetId] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string; type: string }>>([]);
  const [file, setFile] = useState<File | null>(null);
  const [requiresSheetSelection, setRequiresSheetSelection] = useState(false);

  // Step 3 state
  const [mapping, setMapping] = useState<Record<string, string>>({});

  // Step 4 state
  const [preview, setPreview] = useState<PreviewPagePayload | null>(null);
  const [previewStatus, setPreviewStatus] = useState<(typeof STATUS_FILTERS)[number]['id']>('all');
  const [previewPage, setPreviewPage] = useState(1);

  // Step 5/6 state
  const [geocodingRuns, setGeocodingRuns] = useState(0);
  const [manualRowId, setManualRowId] = useState<string | null>(null);
  const [manualLongitude, setManualLongitude] = useState('');
  const [manualLatitude, setManualLatitude] = useState('');
  const [summary, setSummary] = useState<CommitSummaryPayload | null>(null);
  const cancelled = useRef(false);

  const counters = useMemo(() => job?.counters ?? EMPTY_COUNTERS, [job]);

  const refreshImports = useCallback(async () => {
    try {
      const { imports: list } = await listImports(workspaceId);
      setImports(list);
    } catch {
      // A listing failure must not block starting a new import.
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshImports();
    void listDatasets(workspaceId)
      .then(setDatasets)
      .catch(() => setDatasets([]));
  }, [refreshImports, workspaceId]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>, options: { notice?: string } = {}): Promise<T | null> => {
      setBusy(true);
      setError(null);
      if (options.notice) setNotice(options.notice);
      try {
        const result = await action();
        setNotice(null);
        return result;
      } catch (failure) {
        setNotice(null);
        setError(
          failure instanceof ImportRequestFailure
            ? failure.message
            : 'The import could not be completed. Please try again.',
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const refreshJob = useCallback(
    async (importId: string) => {
      const { import: fresh } = await getImport(workspaceId, importId);
      setJob(fresh);
      return fresh;
    },
    [workspaceId],
  );

  const loadPreview = useCallback(
    async (status: (typeof STATUS_FILTERS)[number]['id'] = previewStatus, page = 1) => {
      if (!job) return;
      const page_ = await run(() => listImportRows(workspaceId, job.id, { status, page, pageSize: IMPORT_LIMITS.previewPageSize }));
      if (page_) {
        setPreview(page_);
        setPreviewStatus(status);
        setPreviewPage(page);
      }
    },
    [job, previewStatus, run, workspaceId],
  );

  const openImport = useCallback(
    async (candidate: ImportJobPayload) => {
      setSummary(null);
      const fresh = await run(() => getImport(workspaceId, candidate.id).then((r) => r.import));
      if (!fresh) return;
      setJob(fresh);
      setMapping(fresh.mapping ?? {});
      setTargetEntity(fresh.targetEntity);
      setStep(stepForJobStatus(fresh.status, fresh.counters.totalRows > 0));
      if (fresh.counters.totalRows > 0) {
        await loadPreview('all', 1);
      }
    },
    [loadPreview, run, workspaceId],
  );

  const handleUpload = useCallback(async () => {
    if (!file) {
      setError('Choose a CSV or XLSX file first.');
      return;
    }
    if (destinationMode === 'new' && newDatasetName.trim() === '') {
      setError('Name the new dataset, or choose an existing one.');
      return;
    }
    if (destinationMode === 'existing' && !datasetId) {
      setError('Choose the dataset to import into.');
      return;
    }

    const created = await run(() =>
      createImport(workspaceId, {
        filename: file.name,
        fileType: file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv',
        targetEntity,
      }).then((response) => response.import),
    );
    if (!created) return;

    const uploaded = await run(() => uploadImportFile(workspaceId, created.id, file));
    if (!uploaded) {
      await refreshImports();
      return;
    }

    setJob(uploaded.job);
    setRequiresSheetSelection(uploaded.requiresSheetSelection);
    setMapping(
      Object.fromEntries(
        uploaded.suggestions
          .filter((suggestion) => suggestion.confidence === 'exact' && suggestion.field)
          .map((suggestion) => [suggestion.header, suggestion.field as string]),
      ),
    );
    setStep('columns');
    await refreshImports();
  }, [datasetId, destinationMode, file, newDatasetName, refreshImports, run, targetEntity, workspaceId]);

  const handleSheetChoice = useCallback(
    async (sheetName: string) => {
      if (!job || !file) return;
      const uploaded = await run(() => uploadImportFile(workspaceId, job.id, file, sheetName));
      if (!uploaded) return;
      setJob(uploaded.job);
      setRequiresSheetSelection(false);
      setMapping(
        Object.fromEntries(
          uploaded.suggestions
            .filter((suggestion) => suggestion.confidence === 'exact' && suggestion.field)
            .map((suggestion) => [suggestion.header, suggestion.field as string]),
        ),
      );
    },
    [file, job, run, workspaceId],
  );

  const handleApplyMapping = useCallback(async () => {
    if (!job) return;
    const result = await run(() => applyMapping(workspaceId, job.id, mapping), {
      notice: 'Validating every row...',
    });
    if (!result) return;
    setJob(result.job);
    setStep('validation');
    await loadPreview('all', 1);
  }, [job, loadPreview, mapping, run, workspaceId]);

  const handleGeocodeBatches = useCallback(async () => {
    if (!job) return;
    cancelled.current = false;
    setStep('geocoding');
    setBusy(true);
    setError(null);

    let runs = 0;
    try {
      for (;;) {
        if (cancelled.current) break;
        const { summary: batch } = await runGeocodeBatch(workspaceId, job.id, IMPORT_LIMITS.defaultGeocodeBatchSize);
        runs += 1;
        setGeocodingRuns(runs);

        const applied = Number(batch?.applied ?? 0);
        const needsGeocoding = Number(batch?.needs_geocoding_rows ?? 0);
        const fresh = await refreshJob(job.id);

        if (applied === 0 || needsGeocoding === 0) {
          setNotice(
            needsGeocoding === 0
              ? 'Every address has a coordinate. Review the outcome and commit when ready.'
              : 'No more rows can be geocoded automatically; the remaining rows need a decision.',
          );
          break;
        }

        if (fresh.counters.failedGeocodingRows >= needsGeocoding) {
          setNotice('The geocoding provider could not resolve the remaining rows. You can retry, place points manually, or commit the rest.');
          break;
        }
      }
      await refreshJob(job.id);
      await loadPreview('needs_geocoding', 1);
    } catch (failure) {
      setError(
        failure instanceof ImportRequestFailure
          ? failure.message
          : 'Geocoding stopped unexpectedly. Rows already resolved stay resolved.',
      );
    } finally {
      setBusy(false);
    }
  }, [job, loadPreview, refreshJob, workspaceId]);

  const handleManualPoint = useCallback(async () => {
    if (!job || !manualRowId) return;
    const longitude = Number.parseFloat(manualLongitude);
    const latitude = Number.parseFloat(manualLatitude);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      setError('Enter numeric longitude and latitude.');
      return;
    }

    const updated = await run(() =>
      setManualPoint(workspaceId, job.id, manualRowId, longitude, latitude).then((r) => r.import),
    );
    if (!updated) return;
    setJob(updated);
    setManualRowId(null);
    setManualLongitude('');
    setManualLatitude('');
    setNotice('Manual placement saved for that row.');
    await loadPreview(previewStatus, previewPage);
  }, [job, loadPreview, manualLatitude, manualLongitude, manualRowId, previewPage, previewStatus, run, workspaceId]);

  const handleCommit = useCallback(async () => {
    if (!job) return;
    const result = await run(() =>
      commitImport(workspaceId, job.id, {
        datasetId: destinationMode === 'existing' ? datasetId : null,
        newDatasetName: destinationMode === 'new' ? newDatasetName.trim() || null : null,
        newDatasetType: job.targetEntity,
      }),
    );
    if (!result) return;
    setSummary(result.summary);
    await refreshJob(job.id);
    await refreshImports();
    await loadPreview('all', 1);
  }, [datasetId, destinationMode, job, loadPreview, newDatasetName, refreshImports, refreshJob, run, workspaceId]);

  const destinationLabel = useMemo(() => {
    if (destinationMode === 'existing') {
      const found = datasets.find((dataset) => dataset.id === datasetId);
      return found ? found.name : 'the selected dataset';
    }
    return newDatasetName.trim() || 'a new dataset';
  }, [datasetId, datasets, destinationMode, newDatasetName]);

  const summaryView = useMemo(
    () =>
      summary
        ? buildSummary({
            counters,
            geocodedRows: counters.geocodedRows,
            coordinatesSupplied: Math.max(counters.validRows - counters.geocodedRows, 0),
            datasetCreated: summary.datasetCreated === true,
            destination: destinationLabel,
          })
        : null,
    [counters, destinationLabel, summary],
  );

  if (!canWrite) {
    return (
      <main className="coming-soon">
        <div className="coming-soon__card">
          <span className="coming-soon__icon" aria-hidden="true">
            <Database size={22} strokeWidth={1.7} />
          </span>
          <span className="coming-soon__eyebrow">IMPORTS · READ-ONLY ROLE</span>
          <h1>Imports</h1>
          <p>
            Your role in this workspace can view data but not import it. Ask an owner, admin or analyst to run
            the import.
          </p>
          <button className="button button--primary" onClick={onViewOnMap} type="button">
            <ArrowLeft aria-hidden="true" size={16} />
            Return to map
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="import-workspace">
      <header className="import-workspace__header">
        <div>
          <span className="import-workspace__eyebrow">IMPORTS · CSV / XLSX</span>
          <h1>Import workspace data</h1>
          <p className="import-workspace__subtitle">
            Upload, map, validate and geocode a file, then promote the rows you accept into a dataset. Staged rows
            are private to this workspace.
          </p>
        </div>
        <ol className="import-steps" aria-label="Import steps">
          {IMPORT_STEPS.map((candidate, index) => (
            <li
              key={candidate}
              className={`import-step${candidate === step ? ' import-step--active' : ''}${
                IMPORT_STEPS.indexOf(step) > index ? ' import-step--done' : ''
              }`}
            >
              <span className="import-step__index">{index + 1}</span>
              <span>{IMPORT_STEP_LABELS[candidate]}</span>
            </li>
          ))}
        </ol>
      </header>

      {error ? (
        <p className="import-alert import-alert--error" role="alert">
          <AlertTriangle aria-hidden="true" size={15} /> {error}
        </p>
      ) : null}
      {notice && !error ? (
        <p className="import-alert" role="status">
          {busy ? <Loader2 aria-hidden="true" size={15} className="import-spin" /> : <BadgeCheck aria-hidden="true" size={15} />}
          {notice}
        </p>
      ) : null}

      <div className="import-grid">
        <section className="import-panel" aria-live="polite">
          {step === 'upload' ? (
            <>
              <h2>1. Choose the file and its destination</h2>
              <div className="import-field">
                <label htmlFor="import-target">What does this file contain?</label>
                <select
                  id="import-target"
                  onChange={(event) => setTargetEntity(event.target.value as 'customers' | 'locations')}
                  value={targetEntity}
                >
                  <option value="customers">Customer records</option>
                  <option value="locations">Locations / places</option>
                </select>
              </div>

              <fieldset className="import-fieldset">
                <legend>Where should the validated rows go?</legend>
                <label className="import-radio">
                  <input
                    checked={destinationMode === 'new'}
                    name="destination"
                    onChange={() => setDestinationMode('new')}
                    type="radio"
                  />
                  <span>Create a new dataset</span>
                </label>
                {destinationMode === 'new' ? (
                  <input
                    aria-label="New dataset name"
                    className="import-input"
                    onChange={(event) => setNewDatasetName(event.target.value)}
                    placeholder="e.g. Tashkent customers · March"
                    value={newDatasetName}
                  />
                ) : null}
                <label className="import-radio">
                  <input
                    checked={destinationMode === 'existing'}
                    name="destination"
                    onChange={() => setDestinationMode('existing')}
                    type="radio"
                  />
                  <span>Import into an existing dataset</span>
                </label>
                {destinationMode === 'existing' ? (
                  <select
                    aria-label="Existing dataset"
                    className="import-input"
                    onChange={(event) => setDatasetId(event.target.value || null)}
                    value={datasetId ?? ''}
                  >
                    <option value="">Choose a dataset...</option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} ({dataset.type})
                      </option>
                    ))}
                  </select>
                ) : null}
              </fieldset>

              <div className="import-field">
                <label htmlFor="import-file">File (.csv or .xlsx, up to 5 MB, 10,000 rows)</label>
                <input
                  accept=".csv,.xlsx"
                  id="import-file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </div>

              <button className="button button--primary" disabled={busy} onClick={handleUpload} type="button">
                {busy ? <Loader2 aria-hidden="true" className="import-spin" size={16} /> : <Upload aria-hidden="true" size={16} />}
                Upload and inspect
              </button>
            </>
          ) : null}

          {step === 'columns' && job ? (
            <>
              <h2>2. Detected columns</h2>
              <p className="import-muted">
                {job.originalFilename} · {job.fileType.toUpperCase()}
                {job.sheetName ? ` · sheet “${job.sheetName}”` : ''} · {job.sheets.length || 1} sheet(s)
              </p>

              {requiresSheetSelection ? (
                <>
                  <p className="import-muted">
                    This workbook has more than one sheet with data. Choose the one to import - only that sheet is
                    read.
                  </p>
                  <ul className="import-list">
                    {job.sheets.map((sheet) => (
                      <li key={sheet.name}>
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => void handleSheetChoice(sheet.name)}
                          type="button"
                        >
                          {sheet.name} · {sheet.rowCount} row(s)
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p className="import-muted">
                    {job.headers.length} column(s) detected, up to 100 accepted. Headers are matched against known
                    English, Uzbek and Russian names; every suggestion stays editable.
                  </p>
                  <ul className="import-list import-list--columns">
                    {job.headers.map((header) => (
                      <li key={header}>
                        <code>{header}</code>
                      </li>
                    ))}
                  </ul>
                  {job.warnings.length > 0 ? (
                    <ul className="import-warnings">
                      {job.warnings.map((warning) => (
                        <li key={warning}>
                          <AlertTriangle aria-hidden="true" size={13} /> {warning}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <button className="button button--primary" onClick={() => setStep('mapping')} type="button">
                    Map columns <ArrowRight aria-hidden="true" size={16} />
                  </button>
                </>
              )}
            </>
          ) : null}

          {step === 'mapping' && job ? (
            <>
              <h2>3. Map columns to fields</h2>
              <p className="import-muted">
                Suggestions are marked <strong>suggested</strong>; nothing is imported on a guess. Leave a column
                unmapped to ignore it.
              </p>
              <table className="import-table">
                <thead>
                  <tr>
                    <th scope="col">Source column</th>
                    <th scope="col">Imports as</th>
                  </tr>
                </thead>
                <tbody>
                  {job.headers.map((header) => {
                    const suggestion = job.suggestions.find((entry) => entry.header === header);
                    const fields = job.targetEntity === 'customers' ? CUSTOMER_FIELDS : LOCATION_FIELDS;
                    return (
                      <tr key={header}>
                        <td>
                          <code>{header}</code>
                          {suggestion?.confidence === 'partial' ? (
                            <span className="import-badge import-badge--warn">possible match</span>
                          ) : null}
                          {suggestion?.confidence === 'exact' ? (
                            <span className="import-badge">suggested</span>
                          ) : null}
                        </td>
                        <td>
                          <select
                            aria-label={`Import ${header} as`}
                            onChange={(event) =>
                              setMapping((current) => {
                                const next = { ...current };
                                if (event.target.value === '') delete next[header];
                                else next[header] = event.target.value;
                                return next;
                              })
                            }
                            value={mapping[header] ?? ''}
                          >
                            <option value="">Ignore this column</option>
                            {fields.map((field) => (
                              <option key={field} value={field}>
                                {FIELD_LABELS[field] ?? field}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="import-actions">
                <button className="button" onClick={() => setStep('columns')} type="button">
                  <ArrowLeft aria-hidden="true" size={16} /> Back
                </button>
                <button className="button button--primary" disabled={busy} onClick={handleApplyMapping} type="button">
                  {busy ? <Loader2 aria-hidden="true" className="import-spin" size={16} /> : null}
                  Validate rows
                </button>
              </div>
            </>
          ) : null}

          {step === 'validation' && job ? (
            <>
              <h2>4. Validation</h2>
              <div className="import-metrics">
                <Metric label="Rows in file" value={counters.totalRows} />
                <Metric label="Valid" value={counters.validRows} tone="ok" />
                <Metric label="Needs geocoding" value={counters.needsGeocodingRows} tone="warn" />
                <Metric label="Invalid" value={counters.invalidRows} tone="bad" />
                <Metric label="Imported" value={counters.committedRows} />
              </div>
              <p className="import-muted">
                No row is ever dropped silently: invalid rows stay staged with their error and can be exported.
              </p>
              <div className="import-actions">
                <button
                  className="button"
                  onClick={() => void loadPreview('all', 1)}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={15} /> Refresh preview
                </button>
                <a className="button" href={errorExportUrl(workspaceId, job.id)}>
                  <Download aria-hidden="true" size={15} /> Export rows needing attention (CSV)
                </a>
                {counters.needsGeocodingRows > 0 ? (
                  <button className="button button--primary" disabled={busy} onClick={handleGeocodeBatches} type="button">
                    {busy ? <Loader2 aria-hidden="true" className="import-spin" size={16} /> : <MapPin aria-hidden="true" size={16} />}
                    Geocode {counters.needsGeocodingRows} address row(s)
                  </button>
                ) : (
                  <button className="button button--primary" onClick={() => setStep('commit')} type="button">
                    Review &amp; commit <ArrowRight aria-hidden="true" size={16} />
                  </button>
                )}
              </div>
            </>
          ) : null}

          {step === 'geocoding' && job ? (
            <>
              <h2>5. Geocoding</h2>
              <div className="import-metrics">
                <Metric label="Batches run" value={geocodingRuns} />
                <Metric label="Geocoded" value={counters.geocodedRows} tone="ok" />
                <Metric label="Still waiting" value={counters.needsGeocodingRows} tone="warn" />
                <Metric label="Failed geocoding" value={counters.failedGeocodingRows} tone="bad" />
              </div>
              <p className="import-muted">
                Batches are bounded and resumable ({IMPORT_LIMITS.maxGeocodeBatchSize} rows per call maximum).
                Failures are never permanent: unresolved rows can be retried, placed manually, or left staged.
              </p>
              <div className="import-actions">
                <button className="button" disabled={!busy} onClick={() => (cancelled.current = true)} type="button">
                  Stop after this batch
                </button>
                <button className="button" disabled={busy} onClick={handleGeocodeBatches} type="button">
                  {busy ? <Loader2 aria-hidden="true" className="import-spin" size={16} /> : <RefreshCw aria-hidden="true" size={15} />}
                  Continue geocoding
                </button>
                <button className="button button--primary" onClick={() => setStep('commit')} type="button">
                  Review &amp; commit <ArrowRight aria-hidden="true" size={16} />
                </button>
              </div>
            </>
          ) : null}

          {step === 'commit' && job ? (
            <>
              <h2>6. Review &amp; commit</h2>
              <div className="import-metrics">
                <Metric label="Ready to import" value={counters.validRows - counters.committedRows} tone="ok" />
                <Metric label="Already imported" value={counters.committedRows} />
                <Metric label="Needs review" value={counters.needsGeocodingRows + counters.invalidRows} tone="warn" />
                <Metric label="Geocoded" value={counters.geocodedRows} />
              </div>
              <p className="import-muted">
                Rows go to <strong>{destinationLabel}</strong> in one transaction. Rows that need review or are invalid
                stay staged and are never promoted silently.
              </p>
              {summaryView ? (
                <div className="import-result">
                  <h3>Import result</h3>
                  <ul>
                    <li>{summaryView.imported} row(s) imported</li>
                    <li>{summaryView.geocoded} row(s) geocoded from an address</li>
                    <li>{summaryView.coordinatesSupplied} row(s) supplied coordinates directly</li>
                    <li>{summaryView.needsReview} row(s) need review</li>
                    <li>{summaryView.failed} row(s) failed geocoding</li>
                    <li>
                      {summaryView.datasetCreated ? 'Dataset created' : 'Dataset updated'}:{' '}
                      {summaryView.destination}
                    </li>
                  </ul>
                  <button className="button button--primary" onClick={onViewOnMap} type="button">
                    <MapPin aria-hidden="true" size={16} /> View on map
                  </button>
                </div>
              ) : null}
              <div className="import-actions">
                <button className="button" onClick={() => setStep('validation')} type="button">
                  <ArrowLeft aria-hidden="true" size={16} /> Back to validation
                </button>
                <button
                  className="button button--primary"
                  disabled={busy || counters.validRows - counters.committedRows === 0}
                  onClick={handleCommit}
                  type="button"
                >
                  {busy ? <Loader2 aria-hidden="true" className="import-spin" size={16} /> : <Database aria-hidden="true" size={16} />}
                  Import {counters.validRows - counters.committedRows} row(s)
                </button>
              </div>
            </>
          ) : null}
        </section>

        <aside className="import-panel import-panel--side">
          <h2>Row preview</h2>
          <p className="import-muted">
            {preview
              ? `${preview.total} row(s) in this filter · page ${preview.page} of ${preview.totalPages}`
              : job
                ? 'Validate the file to see rows.'
                : 'Start an import to see a preview.'}
          </p>

          {job && job.counters.totalRows > 0 ? (
            <>
              <div className="import-filters">
                {STATUS_FILTERS.map((filter) => (
                  <button
                    className={`import-chip${previewStatus === filter.id ? ' import-chip--active' : ''}`}
                    key={filter.id}
                    onClick={() => void loadPreview(filter.id, 1)}
                    type="button"
                  >
                    {filter.label}
                  </button>
                ))}
              </div>

              {preview ? (
                <>
                  <table className="import-table import-table--preview">
                    <thead>
                      <tr>
                        <th scope="col">Row</th>
                        <th scope="col">Values</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row) => (
                        <tr key={row.rowNumber}>
                          <td>{row.rowNumber}</td>
                          <td>
                            <code>
                              {Object.entries(row.normalizedData)
                                .filter(([, value]) => value !== null && value !== '')
                                .slice(0, 4)
                                .map(([field, value]) => `${field}=${value}`)
                                .join(' · ') || '(no mapped values)'}
                            </code>
                          </td>
                          <td>
                            <span className={`import-badge import-badge--${badgeTone(row.validationStatus)}`}>
                              {row.validationStatus.replace('_', ' ')}
                            </span>
                            {row.geocodingStatus !== 'not_required' ? (
                              <span className="import-badge">{row.geocodingStatus.replace('_', ' ')}</span>
                            ) : null}
                            {row.errors.slice(0, 2).map((rowError) => (
                              <span className="import-error" key={`${row.rowNumber}-${rowError.code}-${rowError.field}`}>
                                {rowError.field}: {rowError.message}
                              </span>
                            ))}
                            {row.manualOverride ? (
                              <span className="import-badge import-badge--warn">manual point</span>
                            ) : null}
                            {row.manualOverride || row.validationStatus !== 'valid' ? (
                              <button
                                className="button button--link"
                                onClick={() => {
                                  setManualRowId(row.committedRecordId ? null : row.rowId);
                                  setManualLongitude(row.longitude !== null ? String(row.longitude) : '');
                                  setManualLatitude(row.latitude !== null ? String(row.latitude) : '');
                                }}
                                type="button"
                              >
                                Place manually
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="import-pagination">
                    <button
                      className="button"
                      disabled={preview.page <= 1}
                      onClick={() => void loadPreview(previewStatus, preview.page - 1)}
                      type="button"
                    >
                      Previous
                    </button>
                    <span className="import-muted">
                      {preview.page} / {preview.totalPages}
                    </span>
                    <button
                      className="button"
                      disabled={preview.page >= preview.totalPages}
                      onClick={() => void loadPreview(previewStatus, preview.page + 1)}
                      type="button"
                    >
                      Next
                    </button>
                  </div>
                </>
              ) : null}

              {manualRowId ? (
                <div className="import-manual">
                  <h3>Place a point manually</h3>
                  <p className="import-muted">
                    Pasting coordinates is recorded as a manual override: the original address is kept, and the point
                    is authoritative for this row.
                  </p>
                  <label>
                    Longitude
                    <input
                      className="import-input"
                      onChange={(event) => setManualLongitude(event.target.value)}
                      value={manualLongitude}
                    />
                  </label>
                  <label>
                    Latitude
                    <input
                      className="import-input"
                      onChange={(event) => setManualLatitude(event.target.value)}
                      value={manualLatitude}
                    />
                  </label>
                  <div className="import-actions">
                    <button className="button" onClick={() => setManualRowId(null)} type="button">
                      Cancel
                    </button>
                    <button className="button button--primary" disabled={busy} onClick={handleManualPoint} type="button">
                      Save point
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <h2>Recent imports</h2>
          {imports.length === 0 ? (
            <p className="import-muted">No imports in this workspace yet.</p>
          ) : (
            <ul className="import-list">
              {imports.slice(0, 8).map((entry) => (
                <li key={entry.id}>
                  <button className="button button--link" onClick={() => void openImport(entry)} type="button">
                    {entry.originalFilename} · {jobStatusLabel(entry.status)} · {entry.counters.totalRows} row(s)
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </main>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={`import-metric${tone ? ` import-metric--${tone}` : ''}`}>
      <span className="import-metric__value">{Number.isFinite(value) ? Math.max(value, 0) : 0}</span>
      <span className="import-metric__label">{label}</span>
    </div>
  );
}

function badgeTone(status: string): 'ok' | 'warn' | 'bad' {
  if (status === 'valid') return 'ok';
  if (status === 'needs_geocoding') return 'warn';
  return 'bad';
}

