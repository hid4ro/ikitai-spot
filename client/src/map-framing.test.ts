/* Regression tests for the record map's framing decisions:
   the per-tab auto-fit shots and their gate (v89 review
   round 1, finding 1; round 2, finding 1), the run tokens
   and apply-time validity for late fits (round 3), the
   publish-time validity for the shared location (round 4),
   the cross-tab capture-time comparison that keeps a held
   read from rewinding that shared location (round 5), the
   single publisher every adoption route funnels through and
   the frame-location decision for a refused publish
   (round 6, P2-1 and P2-2), and the fullscreen fitBounds
   padding (finding 6).
   Run with: bun test client/src/map-framing.test.ts */
import { describe, expect, test } from "bun:test";
import {
  autoFitGate,
  autoFitMayApply,
  autoFitMayPublishLocation,
  consumeRecordRetakeCameraRequest,
  createAutoFitRuns,
  createAutoFitShots,
  createSharedLocationPublisher,
  fitBoundsPadding,
  resolveFrameLocation,
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

describe("shared location freshness (a held read from another tab must not rewind it)", () => {
  /* Round 5 finding: run tokens are per tab, so the
     publish-time currency check alone cannot stop a
     municipalities read held across a lines round trip —
     it is still current for its own tab when it finally
     lands, and its older coordinates rewind the shared
     location the スポット tab plots from. The publish gate
     is therefore currency AND the capture-time comparison
     below: a read older than the position already adopted
     is refused, whatever tab it came from. The stand-in
     publish below replays the framing functions' order of
     checks (mayPublish, then the shared writes, with the
     adopted time recorded as the write lands). */

  type Shared = {
    loc: { lat: number; lng: number } | null;
    atMs: number | null;
  };
  const makePublish = (
    runs: ReturnType<typeof createAutoFitRuns>,
    publisher: ReturnType<typeof createSharedLocationPublisher>,
    shared: Shared,
  ) => (
    tab: AutoFitTab,
    token: number,
    loc: { lat: number; lng: number },
    capturedAtMs: number,
  ): boolean => {
    if (
      !autoFitMayPublishLocation({
        runCurrent: runs.isCurrent(tab, token),
      })
    )
      return false;
    /* Round 6: the comparison and the record ride inside the
       publisher — the stand-in mirrors App's funnel, which
       adopts through publish() and writes the refs and the
       state only when it admits. */
    if (!publisher.publish({ ...loc, capturedAtMs })) return false;
    shared.loc = loc;
    shared.atMs = capturedAtMs;
    return true;
  };

  test("the held municipalities read may not publish after the lines read adopted a newer position", () => {
    /* The reviewed sequence: ① 市区町村 opens and its
       location read is held back. ② The reader switches
       to 路線; its read returns the NEW position first and
       publishes. ③ The held 市区町村 read finally returns
       the OLD position, and the reader then moves to
       スポット. */
    const runs = createAutoFitRuns();
    const publisher = createSharedLocationPublisher();
    const shared: Shared = { loc: null, atMs: null };
    const publish = makePublish(runs, publisher, shared);
    const municipalitiesRun = runs.begin("municipalities");
    const linesRun = runs.begin("lines");
    /* ② The lines read lands first and publishes. */
    expect(publish("lines", linesRun, { lat: 35.7, lng: 139.7 }, 2000)).toBe(
      true,
    );
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    expect(shared.atMs).toBe(2000);
    /* ③ The held read is still current for its own tab —
       currency alone would admit it — but its capture is
       older than the adopted position, so the cross-tab
       comparison refuses it and スポット keeps the newer
       position. */
    expect(runs.isCurrent("municipalities", municipalitiesRun)).toBe(true);
    expect(
      autoFitMayPublishLocation({
        runCurrent: runs.isCurrent("municipalities", municipalitiesRun),
      }),
    ).toBe(true);
    expect(
      publish("municipalities", municipalitiesRun, { lat: 35.6, lng: 139.6 }, 1000),
    ).toBe(false);
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    expect(shared.atMs).toBe(2000);
  });

  test("a current run with a newer capture still publishes (round 1 spec preserved)", () => {
    /* The freshness check refuses only OLDER captures: a
       read carrying a newer position still flows into the
       shared location even when its camera fit may not
       apply — the reader switched tabs meanwhile, or picked
       the tab's focus (round 1, finding 8, stands). */
    const runs = createAutoFitRuns();
    const publisher = createSharedLocationPublisher();
    const shared: Shared = { loc: null, atMs: null };
    const publish = makePublish(runs, publisher, shared);
    const linesRun = runs.begin("lines");
    expect(publish("lines", linesRun, { lat: 35.6, lng: 139.6 }, 1000)).toBe(
      true,
    );
    const municipalitiesRun = runs.begin("municipalities");
    expect(
      publish("municipalities", municipalitiesRun, { lat: 35.7, lng: 139.7 }, 2000),
    ).toBe(true);
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    /* …and that newer read's camera fit may still be
       refused for the usual per-tab reasons without
       touching the publish. */
    expect(
      autoFitMayApply({
        tabShowing: false,
        runCurrent: runs.isCurrent("municipalities", municipalitiesRun),
        focusPicked: false,
      }),
    ).toBe(false);
  });

  test("run currency still gates: a superseded run with a newer capture may not publish", () => {
    /* Both halves of the gate must pass. A superseded
       run's read is refused by currency even if the
       capture it carries is newer than the adopted one. */
    const runs = createAutoFitRuns();
    const publisher = createSharedLocationPublisher();
    const shared: Shared = { loc: null, atMs: null };
    const publish = makePublish(runs, publisher, shared);
    const first = runs.begin("lines");
    const second = runs.begin("lines");
    expect(publish("lines", second, { lat: 35.7, lng: 139.7 }, 1000)).toBe(
      true,
    );
    expect(publish("lines", first, { lat: 35.8, lng: 139.8 }, 2000)).toBe(false);
    expect(shared.loc).toEqual({ lat: 35.7, lng: 139.7 });
    expect(shared.atMs).toBe(1000);
  });

  test("the publisher admits anything until the first adoption, then only fresh-or-equal captures", () => {
    const publisher = createSharedLocationPublisher();
    expect(publisher.mayAdopt(1000)).toBe(true);
    expect(publisher.publish({ lat: 35.6, lng: 139.6, capturedAtMs: 1000 })).toBe(true);
    expect(publisher.adopted()).toEqual({ lat: 35.6, lng: 139.6, capturedAtMs: 1000 });
    /* The same stored position read twice carries the same
       capture time, so an equal capture may adopt. */
    expect(publisher.mayAdopt(1000)).toBe(true);
    expect(publisher.mayAdopt(1001)).toBe(true);
    expect(publisher.mayAdopt(999)).toBe(false);
    /* Adopting a newer position moves the bar: the old
       capture stays refused afterwards. */
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(true);
    expect(publisher.mayAdopt(1000)).toBe(false);
    expect(publisher.mayAdopt(2000)).toBe(true);
    /* An older candidate is refused and changes nothing —
       the comparison and the record happen together, so no
       route can adopt a position without moving the bar. */
    expect(publisher.publish({ lat: 35.5, lng: 139.5, capturedAtMs: 1500 })).toBe(false);
    expect(publisher.adopted()).toEqual({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 });
  });
});

describe("shared location publisher (round 6, P2-1: every adoption route shares one bar)", () => {
  /* Round 6, P2-1: the re-take adopted a newer position into
     the shared location WITHOUT recording its capture time,
     so the ledger still measured the next read against the
     old bar and a held read landing in between rewound it.
     Every route — framing reads, the manual frame button,
     the 60 s poll, the deviceLoc adoption, the mount
     resolve, the re-take camera request — now funnels
     through the same publish(), which compares and records
     together. These tests replay the reviewed sequences
     against the publisher directly: a route is just a
     publish() call with that route's coordinates and
     capture time, and the framing runs' currency check
     rides on top of it in App. */

  test("a re-take that adopted a newer position is not rewound by a held read", () => {
    /* The reviewed sequence: ① 市区町村 opens and its
       location read is held back (capture 1000). ② The
       reader switches to スポット and presses 「Pixelの位置
       を取り直す」: the re-take adopts the NEW position
       (capture 2000) through the same publisher. ③ The held
       市区町村 read finally returns the OLD position. */
    const runs = createAutoFitRuns();
    const publisher = createSharedLocationPublisher();
    const municipalitiesRun = runs.begin("municipalities");
    /* ② The re-take adopts the newer position. */
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(true);
    expect(publisher.adopted()).toEqual({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 });
    /* ③ The held read is still current for its own tab —
       currency alone would admit it — but its capture is
       older than the position the re-take adopted, so the
       publisher refuses it and スポット keeps the newer
       position. */
    expect(runs.isCurrent("municipalities", municipalitiesRun)).toBe(true);
    expect(
      autoFitMayPublishLocation({
        runCurrent: runs.isCurrent("municipalities", municipalitiesRun),
      }),
    ).toBe(true);
    expect(publisher.publish({ lat: 35.6, lng: 139.6, capturedAtMs: 1000 })).toBe(false);
    expect(publisher.adopted()).toEqual({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 });
  });

  test("a re-take at the same coordinates still moves the freshness bar", () => {
    /* The old adoption early-returned on identical
       coordinates without recording the capture time, so a
       held read captured between the old and the new bar
       still rewound the location. The funnel records the
       capture together with the position even when the
       coordinates did not move. */
    const publisher = createSharedLocationPublisher();
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 1000 })).toBe(true);
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(true);
    expect(publisher.mayAdopt(1500)).toBe(false);
    expect(publisher.mayAdopt(2000)).toBe(true);
    expect(publisher.adopted()).toEqual({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 });
  });

  test("every route shares the one bar: framing, re-take, poll, mount", () => {
    /* The routes take turns adopting through the same
       publisher, and after each adoption an older held read
       is refused — whichever route adopted the newer
       position. */
    const publisher = createSharedLocationPublisher();
    /* A framing run adopts the first position. */
    expect(publisher.publish({ lat: 35.6, lng: 139.6, capturedAtMs: 1000 })).toBe(true);
    /* A re-take adopts a newer one. */
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(true);
    /* A read held from before the re-take is refused. */
    expect(publisher.publish({ lat: 35.65, lng: 139.65, capturedAtMs: 1500 })).toBe(false);
    /* A 60 s poll tick adopts a still newer one. */
    expect(publisher.publish({ lat: 35.75, lng: 139.75, capturedAtMs: 3000 })).toBe(true);
    /* A read held from before the poll is refused. */
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(false);
    /* The mount resolve reading the same stored position
       twice carries the same capture time, so it may adopt. */
    expect(publisher.publish({ lat: 35.75, lng: 139.75, capturedAtMs: 3000 })).toBe(true);
    expect(publisher.adopted()).toEqual({ lat: 35.75, lng: 139.75, capturedAtMs: 3000 });
  });
});

