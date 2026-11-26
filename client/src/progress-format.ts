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

/* The stacked bars' axis tick label: the group name plus its
   exact fraction (東日本旅客鉄道 155.5/6,960.6), so the numbers
   survive without hovering. A name with no matching row keeps
   the bare name. */
export function progressTickLabel(
  name: string,
  row: { done: number; total: number } | undefined,
): string {
  if (!row) return name;
  return `${name} ${formatProgressValue(row.done)}/${formatProgressValue(row.total)}`;
}
