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
import { formatProgressValue, progressTickLabel } from "./progress-format";

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
