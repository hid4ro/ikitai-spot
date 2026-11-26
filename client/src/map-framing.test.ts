/* Regression tests for the record map's framing decisions:
   the per-tab auto-fit shots and their gate (v89 review
   round 1, finding 1; round 2, finding 1) and the fullscreen
   fitBounds padding (finding 6).
   Run with: bun test client/src/map-framing.test.ts */
import { describe, expect, test } from "bun:test";
import {
  autoFitGate,
  createAutoFitShots,
  fitBoundsPadding,
  type AutoFitGateInput,
} from "./map-framing";

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

  test("a run dropped before applying leaves the shot for the next visit", () => {
    /* Round 2, finding 1: the 路線 framing starts a location
       read, the reader switches to 市区町村 before it lands,
       and the tab guard drops the fit. The shot is spent ONLY
       by an applied fit, so the dropped run consumes nothing
       and the return to 路線 frames again — the old wiring
       spent the shot up front and the tab never framed. */
    const shots = createAutoFitShots();
    const ready: AutoFitGateInput = {
      mapFailed: false,
      mapReady: true,
      visitedPending: false,
      riddenPending: false,
      focusPicked: { municipalities: false, lines: false },
    };
    expect(autoFitGate("lines", ready)).toBe("frame");
    /* …the fit is dropped by the tab guard: no consume call. */
    expect(shots.used("lines")).toBe(false);
    /* Back on 路線 the gate still offers the framing… */
    expect(autoFitGate("lines", ready)).toBe("frame");
    /* …and only the run that actually lands spends the shot. */
    shots.consume("lines");
    expect(shots.used("lines")).toBe(true);
  });
});

describe("autoFitGate (when a record tab's one shot may run)", () => {
  const ready: AutoFitGateInput = {
    mapFailed: false,
    mapReady: true,
    visitedPending: false,
    riddenPending: false,
    focusPicked: { municipalities: false, lines: false },
  };

  test("frames once the map and both ledgers are in", () => {
    expect(autoFitGate("municipalities", ready)).toBe("frame");
    expect(autoFitGate("lines", ready)).toBe("frame");
  });

  test("waits for the map and the visited ledger on both tabs", () => {
    expect(autoFitGate("lines", { ...ready, mapReady: false })).toBe("wait");
    expect(autoFitGate("municipalities", { ...ready, visitedPending: true })).toBe(
      "wait",
    );
  });

  test("the 路線 shot also waits for the ridden-lines ledger; 市区町村 does not", () => {
    expect(autoFitGate("lines", { ...ready, riddenPending: true })).toBe("wait");
    expect(autoFitGate("municipalities", { ...ready, riddenPending: true })).toBe(
      "frame",
    );
  });

  test("a failed map spends the shot without framing", () => {
    expect(autoFitGate("lines", { ...ready, mapFailed: true })).toBe(
      "spend-without-framing",
    );
    /* …even while the ledgers are still out: a failed map never
       frames later, so the shot must not stay pending. */
    expect(
      autoFitGate("municipalities", {
        ...ready,
        mapFailed: true,
        visitedPending: true,
      }),
    ).toBe("spend-without-framing");
  });

  test("only the tab's OWN picked focus suppresses its framing", () => {
    /* Round 2, finding 1: a municipality picked on the
       市区町村 tab must not suppress — or spend — the 路線
       tab's first fit when the reader first switches over. */
    const municipalityPicked: AutoFitGateInput = {
      ...ready,
      focusPicked: { municipalities: true, lines: false },
    };
    expect(autoFitGate("lines", municipalityPicked)).toBe("frame");
    expect(autoFitGate("municipalities", municipalityPicked)).toBe(
      "spend-without-framing",
    );
    const linePicked: AutoFitGateInput = {
      ...ready,
      focusPicked: { municipalities: false, lines: true },
    };
    expect(autoFitGate("lines", linePicked)).toBe("spend-without-framing");
    expect(autoFitGate("municipalities", linePicked)).toBe("frame");
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
