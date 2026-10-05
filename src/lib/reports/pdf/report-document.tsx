/**
 * The Phase 7 PDF document: an executive decision report.
 *
 * Built with `@react-pdf/renderer`, which renders to PDF bytes in Node with no
 * browser, no Chromium and no network access. The document is a pure function of
 * the `ReportViewModel` plus the optional static map and logo images, so the
 * preview and the PDF can never disagree about a number: both read the same view
 * model, and neither re-derives anything.
 *
 * Layout is A4 portrait throughout, using the standard PDF fonts that ship with
 * the renderer (no font download at generation time).
 */

import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';

import type { ReportViewModel } from '../types';

export interface ReportDocumentImages {
  map: { data: Buffer; format: 'png' | 'jpg' } | null;
  logo: { data: Buffer; format: 'png' | 'jpg' } | null;
}

const COLORS = {
  ink: '#1f2a37',
  muted: '#5b6b7c',
  faint: '#8a97a5',
  line: '#dfe5ea',
  wash: '#f4f7f9',
  accent: '#1f4e79',
  accentWash: '#eef3f8',
  warn: '#8a5a00',
  warnWash: '#fdf6e6',
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 54,
    paddingBottom: 58,
    paddingHorizontal: 48,
    fontFamily: 'Helvetica',
    fontSize: 9.5,
    color: COLORS.ink,
    lineHeight: 1.45,
  },
  coverPage: {
    paddingTop: 120,
    paddingBottom: 58,
    paddingHorizontal: 48,
    fontFamily: 'Helvetica',
    color: COLORS.ink,
  },
  eyebrow: { fontSize: 8.5, letterSpacing: 1.4, color: COLORS.accent, marginBottom: 10 },
  coverTitle: { fontSize: 27, fontFamily: 'Helvetica-Bold', marginBottom: 8 },
  coverSubtitle: { fontSize: 12, color: COLORS.muted, marginBottom: 26 },
  coverMeta: { marginTop: 8, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 14 },
  metaRow: { flexDirection: 'row', marginBottom: 5 },
  metaLabel: { width: 120, fontSize: 8.5, color: COLORS.faint, letterSpacing: 0.6 },
  metaValue: { flex: 1, fontSize: 10 },
  logo: { width: 132, height: 44, objectFit: 'contain', marginBottom: 18, alignSelf: 'flex-start' },
  sectionTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginBottom: 8 },
  subTitle: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  paragraph: { marginBottom: 7 },
  headline: { fontSize: 12.5, fontFamily: 'Helvetica-Bold', marginBottom: 8, color: COLORS.accent },
  card: {
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 4,
    padding: 12,
    marginBottom: 12,
    backgroundColor: '#ffffff',
  },
  cardWash: {
    borderWidth: 1,
    borderColor: '#d8e3ee',
    borderRadius: 4,
    padding: 12,
    marginBottom: 12,
    backgroundColor: COLORS.accentWash,
  },
  warnCard: {
    borderWidth: 1,
    borderColor: '#edd9ad',
    borderRadius: 4,
    padding: 10,
    marginBottom: 12,
    backgroundColor: COLORS.warnWash,
    color: COLORS.warn,
  },
  row: { flexDirection: 'row', marginBottom: 3 },
  key: { width: 150, color: COLORS.muted, fontSize: 8.5 },
  value: { flex: 1, fontSize: 9.5 },
  bullet: { flexDirection: 'row', marginBottom: 3 },
  bulletDot: { width: 12, color: COLORS.accent },
  bulletText: { flex: 1 },
  table: { borderWidth: 1, borderColor: COLORS.line, borderRadius: 3, marginBottom: 12 },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: COLORS.wash,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.line,
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#eef2f5',
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  tableRowLast: { flexDirection: 'row', paddingVertical: 5, paddingHorizontal: 6 },
  th: { fontSize: 8, color: COLORS.muted, fontFamily: 'Helvetica-Bold' },
  td: { fontSize: 9 },
  mapImage: {
    width: '100%',
    height: 250,
    objectFit: 'cover',
    borderWidth: 1,
    borderColor: COLORS.line,
    borderRadius: 4,
    marginBottom: 6,
  },
  attribution: { fontSize: 7.5, color: COLORS.faint, marginBottom: 12 },
  footer: {
    position: 'absolute',
    left: 48,
    right: 48,
    bottom: 26,
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: COLORS.line,
    paddingTop: 6,
    fontSize: 7.5,
    color: COLORS.faint,
  },
  pageNumber: { fontSize: 7.5, color: COLORS.faint },
  mono: { fontFamily: 'Courier', fontSize: 7.5, color: COLORS.faint },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 4 },
  metricCell: { width: '50%', paddingRight: 10, marginBottom: 5 },
  metricLabel: { fontSize: 8, color: COLORS.faint },
  metricValue: { fontSize: 9.5 },
});

