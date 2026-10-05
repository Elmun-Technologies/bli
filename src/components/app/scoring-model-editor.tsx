'use client';

/**
 * Scoring model editor.
 *
 * A model is a named, versioned list of factors: metric, weight, direction,
 * normalization and configuration. The editor mirrors the database rules so a
 * problem is explained before a save, but the database stays authoritative and
 * rejects an invalid definition even if this form is bypassed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, LoaderCircle, Plus, RotateCcw, Save, TriangleAlert, X } from 'lucide-react';

import {
  findMetric,
  SCORING_METRICS,
  normalizationExplanation,
  normalizationLabel,
} from '@/lib/scoring/catalogue';
import {
  createScoringModel,
  getScoringModel,
  listScoringModels,
  ScoringApiError,
  updateScoringModel,
} from '@/lib/scoring/client';
import {
  checkFactorSet,
  factorErrorsEmpty,
  formatThresholdPoints,
  parseThresholdPointsText,
  toFactorPayload,
  validateScoringFactor,
  type FactorErrors,
} from '@/lib/scoring/validation';
import type {
  ScoringDirection,
  ScoringFactor,
  ScoringModel,
  ScoringModelStatus,
  ScoringModelSummary,
  ScoringNormalization,
} from '@/lib/scoring/types';

const DIRECTIONS: readonly ScoringDirection[] = ['positive', 'negative', 'neutral'];
const NORMALIZATIONS: readonly ScoringNormalization[] = ['threshold', 'min_max', 'inverse_min_max'];
const STATUSES: readonly ScoringModelStatus[] = ['draft', 'active', 'archived'];

interface DraftModel {
  name: string;
  description: string;
  status: ScoringModelStatus;
  factors: ScoringFactor[];
}

const EMPTY_DRAFT: DraftModel = {
  name: '',
  description: '',
  status: 'draft',
  factors: [],
};

function newFactor(): ScoringFactor {
  return {
    key: '',
    label: '',
    metric: SCORING_METRICS[0].key,
    weight: 0,
    direction: 'positive',
    normalization: 'min_max',
    configuration: { missing_score: 0, degenerate_score: 50 },
    enabled: true,
    sortOrder: 0,
  };
}

function toDraft(model: ScoringModel): DraftModel {
  return {
    name: model.name,
    description: model.description ?? '',
    status: model.status,
    factors: model.factors.map((factor, index) => ({ ...factor, sortOrder: index })),
  };
}

export function ScoringModelEditor({
  workspaceId,
  canManage,
  onModelsChanged,
}: {
  workspaceId: string;
  canManage: boolean;
  onModelsChanged: (models: ScoringModelSummary[]) => void;
}) {
  const [models, setModels] = useState<ScoringModelSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftModel>(EMPTY_DRAFT);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [factorErrors, setFactorErrors] = useState<Record<number, FactorErrors>>({});
  const [configurationText, setConfigurationText] = useState<Record<number, string>>({});

  const publish = useCallback(
    (next: ScoringModelSummary[]) => {
      setModels(next);
      onModelsChanged(next);
    },
    [onModelsChanged],
  );

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const next = await listScoringModels(workspaceId);
      publish(next);
      setStatus('ready');
    } catch (error) {
      setStatus('error');
      setErrorMessage(
        error instanceof ScoringApiError ? error.message : 'Scoring models could not be loaded.',
      );
    }
  }, [publish, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openModel = useCallback(
    async (modelId: string) => {
      setMessage(null);
      setErrorMessage(null);
      try {
        const model = await getScoringModel(workspaceId, modelId);
        setSelectedId(model.id);
        setDraft(toDraft(model));
        setConfigurationText({});
        setFactorErrors({});
      } catch (error) {
        setErrorMessage(
          error instanceof ScoringApiError ? error.message : 'The scoring model could not be opened.',
        );
      }
    },
    [workspaceId],
  );

  const factorSet = useMemo(() => checkFactorSet(draft.factors), [draft.factors]);

  function updateFactor(index: number, patch: Partial<ScoringFactor>) {
    setDraft((current) => ({
      ...current,
      factors: current.factors.map((factor, position) =>
        position === index ? { ...factor, ...patch } : factor,
      ),
    }));
    setFactorErrors((current) => {
      const next = { ...current };
      delete next[index];
      return next;
    });
  }

  function updateConfiguration(index: number, patch: ScoringFactor['configuration']) {
    setDraft((current) => ({
      ...current,
      factors: current.factors.map((factor, position) =>
        position === index
          ? { ...factor, configuration: { ...factor.configuration, ...patch } }
          : factor,
      ),
    }));
  }

  function removeFactor(index: number) {
    setDraft((current) => ({
      ...current,
      factors: current.factors
        .filter((_, position) => position !== index)
        .map((factor, position) => ({ ...factor, sortOrder: position })),
    }));
    setConfigurationText({});
    setFactorErrors({});
  }

  function addFactor() {
    setDraft((current) => ({
      ...current,
      factors: [...current.factors, { ...newFactor(), sortOrder: current.factors.length }],
    }));
  }

  async function save() {
    setMessage(null);
    setErrorMessage(null);

    const errors: Record<number, FactorErrors> = {};
    draft.factors.forEach((factor, index) => {
      const factorError = validateScoringFactor(factor);
      if (!factorErrorsEmpty(factorError)) errors[index] = factorError;
    });
    setFactorErrors(errors);

    if (!draft.name.trim()) {
      setErrorMessage('Give the model a name.');
      return;
    }
    if (Object.keys(errors).length > 0) {
      setErrorMessage('Some factors still need attention.');
      return;
    }
    if (!factorSet.valid) {
      setErrorMessage(factorSet.problems[0] ?? 'The factor set is not valid.');
      return;
    }

    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        description: draft.description.trim() ? draft.description.trim() : null,
        status: draft.status,
        factors: toFactorPayload(draft.factors),
      };
      if (selectedId) {
        const { model } = await updateScoringModel(workspaceId, selectedId, input);
        setSelectedId(model.id);
        setDraft(toDraft(model));
        setMessage(
          `Saved as revision ${model.version}. Existing analyses keep the revision they were run with.`,
        );
      } else {
        const model = await createScoringModel(workspaceId, input);
        setSelectedId(model.id);
        setDraft(toDraft(model));
        setMessage(`Model created at revision ${model.version}.`);
      }
      await load();
    } catch (error) {
      setErrorMessage(
        error instanceof ScoringApiError ? error.message : 'The scoring model could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }

  if (status === 'loading') {
    return (
      <p className="scoring-loading">
        <LoaderCircle aria-hidden="true" className="scoring-spinner" size={14} /> Loading scoring
        models…
      </p>
    );
  }

  return (
    <div className="scoring-models">
      <div className="scoring-models__list">
        <div className="section-heading-row">
          <div>
            <h2>Workspace models</h2>
            <p>Every analysis stores the model revision it used.</p>
          </div>
          {canManage ? (
            <button
              className="scoring-button scoring-button--quiet"
              onClick={() => {
                setSelectedId(null);
                setDraft(EMPTY_DRAFT);
                setConfigurationText({});
                setFactorErrors({});
                setMessage(null);
              }}
              type="button"
            >
              <Plus aria-hidden="true" size={13} /> New
            </button>
          ) : null}
        </div>

        {models.length === 0 ? (
          <p className="scoring-empty">
            No scoring model exists in this workspace yet.
            {canManage ? ' Create one to start scoring locations.' : ''}
          </p>
        ) : (
          <ul className="scoring-model-list">
            {models.map((model) => (
              <li key={model.id}>
                <button
                  className={`scoring-model${model.id === selectedId ? ' is-active' : ''}`}
                  onClick={() => void openModel(model.id)}
                  type="button"
                >
                  <span className="scoring-model__name">{model.name}</span>
                  <span className="scoring-model__meta">
                    {model.status} · revision {model.version} · {model.enabledFactorCount} factors ·{' '}
                    {model.enabledWeightTotal}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!canManage ? (
          <p className="scoring-note">
            Only an owner or admin can change a scoring model. Analysts run analyses with the
            workspace models as they are.
          </p>
        ) : null}
      </div>

      <div className="scoring-models__editor">
        <div className="section-heading-row">
          <div>
            <h2>{selectedId ? 'Edit model' : 'New model'}</h2>
            <p>Weights are percentages of the final score and must total 100.</p>
          </div>
          <span className={`scoring-weight-total${factorSet.valid ? ' is-valid' : ''}`}>
            {factorSet.enabledTotal} / 100
          </span>
        </div>

        <label className="scoring-field">
          <span>Model name</span>
          <input
            disabled={!canManage}
            maxLength={120}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            placeholder="Retail expansion model"
            value={draft.name}
          />
        </label>

        <label className="scoring-field">
          <span>Description</span>
          <textarea
            disabled={!canManage}
            maxLength={500}
            onChange={(event) =>
              setDraft((current) => ({ ...current, description: event.target.value }))
            }
            rows={2}
            value={draft.description}
          />
        </label>

        <label className="scoring-field scoring-field--inline">
          <span>Status</span>
          <select
            disabled={!canManage}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                status: event.target.value as ScoringModelStatus,
              }))
            }
            value={draft.status}
          >
            {STATUSES.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        {factorSet.problems.length > 0 ? (
          <ul className="scoring-problems">
            {factorSet.problems.map((problem) => (
              <li key={problem}>
                <TriangleAlert aria-hidden="true" size={12} /> {problem}
              </li>
            ))}
          </ul>
        ) : null}

        <ol className="scoring-factor-list">
          {draft.factors.map((factor, index) => {
            const errors = factorErrors[index] ?? {};
            const metric = findMetric(factor.metric);
            const stopsText =
              configurationText[index] ??
              (factor.configuration.points ? formatThresholdPoints(factor.configuration.points) : '');

            return (
              <li className="scoring-factor" key={`${factor.key}-${index}`}>
                <div className="scoring-factor__topline">
                  <span className="scoring-factor__index">Factor {index + 1}</span>
                  <label className="scoring-toggle">
                    <input
                      checked={factor.enabled}
                      disabled={!canManage}
                      onChange={(event) => updateFactor(index, { enabled: event.target.checked })}
                      type="checkbox"
                    />
                    Enabled
                  </label>
                  {canManage ? (
                    <button
                      aria-label={`Remove factor ${index + 1}`}
                      className="scoring-icon-button"
                      onClick={() => removeFactor(index)}
                      type="button"
                    >
                      <X aria-hidden="true" size={13} />
                    </button>
                  ) : null}
                </div>

                <div className="scoring-factor__grid">
                  <label className="scoring-field">
                    <span>Key</span>
                    <input
                      disabled={!canManage}
                      onChange={(event) => updateFactor(index, { key: event.target.value })}
                      placeholder="customer_density"
                      value={factor.key}
                    />
                    {errors.key ? <em>{errors.key}</em> : null}
                  </label>

                  <label className="scoring-field">
                    <span>Label</span>
                    <input
                      disabled={!canManage}
                      onChange={(event) => updateFactor(index, { label: event.target.value })}
                      placeholder="Customer density"
                      value={factor.label}
                    />
                    {errors.label ? <em>{errors.label}</em> : null}
                  </label>

                  <label className="scoring-field">
                    <span>Measured metric</span>
                    <select
                      disabled={!canManage}
                      onChange={(event) => updateFactor(index, { metric: event.target.value })}
                      value={factor.metric}
                    >
                      {SCORING_METRICS.map((entry) => (
                        <option key={entry.key} value={entry.key}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    {metric ? <small>{metric.description}</small> : null}
                    {errors.metric ? <em>{errors.metric}</em> : null}
                  </label>

                  <label className="scoring-field">
                    <span>Weight (%)</span>
                    <input
                      disabled={!canManage}
                      max={100}
                      min={0}
                      onChange={(event) => updateFactor(index, { weight: Number(event.target.value) })}
                      step={0.01}
                      type="number"
                      value={factor.weight}
                    />
                    {errors.weight ? <em>{errors.weight}</em> : null}
                  </label>

                  <label className="scoring-field">
                    <span>Direction</span>
                    <select
                      disabled={!canManage}
                      onChange={(event) =>
                        updateFactor(index, {
                          direction: event.target.value as ScoringDirection,
                          normalization:
                            event.target.value === 'negative' && factor.normalization === 'min_max'
                              ? 'inverse_min_max'
                              : event.target.value === 'positive' &&
                                  factor.normalization === 'inverse_min_max'
                                ? 'min_max'
                                : factor.normalization,
                        })
                      }
                      value={factor.direction}
                    >
                      {DIRECTIONS.map((entry) => (
                        <option key={entry} value={entry}>
                          {entry}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="scoring-field">
                    <span>Normalization</span>
                    <select
                      disabled={!canManage}
                      onChange={(event) =>
                        updateFactor(index, {
                          normalization: event.target.value as ScoringNormalization,
                        })
                      }
                      value={factor.normalization}
                    >
                      {NORMALIZATIONS.map((entry) => (
                        <option key={entry} value={entry}>
                          {normalizationLabel(entry)}
                        </option>
                      ))}
                    </select>
                    {errors.method ? <em>{errors.method}</em> : null}
                  </label>
                </div>

                <p className="scoring-factor__explanation">
                  {normalizationExplanation(factor.normalization)}
                </p>

                {factor.normalization === 'threshold' ? (
                  <label className="scoring-field">
                    <span>Threshold stops (value:score, ascending)</span>
                    <input
                      disabled={!canManage}
                      onChange={(event) => {
                        const text = event.target.value;
                        setConfigurationText((current) => ({ ...current, [index]: text }));
                        const parsed = parseThresholdPointsText(text);
                        updateConfiguration(index, { points: parsed });
                      }}
                      placeholder="0:0, 500:50, 1000:100"
                      value={stopsText}
                    />
                  </label>
                ) : null}

                <div className="scoring-factor__grid scoring-factor__grid--fallbacks">
                  <label className="scoring-field">
                    <span>Score when the metric is missing</span>
                    <input
                      disabled={!canManage}
                      max={100}
                      min={0}
                      onChange={(event) =>
                        updateConfiguration(index, { missing_score: Number(event.target.value) })
                      }
                      step={0.01}
                      type="number"
                      value={factor.configuration.missing_score ?? 0}
                    />
                  </label>
                  <label className="scoring-field">
                    <span>Score when every compared value is equal</span>
                    <input
                      disabled={!canManage}
                      max={100}
                      min={0}
                      onChange={(event) =>
                        updateConfiguration(index, { degenerate_score: Number(event.target.value) })
                      }
                      step={0.01}
                      type="number"
                      value={factor.configuration.degenerate_score ?? 50}
                    />
                  </label>
                </div>

                {errors.configuration ? (
                  <p className="scoring-factor__error">
                    <TriangleAlert aria-hidden="true" size={12} /> {errors.configuration}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        {canManage ? (
          <div className="scoring-editor-actions">
            <button className="scoring-button scoring-button--quiet" onClick={addFactor} type="button">
              <Plus aria-hidden="true" size={13} /> Add factor
            </button>
            <button
              className="scoring-button"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? (
                <LoaderCircle aria-hidden="true" className="scoring-spinner" size={13} />
              ) : selectedId ? (
                <Save aria-hidden="true" size={13} />
              ) : (
                <Check aria-hidden="true" size={13} />
              )}
              {selectedId ? 'Save new revision' : 'Create model'}
            </button>
            {selectedId ? (
              <button
                className="scoring-button scoring-button--quiet"
                onClick={() => void openModel(selectedId)}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={13} /> Discard changes
              </button>
            ) : null}
          </div>
        ) : null}

        {message ? <p className="scoring-success">{message}</p> : null}
        {errorMessage ? <p className="scoring-error">{errorMessage}</p> : null}
      </div>
    </div>
  );
}
