/* Regression tests for the record map's framing decisions:
   the per-tab auto-fit shots (v89 review round 1, finding 1)
   and the fullscreen fitBounds padding (finding 6).
   Run with: bun test client/src/map-framing.test.ts */
import { describe, expect, test } from "bun:test";
import { createAutoFitShots, fitBoundsPadding } from "./map-framing";

describe("createAutoFitShots (the record tabs' default framing)", () => {
  test("each record tab owns an independent shot", () => {
    /* The reviewed failure: one shared flag meant entering
       市区町村 first spent the 路線 tab's only initial fit, so
       路線 opened on whatever camera 市区町村 left behind. */
    const shots = createAutoFitShots();
    expect(shots.used("municipalities")).toBe(false);
    expect(shots.used("lines")).toBe(false);
    shots.consume("municipalities");
    expect(shots.used("municipalities")).toBe(true);
    /* …while 路線 still has its first fit coming. */
    expect(shots.used("lines")).toBe(false);
    shots.consume("lines");
    expect(shots.used("lines")).toBe(true);
  });

  test("reset hands both shots back for the next record entry", () => {
    const shots = createAutoFitShots();
    shots.consume("municipalities");
    shots.consume("lines");
    shots.reset();
    expect(shots.used("municipalities")).toBe(false);
    expect(shots.used("lines")).toBe(false);
  });
});

describe("fitBoundsPadding", () => {
  test("off fullscreen the uniform base padding stands", () => {
    expect(fitBoundsPadding(false, 76)).toBe(36);
    expect(fitBoundsPadding(false, 0, 56)).toBe(56);
  });

  test("in fullscreen the bottom padding grows by the tab bar height", () => {
    /* The bar is ~57 px of content plus the safe-area inset;
       the frame must end above it, not behind it. */
    expect(fitBoundsPadding(true, 76)).toEqual({
      top: 36,
      bottom: 112,
      left: 36,
      right: 36,
    });
    expect(fitBoundsPadding(true, 57, 56)).toEqual({
      top: 56,
      bottom: 113,
      left: 56,
      right: 56,
    });
  });

  test("a missing bar measurement degrades to the base padding", () => {
    expect(fitBoundsPadding(true, 0)).toEqual({
      top: 36,
      bottom: 36,
      left: 36,
      right: 36,
    });
  });
});
