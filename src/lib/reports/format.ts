/**
 * Report-specific number formatting.
 *
 * A report is a document: the printed grid keeps two decimals everywhere a
 * score, a normalized value or a contribution is shown, so columns line up and a
 * score reads exactly as documented (`82.40 / 100`). Money never passes through
 * here — it stays the exact decimal string the database stored.
 *
 * The interactive application keeps its own compact formatting (`formatScore`
 * from the scoring catalogue); this module is the report's, and both the preview
 * and the PDF read it through the same `ReportViewModel`.
 */

/** Two decimals, always: 82 -> "82.00", 82.4 -> "82.40", 82.456 -> "82.46". */
export function formatReportNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

/** The documented score form: "82.40 / 100". Never a percentage. */
export function formatReportScore(score: number): string {
  return `${formatReportNumber(score)} / 100`;
}