describe("frame location after a refused publish (round 6, P2-2)", () => {
  /* Round 6, P2-2: refusing a stale publish used to return
     "located" early, which skipped the visited-bounds
     fallback too and left the tab with no initial frame at
     all. A run that is still valid now frames on the
     position already adopted instead. */

  test("a refused publish frames on the adopted position while the run is valid", () => {
    /* The reviewed sequence: ① 市区町村's location read is
       held back. ② The reader moves to 路線; its read
       returns the NEW position first and publishes it.
       ③ The held 市区町村 read finally returns the OLD
       position and is refused — but the 市区町村 run is
       still its tab's latest, so its initial fit continues,
       on the adopted newer position. */
    const runs = createAutoFitRuns();
    const publisher = createSharedLocationPublisher();
    /* ② The lines read publishes the newer position. */
    expect(publisher.publish({ lat: 35.7, lng: 139.7, capturedAtMs: 2000 })).toBe(true);
    const municipalitiesRun = runs.begin("municipalities");
    /* ③ The held read's capture is older than the adopted
       one, so its publish is refused… */
    expect(publisher.publish({ lat: 35.6, lng: 139.6, capturedAtMs: 1000 })).toBe(false);
    /* …but the run is still current, so the fit continues —
       on the adopted position, not the refused read's. */
    expect(runs.isCurrent("municipalities", municipalitiesRun)).toBe(true);
    expect(
      autoFitMayApply({
        tabShowing: true,
        runCurrent: runs.isCurrent("municipalities", municipalitiesRun),
        focusPicked: false,
      }),
    ).toBe(true);
    const frameLoc = resolveFrameLocation(
      { lat: 35.6, lng: 139.6 },
      false,
      publisher.adopted(),
    );
    expect(frameLoc).not.toBeNull();
    expect(frameLoc?.lat).toBe(35.7);
    expect(frameLoc?.lng).toBe(139.7);
  });

  test("a published read frames on its own coordinates", () => {
    expect(
      resolveFrameLocation(
        { lat: 35.6, lng: 139.6 },
        true,
        { lat: 35.7, lng: 139.7 },
      ),
    ).toEqual({ lat: 35.6, lng: 139.6 });
  });

  test("a refused publish with nothing adopted frames on nothing", () => {
    /* A superseded run before any adoption: the newer run
       owns the framing, so there is nothing to frame on and
       the run reports located as before. */
    expect(resolveFrameLocation({ lat: 35.6, lng: 139.6 }, false, null)).toBeNull();
  });
});

