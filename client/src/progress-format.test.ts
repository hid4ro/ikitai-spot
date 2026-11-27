/* Regression tests for the 事業者別（路線）bar labels
   (subtask 1561). The per-operator distances are raw float sums
   from the coverage geometry; the stacked bars' axis tick
   interpolated them unformatted, so the label overflowed and
   read as garbage on device (東日本旅客鉄道 5461723571229/6960.6
   for a ridden distance the chips correctly showed as 155.5km).
   These tests pin the one-decimal formatting the donut and the
   chips already use, and the tick label built from it.
   Run with: bun test client/src/progress-format.test.ts */
import { describe, expect, test } from "bun:test";
import {
  formatProgressValue,
  normalizeProgressRow,
  progressTickFraction,
  progressTickLabel,
} from "./progress-format";

describe("formatProgressValue", () => {
  test("raw float sums collapse to one decimal", () => {
    // The exact values behind the 2026-11-26 screenshot.
    expect(formatProgressValue(155.5461723571229)).toBe("155.5");
    expect(formatProgressValue(26.07164613837768)).toBe("26.1");
    expect(formatProgressValue(3.3101422789023127)).toBe("3.3");
  });

  test("a value that rounds to a whole number shows no fraction", () => {
    expect(formatProgressValue(21.00477070502929)).toBe("21");
  });

  test("thousands gain a grouping separator, matching the donut", () => {
    expect(formatProgressValue(6960.6)).toBe("6,960.6");
    expect(formatProgressValue(26903.9)).toBe("26,903.9");
  });

  test("integer counts pass through unchanged", () => {
    expect(formatProgressValue(12)).toBe("12");
    expect(formatProgressValue(0)).toBe("0");
  });
});

describe("progressTickLabel", () => {
  test("operator row: name plus the formatted fraction", () => {
    expect(
      progressTickLabel("東日本旅客鉄道", {
        done: 155.5461723571229,
        total: 6960.6,
      }),
    ).toBe("東日本旅客鉄道 155.5/6,960.6");
    expect(
      progressTickLabel("京王電鉄", { done: 26.07164613837768, total: 85.1 }),
    ).toBe("京王電鉄 26.1/85.1");
  });

  test("municipality row: counts stay plain integers", () => {
    expect(progressTickLabel("埼玉県", { done: 12, total: 63 })).toBe(
      "埼玉県 12/63",
    );
  });

  test("a name with no row keeps the bare name", () => {
    expect(progressTickLabel("未収録の事業者", undefined)).toBe(
      "未収録の事業者",
    );
  });
});

/* Per-operator bars are normalized to each operator's own
   denominator (subtask 1615): on the shared km axis JR's
   ~7,000 km total set the scale, so every other operator's bar
   collapsed to a sliver. These pin the percent each row draws
   at, and that the small operator with the higher ratio draws
   the longer bar. */
describe("normalizeProgressRow", () => {
  test("JR: 155.5 of 6,960.6 km draws at about 2.2%", () => {
    const row = normalizeProgressRow({
      name: "東日本旅客鉄道",
      done: 155.5461723571229,
      total: 6960.6,
      rest: 6960.6 - 155.5461723571229,
    });
    expect(row.name).toBe("東日本旅客鉄道");
    expect(row.done).toBeCloseTo(2.23, 2);
    expect(row.rest).toBeCloseTo(97.77, 2);
    expect(row.total).toBe(100);
    expect(row.done + row.rest).toBeCloseTo(100, 9);
  });

  test("a small operator with the higher ratio draws longer than JR", () => {
    const jr = normalizeProgressRow({
      name: "東日本旅客鉄道",
      done: 155.5461723571229,
      total: 6960.6,
      rest: 6960.6 - 155.5461723571229,
    });
    const keio = normalizeProgressRow({
      name: "京王電鉄",
      done: 26.07164613837768,
      total: 85.1,
      rest: 85.1 - 26.07164613837768,
    });
    // Absolute km say JR (155.5) dwarfs 京王 (26.1); the ratio
    // says the opposite, and the bar must follow the ratio.
    expect(keio.done).toBeCloseTo(30.64, 2);
    expect(keio.done).toBeGreaterThan(jr.done);
  });

  test("a fully ridden operator fills the bar", () => {
    const row = normalizeProgressRow({
      name: "完乗した事業者",
      done: 12.4,
      total: 12.4,
      rest: 0,
    });
    expect(row.done).toBeCloseTo(100, 9);
    expect(row.rest).toBeCloseTo(0, 9);
  });

  test("no total draws empty instead of NaN", () => {
    const row = normalizeProgressRow({
      name: "分母なし",
      done: 0,
      total: 0,
      rest: 0,
    });
    expect(row.done).toBe(0);
    expect(row.rest).toBe(100);
    expect(Number.isNaN(row.done)).toBe(false);
  });
});

/* The axis tick renders the name and the fraction on separate
   lines (subtask 1576): the joined one-line label was wider
   than the label column, so its head was clipped on device.
   These pin the split half the tick's second line draws. */
describe("progressTickFraction", () => {
  test("operator row: the formatted fraction on its own", () => {
    expect(
      progressTickFraction({ done: 155.5461723571229, total: 6960.6 }),
    ).toBe("155.5/6,960.6");
    expect(
      progressTickFraction({ done: 3.3101422789023127, total: 12.4 }),
    ).toBe("3.3/12.4");
  });

  test("municipality row: counts stay plain integers", () => {
    expect(progressTickFraction({ done: 12, total: 63 })).toBe("12/63");
  });

  test("no row, no fraction (the tick draws the name alone)", () => {
    expect(progressTickFraction(undefined)).toBeUndefined();
  });

  test("name plus fraction recomposes the one-line label", () => {
    const row = { done: 26.07164613837768, total: 85.1 };
    expect(`京王電鉄 ${progressTickFraction(row)}`).toBe(
      progressTickLabel("京王電鉄", row),
    );
  });
});
