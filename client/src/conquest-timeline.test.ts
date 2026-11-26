/* Regression tests for the 制覇グラフ growth chart's per-tab
   model (subtask 1482, Codex review round 1). The review found
   the chart's month axis and visibility were computed from BOTH
   ledgers even after the tab split:
   - Symptom A: with one municipality record in 2025-04 and a
     line record in 2026-03, the 市区町村 tab's axis stretched
     to 2026-03.
   - Symptom B: with records only in the municipality ledger,
     the 路線 tab rendered a zero-count cumulative chart (and
     kept doing so after a remount).
   These tests pin the model ConquestCharts renders from
   (conquestTimelineForVariant): axis, series name (the legend)
   and visibility must come from the selected tab's records
   alone, identically on every call — which is what a tab
   switch or a remount recomputes.
   Run with: bun test client/src/conquest-timeline.test.ts */
import { describe, expect, test } from "bun:test";
import {
  buildCumulativeSeries,
  conquestTimelineForVariant,
} from "./conquest-timeline";

describe("buildCumulativeSeries", () => {
  test("no records yields no rows", () => {
    expect(buildCumulativeSeries([])).toEqual([]);
    expect(buildCumulativeSeries(["", "不明"])).toEqual([]);
  });

  test("the axis spans only the given family's months, carrying counts over gap months", () => {
    /* Unsorted input, two records in the same month, one gap
       month in between. */
    expect(
      buildCumulativeSeries(["2025-06-15", "2025-04-02", "2025-04-20"]),
    ).toEqual([
      { month: "2025-04", count: 2 },
      { month: "2025-05", count: 2 },
      { month: "2025-06", count: 3 },
    ]);
  });
});

describe("conquestTimelineForVariant", () => {
  test("symptom A: each tab's month axis ends at its own ledger's last month", () => {
    const municipalityDates = ["2025-04-10"];
    const lineDates = ["2026-03-05"];

    const municipalities = conquestTimelineForVariant(
      "municipalities",
      municipalityDates,
      lineDates,
    );
    expect(municipalities.visible).toBe(true);
    expect(municipalities.seriesName).toBe("市区町村");
    /* The axis must NOT stretch to the 路線 ledger's 2026-03. */
    expect(municipalities.rows).toEqual([{ month: "2025-04", count: 1 }]);

    const lines = conquestTimelineForVariant(
      "lines",
      municipalityDates,
      lineDates,
    );
    expect(lines.visible).toBe(true);
    expect(lines.seriesName).toBe("路線");
    /* Nor start at the 市区町村 ledger's 2025-04. */
    expect(lines.rows).toEqual([{ month: "2026-03", count: 1 }]);
  });

  test("differing record months: both axes stay inside their own family's span", () => {
    const municipalityDates = ["2025-04-02", "2025-06-15"];
    const lineDates = ["2026-01-10", "2026-03-05", "2026-03-20"];

    expect(
      conquestTimelineForVariant("municipalities", municipalityDates, lineDates)
        .rows,
    ).toEqual([
      { month: "2025-04", count: 1 },
      { month: "2025-05", count: 1 },
      { month: "2025-06", count: 2 },
    ]);
    expect(
      conquestTimelineForVariant("lines", municipalityDates, lineDates).rows,
    ).toEqual([
      { month: "2026-01", count: 1 },
      { month: "2026-02", count: 1 },
      { month: "2026-03", count: 3 },
    ]);
  });

  test("symptom B: a tab whose ledger is empty renders no chart, even when the other ledger has records", () => {
    const onlyMunicipalities = conquestTimelineForVariant(
      "lines",
      ["2025-04-10"],
      [],
    );
    expect(onlyMunicipalities.visible).toBe(false);
    expect(onlyMunicipalities.rows).toEqual([]);

    const onlyLines = conquestTimelineForVariant(
      "municipalities",
      [],
      ["2026-03-05"],
    );
    expect(onlyLines.visible).toBe(false);
    expect(onlyLines.rows).toEqual([]);

    expect(conquestTimelineForVariant("municipalities", [], []).visible).toBe(
      false,
    );
    expect(conquestTimelineForVariant("lines", [], []).visible).toBe(false);
  });

  test("tab switches and remounts recompute the identical model from the same ledgers", () => {
    const municipalityDates = ["2025-04-10"];
    const lineDates = ["2026-03-05"];

    const first = conquestTimelineForVariant(
      "municipalities",
      municipalityDates,
      lineDates,
    );
    const switched = conquestTimelineForVariant(
      "lines",
      municipalityDates,
      lineDates,
    );
    /* A remount passes fresh arrays with the same contents; the
       model must come back identical, with no residue of the
       other tab's visit in between. */
    const remounted = conquestTimelineForVariant(
      "municipalities",
      [...municipalityDates],
      [...lineDates],
    );
    expect(remounted).toEqual(first);
    expect(switched).not.toEqual(first);

    /* The other ledger's records cannot change a tab's model at
       all — that independence is what makes the switch/remount
       behaviour deterministic. */
    expect(
      conquestTimelineForVariant("lines", ["2024-01-01", "2024-02-01"], lineDates),
    ).toEqual(switched);
    expect(
      conquestTimelineForVariant("municipalities", municipalityDates, [
        "2024-01-01",
      ]),
    ).toEqual(first);
  });
});