function Footer({ viewModel }: { viewModel: ReportViewModel }) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {viewModel.report.title} · {viewModel.project.name} · {viewModel.workspace.name}
      </Text>
      <Text
        style={styles.pageNumber}
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
      />
    </View>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.key}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function TableRow({
  cells,
  header = false,
  last = false,
  widths,
}: {
  cells: string[];
  header?: boolean;
  last?: boolean;
  widths: number[];
}) {
  const style = header ? styles.tableHeader : last ? styles.tableRowLast : styles.tableRow;
  return (
    <View style={style} wrap={false}>
      {cells.map((cell, index) => (
        <Text
          key={`${cell}-${index}`}
          style={header ? { ...styles.th, width: `${widths[index]}%` } : { ...styles.td, width: `${widths[index]}%` }}
        >
          {cell}
        </Text>
      ))}
    </View>
  );
}

export function ReportDocument({
  viewModel,
  images,
}: {
  viewModel: ReportViewModel;
  images: ReportDocumentImages;
}) {
  const { report, analysis, summary, methodology, freshness, map, branding } = viewModel;

  return (
    <Document
      author={branding.companyName ?? viewModel.workspace.name}
      creator="BLI location intelligence platform"
      title={`${report.title} — ${viewModel.project.name}`}
      subject={`${report.typeLabel} for ${viewModel.project.name}`}
      producer="BLI Phase 7 report generation (@react-pdf/renderer)"
    >
      {/* ------------------------------------------------------------ cover */}
      <Page size="A4" style={styles.coverPage}>
        {images.logo ? (
          <Image src={{ data: images.logo.data, format: images.logo.format }} style={styles.logo} />
        ) : null}
        <Text style={styles.eyebrow}>LOCATION INTELLIGENCE REPORT</Text>
        <Text style={styles.coverTitle}>{report.title}</Text>
        {report.subtitle ? <Text style={styles.coverSubtitle}>{report.subtitle}</Text> : null}

        <View style={styles.coverMeta}>
          <MetaRow label="REPORT TYPE" value={report.typeLabel} />
          <MetaRow label="PROJECT" value={viewModel.project.name} />
          <MetaRow
            label="WORKSPACE"
            value={branding.companyName ? `${branding.companyName} · ${viewModel.workspace.name}` : viewModel.workspace.name}
          />
          <MetaRow label="ANALYSIS DATE" value={analysis.analysisDateText} />
          <MetaRow label="REPORT GENERATED" value={freshness.generatedText} />
          <MetaRow label="SCORING MODEL" value={`${analysis.modelName} v${analysis.modelVersion}`} />
          <MetaRow label="RADIUS" value={analysis.radiusText} />
          {report.snapshotHash ? (
            <View style={styles.row}>
              <Text style={styles.key}>SNAPSHOT SHA-256</Text>
              <Text style={styles.mono}>{report.snapshotHash}</Text>
            </View>
          ) : null}
        </View>

        <Text style={{ marginTop: 26, fontSize: 8, color: COLORS.faint }}>
          {methodology.disclaimer}
        </Text>
        <Footer viewModel={viewModel} />
      </Page>

      {/* -------------------------------------------------- executive summary */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionTitle}>Executive summary</Text>

        <View style={styles.cardWash}>
          <Text style={styles.headline}>{summary.headline}</Text>
          {summary.topCandidate ? (
            <>
              <MetaRow label="TOP CANDIDATE" value={`${summary.topCandidate.name} (${summary.topCandidate.label})`} />
              <MetaRow label="SCORE" value={`${summary.topCandidate.scoreText} (${summary.topCandidate.band})`} />
            </>
          ) : null}
          <MetaRow label="SITES ANALYZED" value={String(analysis.candidateCount)} />
          <MetaRow label="RADIUS" value={analysis.radiusText} />
          <MetaRow label="MODEL" value={`${analysis.modelName} v${analysis.modelVersion}`} />
        </View>

        {summary.paragraphs.map((paragraph, index) => (
          <Text key={index} style={styles.paragraph}>
            {paragraph}
          </Text>
        ))}

        {summary.keyPoints.length > 0 ? (
          <>
            <Text style={styles.subTitle}>What drove the top score</Text>
            {summary.keyPoints.map((point, index) => (
              <View key={index} style={styles.bullet}>
                <Text style={styles.bulletDot}>•</Text>
                <Text style={styles.bulletText}>{point}</Text>
              </View>
            ))}
          </>
        ) : null}

        {freshness.note ? <Text style={styles.warnCard}>{freshness.note}</Text> : null}

        <Text style={styles.subTitle}>Data freshness</Text>
        <MetaRow label="Analysis performed" value={freshness.analysisText} />
        <MetaRow label="Data snapshot" value={freshness.dataSnapshotText} />
        <MetaRow label="Report generated" value={freshness.generatedText} />
        <Footer viewModel={viewModel} />
      </Page>

      {/* -------------------------------------------------------- map & ranking */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionTitle}>Map and ranking</Text>

        {map.available && images.map ? (
          <>
            <Image
              src={{ data: images.map.data, format: images.map.format }}
              style={styles.mapImage}
            />
            <Text style={styles.attribution}>{map.attribution}</Text>
          </>
        ) : (
          <Text style={styles.warnCard}>
            {map.note ??
              'No static map is available for this report. Every figure comes from the stored analysis.'}
          </Text>
        )}

        <View style={styles.table}>
          <TableRow header cells={['RANK', 'SITE', 'SCORE', 'BAND']} widths={[12, 46, 22, 20]} />
          {viewModel.ranking.map((row, index) => (
            <TableRow
              key={row.label}
              last={index === viewModel.ranking.length - 1}
              cells={[String(row.rank), `${row.label} · ${row.name}`, row.scoreText, row.band]}
              widths={[12, 46, 22, 20]}
            />
          ))}
        </View>

        {viewModel.candidates.length === 1 ? (
          <>
            <Text style={styles.subTitle}>Measured inside the {analysis.radiusText} radius</Text>
            {viewModel.candidates[0].metrics.map((metric) => (
              <MetaRow key={metric.key} label={metric.label} value={metric.valueText} />
            ))}
          </>
        ) : null}
        <Footer viewModel={viewModel} />
      </Page>

      {/* -------------------------------------------------------- comparison */}
      {viewModel.comparison ? (
        <Page size="A4" style={styles.page}>
          <Text style={styles.sectionTitle}>Comparison</Text>
          <Text style={styles.paragraph}>
            All sites were scored with one shared radius and one model revision, so the rows are
            directly comparable. Every value is copied from the stored analysis.
          </Text>

          <View style={styles.table}>
            <TableRow
              header
              cells={['RANK', 'SITE', 'SCORE', 'CUSTOMERS', 'REVENUE', 'COMPETITORS', 'NEAREST BRANCH', 'POIS', 'DENSITY']}
              widths={[8, 20, 12, 11, 14, 12, 11, 6, 6]}
            />
            {viewModel.comparison.rows.map((row, index) => (
              <TableRow
                key={row.label}
                last={index === viewModel.comparison!.rows.length - 1}
                cells={[
                  String(row.rank),
                  `${row.label} · ${row.name}`,
                  row.scoreText,
                  row.customersText,
                  row.revenueText,
                  row.competitorsText,
                  row.nearestBranchText,
                  row.poiText,
                  row.densityText,
                ]}
                widths={[8, 20, 12, 11, 14, 12, 11, 6, 6]}
              />
            ))}
          </View>

          <Text style={styles.subTitle}>Ranking</Text>
          {viewModel.ranking.map((row, index) => (
            <View key={row.label} style={styles.bullet}>
              <Text style={styles.bulletDot}>{index + 1}.</Text>
              <Text style={styles.bulletText}>
                {row.label} · {row.name} — {row.scoreText} ({row.band})
              </Text>
            </View>
          ))}
          <Footer viewModel={viewModel} />
        </Page>
      ) : null}

      {/* --------------------------------------------------- candidate detail */}
      {viewModel.candidates.map((candidate) => (
        <Page key={candidate.id} size="A4" style={styles.page} wrap>
          <Text style={styles.sectionTitle}>
            {candidate.label} · {candidate.name}
          </Text>

          <View style={styles.card}>
            <MetaRow label="SCORE" value={`${candidate.scoreText} (${candidate.band})`} />
            <MetaRow label="RANK" value={`${candidate.rank} of ${analysis.candidateCount}`} />
            <MetaRow label="COORDINATES" value={candidate.coordinatesText} />
            <MetaRow label="RADIUS" value={analysis.radiusText} />
            <MetaRow label="MODEL" value={`${analysis.modelName} v${analysis.modelVersion}`} />
          </View>

          <Text style={{ ...styles.subTitle, marginTop: 12 }}>Factor breakdown</Text>
          <View style={styles.table}>
            <TableRow
              header
              cells={['FACTOR', 'RAW METRIC', 'NORMALIZED', 'WEIGHT', 'CONTRIBUTION']}
              widths={[26, 26, 16, 12, 20]}
            />
            {candidate.factors.map((factor, index) => (
              <TableRow
                key={factor.key}
                last={index === candidate.factors.length - 1}
                cells={[
                  factor.label,
                  factor.rawText,
                  factor.normalizedText,
                  factor.weightText,
                  factor.contributionText,
                ]}
                widths={[26, 26, 16, 12, 20]}
              />
            ))}
          </View>

          {candidate.strengths.length > 0 ? (
            <>
              <Text style={styles.subTitle}>Strengths</Text>
              {candidate.strengths.map((row, index) => (
                <View key={index} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>
                    {row.label} contributed {row.contributionText} points.
                  </Text>
                </View>
              ))}
            </>
          ) : null}

          {candidate.considerations.length > 0 ? (
            <>
              <Text style={{ ...styles.subTitle, marginTop: 10 }}>Considerations</Text>
              {candidate.considerations.map((row, index) => (
                <View key={index} style={styles.bullet}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>
                    {row.label} contributed the least of the enabled factors ({row.contributionText}{' '}
                    points).
                  </Text>
                </View>
              ))}
            </>
          ) : null}

          <Text style={{ ...styles.subTitle, marginTop: 12 }}>Measured metrics</Text>
          <View style={styles.metricGrid}>
            {candidate.metrics.map((metric) => (
              <View key={metric.key} style={styles.metricCell}>
                <Text style={styles.metricLabel}>{metric.label}</Text>
                <Text style={styles.metricValue}>{metric.valueText}</Text>
              </View>
            ))}
          </View>
          <Footer viewModel={viewModel} />
        </Page>
      ))}

      {/* -------------------------------------------------------- methodology */}
      <Page size="A4" style={styles.page}>
        <Text style={styles.sectionTitle}>Methodology</Text>

        <View style={styles.card}>
          <MetaRow label="MODEL" value={`${methodology.modelName} v${methodology.modelVersion}`} />
          <MetaRow label="RADIUS" value={methodology.radiusText} />
          <MetaRow label="ANALYSIS" value={freshness.analysisText} />
          <MetaRow label="DATA SNAPSHOT" value={freshness.dataSnapshotText} />
          <MetaRow label="REPORT GENERATED" value={freshness.generatedText} />
          {report.snapshotHash ? <MetaRow label="SNAPSHOT SHA-256" value={report.snapshotHash} /> : null}
        </View>

        <Text style={styles.subTitle}>Factor weights as configured</Text>
        <View style={styles.table}>
          <TableRow
            header
            cells={['FACTOR', 'WEIGHT', 'DIRECTION', 'NORMALIZATION', 'STATE']}
            widths={[26, 10, 18, 32, 14]}
          />
          {methodology.factors.map((factor, index) => (
            <TableRow
              key={`${factor.label}-${index}`}
              last={index === methodology.factors.length - 1}
              cells={[
                factor.label,
                factor.weightText,
                factor.directionLabel,
                factor.normalizationLabel,
                factor.enabled ? 'enabled' : 'disabled',
              ]}
              widths={[26, 10, 18, 32, 14]}
            />
          ))}
        </View>

        <Text style={styles.subTitle}>How the score is produced</Text>
        <Text style={styles.paragraph}>{methodology.scoreExplanation}</Text>

        <Text style={styles.subTitle}>Data freshness</Text>
        <Text style={styles.paragraph}>
          This report was generated from the stored analysis snapshot of {freshness.dataSnapshotText}. It
          does not re-read the workspace data, re-run the radius analysis or re-apply the current model:
          the numbers are the numbers of that snapshot.
        </Text>
        {freshness.note ? <Text style={styles.warnCard}>{freshness.note}</Text> : null}

        {map.attribution ? (
          <>
            <Text style={styles.subTitle}>Map attribution</Text>
            <Text style={styles.attribution}>{map.attribution}</Text>
          </>
        ) : null}

        <Text style={styles.subTitle}>Disclaimer</Text>
        <Text style={styles.paragraph}>{methodology.disclaimer}</Text>
        <Footer viewModel={viewModel} />
      </Page>
    </Document>
  );
}
