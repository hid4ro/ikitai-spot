/* Regression tests for the record map's framing decisions:
   the per-tab auto-fit shots and their gate (v89 review
   round 1, finding 1; round 2, finding 1), the run tokens
   and apply-time validity for late fits (round 3), the
   publish-time validity for the shared location (round 4),
   and the fullscreen fitBounds padding (finding 6).
   Run with: bun test client/src/map-framing.test.ts */
import { describe, expect, test } from "bun:test";
import {
  autoFitGate,
  autoFitMayApply,
  autoFitMayPublishLocation,
  createAutoFitRuns,
  createAutoFitShots,
  fitBoundsPadding,
  type AutoFitGateInput,
  type AutoFitTab,
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

describe("auto-fit runs (a late fit must still be valid when it lands)", () => {
  /* Round 3, findings 1–2: the framing functions await a
     location read, and the read can land after the world has
     moved on — the reader picked a focus, a newer run of the
     same tab started, or another tab is showing. The run
     token plus the apply-time decision below are what the
     live-map callbacks consult before touching the camera;
     these tests replay the reviewed sequences against them. */

  test("a focus picked while the location read is out refuses the late fit", () => {
    /* Finding 1, first sequence: 路線 opens and its initial
       fit starts a location read; while the read is out the
       reader picks another line, whose framing moves the
       camera. When the read finally lands, the initial fit
       must not yank the camera off the pick. */
    const runs = createAutoFitRuns();
    const run = runs.begin("lines");
    /* Still on 路線, still the latest run — but the tab's own
       focus is now picked, so the late fit may not apply. */
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("lines", run),
        focusPicked: true,
      }),
    ).toBe(false);
    /* The same run, had nothing been picked, applies. */
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("lines", run),
        focusPicked: false,
      }),
    ).toBe(true);
  });

  test("a round trip supersedes the first run: its late result may not apply after the newer one", () => {
    /* Finding 1, second sequence: the first 路線 read is
       still out when the reader goes 路線 → 市区町村 → 路線.
       The return starts a second run of the same tab; the
       newer result applies, and the older result landing
       afterwards must be refused instead of overwriting it. */
    const runs = createAutoFitRuns();
    const first = runs.begin("lines");
    const second = runs.begin("lines");
    expect(runs.isCurrent("lines", first)).toBe(false);
    expect(runs.isCurrent("lines", second)).toBe(true);
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("lines", first),
        focusPicked: false,
      }),
    ).toBe(false);
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("lines", second),
        focusPicked: false,
      }),
    ).toBe(true);
  });

  test("runs are per-tab: a 市区町村 run does not supersede a 路線 run", () => {
    const runs = createAutoFitRuns();
    const linesRun = runs.begin("lines");
    runs.begin("municipalities");
    expect(runs.isCurrent("lines", linesRun)).toBe(true);
  });

  test("the no-location fallback of a 市区町村 run may not land on the 路線 tab", () => {
    /* Finding 2: 市区町村's read times out with no location
       after the reader moved to 路線 and the 路線 fit already
       completed. The fallback (visited bounds) belongs to the
       run that started it: with 路線 showing, the 市区町村
       run's apply check reads tabShowing = false and the
       fallback is refused. */
    const runs = createAutoFitRuns();
    const run = runs.begin("municipalities");
    expect(
      autoFitMayApply({
        tabShowing: false,
        runCurrent: runs.isCurrent("municipalities", run),
        focusPicked: false,
      }),
    ).toBe(false);
    /* Had the reader stayed on 市区町村, the very same run's
       fallback may apply. */
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("municipalities", run),
        focusPicked: false,
      }),
    ).toBe(true);
  });
});

describe("auto-fit runs (a superseded read must not rewrite the shared location)", () => {
  /* Round 4 finding: the framing functions publish their
     location read into the SHARED location (the スポット
     tab's marker position and its nearest-spot framing)
     before the apply-time check above ever runs. The camera
     fit of a superseded run is refused, but its stale
     coordinates have already replaced the shared location,
     so moving to スポット plots the marker — and recomputes
     the nearest spot and the frame — from the OLD position.
     The publish decision below is what the framing functions
     consult after the read lands and BEFORE the shared
     location is rewritten; these tests replay the reviewed
     sequence against a stand-in for that shared location. */

  test("the round trip's older read may not publish after the newer read landed", () => {
    /* The reviewed sequence: ① 路線 opens and its first
       location read is held back. ② The reader goes
       路線 → 市区町村 → 路線; the return starts a second
       路線 run, whose read returns the NEW position.
       ③ The first read finally returns the OLD position,
       and the reader then moves to スポット. */
    const runs = createAutoFitRuns();
    const shared: { loc: { lat: number; lng: number } | null } = { loc: null };
    const publish = (
      tab: AutoFitTab,
      token: number,
      loc: { lat: number; lng: number },
    ): boolean => {
      if (
        !autoFitMayPublishLocation({
          runCurrent: runs.isCurrent(tab, token),
        })
      )
        return false;
      shared.loc = loc;
      return true;
    };
    const first = runs.begin("lines");
    const second = runs.begin("lines");
    /* ② The newer run's read lands first and publishes. */
    expect(publish("lines", second, { lat: 35.7, lng: 139.7 })).toBe(true);
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    /* ③ The superseded run's late read is discarded BEFORE
       it can rewrite the shared location, so スポット keeps
       the newer position. */
    expect(publish("lines", first, { lat: 35.6, lng: 139.6 })).toBe(false);
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    /* …and its camera fit stays refused as well (round 3). */
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("lines", first),
        focusPicked: false,
      }),
    ).toBe(false);
  });

  test("a still-current run publishes even when its camera fit may not apply", () => {
    /* The publish decision is deliberately narrower than
       the apply decision: a run that is still its tab's
       latest holds the freshest real position, so its read
       keeps the shared location honest even when the camera
       fit itself is refused — the reader picked the tab's
       focus while the read was out, or has since switched
       tabs (the スポット tab's location deliberately
       follows record-tab reads, round 1, finding 8). Only
       supersession makes a read stale. */
    const runs = createAutoFitRuns();
    const run = runs.begin("municipalities");
    expect(
      autoFitMayPublishLocation({
        runCurrent: runs.isCurrent("municipalities", run),
      }),
    ).toBe(true);
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("municipalities", run),
        focusPicked: true,
      }),
    ).toBe(false);
  });
});
