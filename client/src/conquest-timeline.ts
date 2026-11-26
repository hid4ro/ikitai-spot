/* The 制覇グラフ growth chart's data model (subtask 1482).
   Extracted from App.tsx so the tab-split decisions are testable:
   the month axis and the chart's visibility are decided by the
   SELECTED tab's records alone. The first review of the tab split
   found the axis and the visibility were still computed from BOTH
   ledgers, so the 市区町村 tab's axis stretched to the 路線
   ledger's last month, and the 路線 tab rendered a zero-count
   chart when only municipalities had records. */

export type ConquestTimelineRow = { month: string; count: number };

/* Cumulative counts by month (YYYY-MM) for ONE record family,
   expanded to a continuous month axis from that family's first
   to last recorded month so the time spacing is real. A month's
   value is the family's total up to that month. Dates that do not
   start with YYYY-MM are ignored. An empty (or all-invalid) input
   yields no rows. */
export function buildCumulativeSeries(
  dates: readonly string[],
): ConquestTimelineRow[] {
  const monthOf = (d: string) => (/^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null);
  const months = dates
    .map(monthOf)
    .filter((m): m is string => m !== null)
    .sort();
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return [];
  const [startYear = 1970, startMonth = 1] = first.split("-").map(Number);
  const [endYear = 1970, endMonth = 1] = last.split("-").map(Number);
  const rows: ConquestTimelineRow[] = [];
  let i = 0;
  let count = 0;
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    while (i < months.length && (months[i] ?? "") <= key) {
      count++;
      i++;
    }
    rows.push({ month: key, count });
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return rows;
}

export type ConquestTimeline = {
  /* Whether the growth chart renders at all: only when the
     selected tab's family has at least one record. */
  visible: boolean;
  /* The legend / tooltip name of the single rendered series. */
  seriesName: "市区町村" | "路線";
  /* Chart rows (month axis + cumulative count) spanning only the
     selected family's recorded months. */
  rows: ConquestTimelineRow[];
};

/* The growth-chart model for one record tab. Pure in its inputs,
   so a tab switch or a remount recomputes the same model from the
   same ledgers — neither can resurrect the other tab's axis or a
   zero-count chart (the review's symptom B reproduced even after
   a remount precisely because the shared model allowed it). */
export function conquestTimelineForVariant(
  variant: "municipalities" | "lines",
  municipalityDates: readonly string[],
  lineDates: readonly string[],
): ConquestTimeline {
  const rows = buildCumulativeSeries(
    variant === "municipalities" ? municipalityDates : lineDates,
  );
  return {
    visible: rows.length > 0,
    seriesName: variant === "municipalities" ? "市区町村" : "路線",
    rows,
  };
}
