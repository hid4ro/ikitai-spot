/* Display formatting for the 制覇グラフ progress figures
   (subtask 1561). Every number the charts show keeps one decimal
   at most — the rule the donut and the operator chips already
   follow — so a distance never renders as the raw float sum the
   coverage geometry produces (155.5461723571229). The per-operator
   bar labels interpolated the raw values and overflowed into
   garbage (5461723571229/6960.6); the aggregation itself was
   always right, only the formatting was missing. Integer counts
   pass through unchanged, so the municipality bars (12/63) are
   unaffected. */

export function formatProgressValue(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/* The fraction half of the tick label （乗車済み/全体）, on its
   own so the axis tick can set it on a second line under the
   name (subtask 1576): the one-line label （東日本旅客鉄道
   155.5/6,960.6) measures wider than the 124px label column,
   and recharts right-anchors the tick, so the overflow ran off
   the chart's left edge and the name's head was clipped on
   device （旅客鉄道 155.5/6,960.6). Split in two, the name
   (≤8 full-width glyphs) and the fraction (≈13 half-width
   glyphs) each fit a ~100px column. */
export function progressTickFraction(
  row: { done: number; total: number } | undefined,
): string | undefined {
  if (!row) return undefined;
  return `${formatProgressValue(row.done)}/${formatProgressValue(row.total)}`;
}

/* Normalize one stacked progress row to its own denominator
   (subtask 1615): the bar length becomes done/total as a
   percent of that row's whole total, so every row fills the
   same 0–100 scale. The 事業者別 chart needs this because the
   shared axis was scaled to JR's ~7,000 km network, which
   shrank every other operator's bar to invisibility — a small
   operator at 30% of its own network drew shorter than JR at
   2% of its. The exact km stay on the axis tick (the fraction
   half) and the chips, so normalization only changes bar
   lengths, never the numbers. A row with no total (0) draws
   empty instead of NaN; a fully ridden row fills the bar. */
export function normalizeProgressRow<T extends { done: number; total: number; rest: number }>(
  row: T,
): T {
  const pct = row.total > 0 ? (row.done / row.total) * 100 : 0;
  return { ...row, done: pct, total: 100, rest: 100 - pct };
}

/* The stacked bars' axis tick label: the group name plus its
   exact fraction (東日本旅客鉄道 155.5/6,960.6), so the numbers
   survive without hovering. A name with no matching row keeps
   the bare name. */
export function progressTickLabel(
  name: string,
  row: { done: number; total: number } | undefined,
): string {
  const fraction = progressTickFraction(row);
  return fraction ? `${name} ${fraction}` : name;
}
