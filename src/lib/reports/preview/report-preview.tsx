/**
 * The HTML preview of a report.
 *
 * It renders the *same* `ReportViewModel` the PDF document renders, so the
 * preview and the PDF can never disagree: there is no second formatting path and
 * no business number is derived here. This module is presentation only and is
 * safe in a Client Component — it never imports the Supabase client.
 *
 * The map image and the logo are passed in as already-authorized URLs (the
 * report artifact routes); the preview never receives or prints a storage path.
 */

import type { ReportViewModel } from '../types';

export interface ReportPreviewProps {
  viewModel: ReportViewModel;
  /** Authorized URLs of the stored artifacts, or null when absent. */
  mapUrl?: string | null;
  logoUrl?: string | null;
}

export function ReportPreview({ viewModel, mapUrl = null, logoUrl = null }: ReportPreviewProps) {
  const { report, analysis, summary, model, ranking, candidates, comparison, methodology, freshness, map } =
    viewModel;

  return (
    <article className="report-preview" aria-label={`${report.title} preview`}>
      <header className="report-preview__cover">
        {logoUrl ? (
          <img alt={viewModel.branding.companyName ?? 'Report logo'} className="report-preview__logo" src={logoUrl} />
        ) : null}
        <p className="report-preview__eyebrow">LOCATION INTELLIGENCE REPORT</p>
        <h2>{report.title}</h2>
        {report.subtitle ? <p className="report-preview__subtitle">{report.subtitle}</p> : null}
        <dl className="report-preview__meta">
          <div>
            <dt>Report type</dt>
            <dd>{report.typeLabel}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>{viewModel.project.name}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>
              {viewModel.branding.companyName
                ? `${viewModel.branding.companyName} · ${viewModel.workspace.name}`
                : viewModel.workspace.name}
            </dd>
          </div>
          <div>
            <dt>Analysis date</dt>
            <dd>{analysis.analysisDateText}</dd>
          </div>
          <div>
            <dt>Report generated</dt>
            <dd>{freshness.generatedText}</dd>
          </div>
          <div>
            <dt>Scoring model</dt>
            <dd>
              {analysis.modelName} v{analysis.modelVersion}
            </dd>
          </div>
          <div>
            <dt>Search radius</dt>
            <dd>{analysis.radiusText}</dd>
          </div>
          {report.snapshotHash ? (
            <div>
              <dt>Snapshot SHA-256</dt>
              <dd className="report-preview__hash">{report.snapshotHash}</dd>
            </div>
          ) : null}
        </dl>
      </header>

      <section className="report-preview__section">
        <h3>Executive summary</h3>
        <p className="report-preview__headline">{summary.headline}</p>
        <dl className="report-preview__meta">
          {summary.topCandidate ? (
            <>
              <div>
                <dt>Top candidate</dt>
                <dd>
                  {summary.topCandidate.name} ({summary.topCandidate.label})
                </dd>
              </div>
              <div>
                <dt>Score</dt>
                <dd>
                  {summary.topCandidate.scoreText} · {summary.topCandidate.band}
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>Sites analyzed</dt>
            <dd>{analysis.candidateCount}</dd>
          </div>
          <div>
            <dt>Radius</dt>
            <dd>{analysis.radiusText}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {analysis.modelName} v{analysis.modelVersion}
            </dd>
          </div>
        </dl>
        {summary.paragraphs.map((paragraphg, index) => (
          <p key={index}>{paragraphg}</p>
        ))}
        {summary.keyPoints.length > 0 ? (
          <ul className="report-preview__list">
            {summary.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        ) : null}
        {freshness.note ? <p className="report-preview__note">{freshness.note}</p> : null}
      </section>

      <section className="report-preview__section">
        <h3>Map and ranking</h3>
        {map.available && mapUrl ? (
          <figure className="report-preview__figure">
            <img alt="Static map of the analyzed sites" className="report-preview__map" src={mapUrl} />
            <figcaption>{map.attribution}</figcaption>
          </figure>
        ) : (
          <p className="report-preview__note">
            {map.note ?? 'No static map is available for this report.'}
          </p>
        )}
        <table className="report-preview__table">
          <caption>Ranking</caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Site</th>
              <th scope="col">Score</th>
              <th scope="col">Band</th>
            </tr>
          </thead>
          <tbody>
            {ranking.map((row) => (
              <tr key={row.label}>
                <td>{row.rank}</td>
                <td>
                  {row.label} · {row.name}
                </td>
                <td>{row.scoreText}</td>
                <td>{row.band}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {comparison ? (
        <section className="report-preview__section">
          <h3>Comparison</h3>
          <table className="report-preview__table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">Site</th>
                <th scope="col">Score</th>
                <th scope="col">Customers</th>
                <th scope="col">Revenue</th>
                <th scope="col">Competitors</th>
                <th scope="col">Nearest branch</th>
                <th scope="col">POIs</th>
                <th scope="col">Density</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.rank}</td>
                  <td>
                    {row.label} · {row.name}
                  </td>
                  <td>{row.scoreText}</td>
                  <td>{row.customersText}</td>
                  <td>{row.revenueText}</td>
                  <td>{row.competitorsText}</td>
                  <td>{row.nearestBranchText}</td>
                  <td>{row.poiText}</td>
                  <td>{row.densityText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {candidates.map((candidate) => (
        <section className="report-preview__section" key={candidate.id}>
          <h3>
            {candidate.label} · {candidate.name}
          </h3>
          <dl className="report-preview__meta">
            <div>
              <dt>Score</dt>
              <dd>
                {candidate.scoreText} · {candidate.band}
              </dd>
            </div>
            <div>
              <dt>Rank</dt>
              <dd>
                {candidate.rank} of {analysis.candidateCount}
              </dd>
            </div>
            <div>
              <dt>Coordinates</dt>
              <dd>{candidate.coordinatesText}</dd>
            </div>
          </dl>

          {candidate.strengths.length > 0 ? (
            <>
              <h4>Strengths</h4>
              <ul className="report-preview__list">
                {candidate.strengths.map((row, index) => (
                  <li key={index}>
                    {row.label} contributed {row.contributionText} points.
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {candidate.considerations.length > 0 ? (
            <>
              <h4>Considerations</h4>
              <ul className="report-preview__list">
                {candidate.considerations.map((row, index) => (
                  <li key={index}>
                    {row.label} contributed the least of the enabled factors ({row.contributionText} points).
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h4>Factor breakdown</h4>
          <table className="report-preview__table">
            <thead>
              <tr>
                <th scope="col">Factor</th>
                <th scope="col">Raw metric</th>
                <th scope="col">Normalized</th>
                <th scope="col">Weight</th>
                <th scope="col">Contribution</th>
              </tr>
            </thead>
            <tbody>
              {candidate.factors.map((factor) => (
                <tr key={factor.key}>
                  <th scope="row">{factor.label}</th>
                  <td>{factor.rawText}</td>
                  <td>{factor.normalizedText}</td>
                  <td>{factor.weightText}</td>
                  <td>{factor.contributionText}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4>Measured metrics</h4>
          <table className="report-preview__table">
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {candidate.metrics.map((metric) => (
                <tr key={metric.key}>
                  <th scope="row">{metric.label}</th>
                  <td>{metric.valueText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      <section className="report-preview__section">
        <h3>Methodology</h3>
        <dl className="report-preview__meta">
          <div>
            <dt>Model</dt>
            <dd>
              {methodology.modelName} v{methodology.modelVersion}
            </dd>
          </div>
          <div>
            <dt>Radius</dt>
            <dd>{methodology.radiusText}</dd>
          </div>
          <div>
            <dt>Analysis</dt>
            <dd>{freshness.analysisText}</dd>
          </div>
          <div>
            <dt>Data snapshot</dt>
            <dd>{freshness.dataSnapshotText}</dd>
          </div>
        </dl>
        <table className="report-preview__table">
          <caption>Factor weights as configured</caption>
          <thead>
            <tr>
              <th scope="col">Factor</th>
              <th scope="col">Weight</th>
              <th scope="col">Direction</th>
              <th scope="col">Normalization</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {methodology.factors.map((factor) => (
              <tr key={factor.key}>
                <th scope="row">{factor.label}</th>
                <td>{factor.weightText}</td>
                <td>{factor.directionLabel}</td>
                <td>{factor.normalizationLabel}</td>
                <td>{factor.enabled ? 'enabled' : 'disabled'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>{methodology.scoreExplanation}</p>
        <p className="report-preview__note">{methodology.disclaimer}</p>
        {model.factors.length === 0 ? (
          <p className="report-preview__note">This report carries no factor definitions.</p>
        ) : null}
      </section>
    </article>
  );
}