describe("record-tab retake camera requests", () => {
  const retake = { seq: 1, lat: 35.6, lng: 139.6, capturedAtMs: 1000 };
  const polled = { lat: 35.7, lng: 139.7, capturedAtMs: 2000 };

  test("a retake that finishes on Spots cannot move the record map on return after a newer poll", () => {
    const publisher = createSharedLocationPublisher();
    const appliedSeq = { current: 0 };

    // The reader switched to Spots before the retake completed.
    // The result is published, but its record-tab camera request waits.
    expect(publisher.publish(retake)).toBe(true);
    expect(appliedSeq.current).toBe(0);
    expect(publisher.publish(polled)).toBe(true);

    // Returning to the record tab releases the camera request.
    expect(publisher.publish(retake)).toBe(false);
    expect(consumeRecordRetakeCameraRequest(retake, retake.seq, appliedSeq, publisher)).toBe(false);
    expect(appliedSeq.current).toBe(retake.seq);
    expect(publisher.adopted()).toEqual(polled);
  });

  test("a retake still waiting for the map style is checked against a later poll", () => {
    const publisher = createSharedLocationPublisher();
    const appliedSeq = { current: 0 };
    expect(publisher.publish(retake)).toBe(true);
    const onMapReady = () =>
      consumeRecordRetakeCameraRequest(retake, retake.seq, appliedSeq, publisher);

    expect(publisher.publish(polled)).toBe(true);
    expect(onMapReady()).toBe(false);
    expect(appliedSeq.current).toBe(retake.seq);
  });

  test("a current retake at the adopted position moves the camera once", () => {
    const publisher = createSharedLocationPublisher();
    const appliedSeq = { current: 0 };
    expect(publisher.publish(retake)).toBe(true);

    expect(consumeRecordRetakeCameraRequest(retake, retake.seq, appliedSeq, publisher)).toBe(true);
    expect(consumeRecordRetakeCameraRequest(retake, retake.seq, appliedSeq, publisher)).toBe(false);
  });

  test("a superseded callback does not consume the latest request", () => {
    const publisher = createSharedLocationPublisher();
    const appliedSeq = { current: 0 };
    const latest = { ...retake, seq: 2 };
    expect(publisher.publish(latest)).toBe(true);

    expect(consumeRecordRetakeCameraRequest(retake, latest.seq, appliedSeq, publisher)).toBe(false);
    expect(appliedSeq.current).toBe(0);
    expect(consumeRecordRetakeCameraRequest(latest, latest.seq, appliedSeq, publisher)).toBe(true);
  });
});
