/* Camera-framing decisions shared by the record map: the
   per-tab one-shot auto-fit state and its gate (v89 review
   round 1, finding 1; round 2, finding 1), the per-tab run
   tokens and the apply-time validity check for fits that
   resolve late (round 3, findings 1–2), the publish-time
   validity check for the shared location those reads feed
   (round 4), the cross-tab capture-time comparison that
   keeps a held read from rewinding that shared location
   (round 5), the single publisher every adoption route
   funnels through and the frame-location decision for a
   refused publish (round 6, P2-1 and P2-2), and the
   fitBounds padding that keeps a fullscreen map's frame
   clear of the bottom tab bar (finding 6). Kept
   dependency-light so the rules are regression-testable
   without mounting the map — see map-framing.test.ts. */

/* The two record tabs that own a default framing. The 路線
   tab's initialization is independent of the 市区町村 tab's:
   entering 路線 for the first time fits the nearest recorded
   line even when 市区町村 already consumed its own shot, and
   switching back and forth afterwards keeps the camera the
   reader left on each tab. */
export type AutoFitTab = "municipalities" | "lines";

export type AutoFitShots = {
  /* Whether this tab's one-shot default framing has run. */
  used: (tab: AutoFitTab) => boolean;
  /* Spend this tab's shot. Spent ONLY when the framing
     actually landed on the camera, or when the tab is in a
     terminal state where it must never run later (the map
     failed, or this tab's OWN focus was already picked — see
     autoFitGate). A framing run a tab switch drops on the way
     — the location read landing after the reader left, the
     tab guard refusing the fit — spends nothing, so the shot
     is still there when the reader comes back (v89 review
     round 2, finding 1). */
  consume: (tab: AutoFitTab) => void;
  /* Hand both shots back: returning to the スポット tab, a
     map remount over stale data, or a manual map retry — the
     next record entry frames again, as it did before the tabs'
     state was split. */
  reset: () => void;
};

export function createAutoFitShots(): AutoFitShots {
  const shots: Record<AutoFitTab, boolean> = {
    municipalities: false,
    lines: false,
  };
  return {
    used: (tab) => shots[tab],
    consume: (tab) => {
      shots[tab] = true;
    },
    reset: () => {
      shots.municipalities = false;
      shots.lines = false;
    },
  };
}

/* Whether a record tab's one-shot default framing may run
   now, must wait for its inputs, or is spent without framing
   (v89 review round 1, finding 3 — the single entry point —
   and round 2, finding 1). The focus suppression reads the
   TARGET tab's own pick only: the two focuses are mutually
   exclusive in the UI, but a municipality picked on the
   市区町村 tab stays picked while the reader first switches
   to 路線, and the old wiring let that pick spend the 路線
   shot and suppress its first fit. The other tab's pick is
   simply not an input to this tab's decision. */
export type AutoFitGateInput = {
  mapFailed: boolean;
  mapReady: boolean;
  visitedPending: boolean;
  /* Only the 路線 shot waits for this ledger (its nearest
     line is picked from the rows); the 市区町村 shot frames
     from the visited ledger alone. */
  riddenPending: boolean;
  focusPicked: Record<AutoFitTab, boolean>;
};

export type AutoFitGateDecision =
  | "wait"
  | "spend-without-framing"
  | "frame";

export function autoFitGate(
  tab: AutoFitTab,
  input: AutoFitGateInput,
): AutoFitGateDecision {
  /* A failed map never frames later, so its shot is spent
     even while the ledgers are still out. */
  if (input.mapFailed) return "spend-without-framing";
  if (!input.mapReady || input.visitedPending) return "wait";
  if (tab === "lines" && input.riddenPending) return "wait";
  if (input.focusPicked[tab]) return "spend-without-framing";
  return "frame";
}

/* Run tokens for the record tabs' default framing (v89
   review round 3, findings 1–2). A framing run awaits a
   location read, and the read can outlive the moment that
   started it: the reader may pick a focus on the tab, leave
   and come back (starting a NEWER run of the same tab), or
   still be on another tab when the result lands. begin()
   issues the tab's next token and thereby supersedes every
   earlier run of that tab; a run consults isCurrent() at the
   moment it would touch the camera and drops itself when a
   newer run has taken over. Tokens are per tab — the two
   tabs' runs never supersede each other. */
export type AutoFitRuns = {
  /* Start a run of this tab: returns its token and
     supersedes the tab's earlier runs. */
  begin: (tab: AutoFitTab) => number;
  /* Whether this token still names the tab's latest run. */
  isCurrent: (tab: AutoFitTab, token: number) => boolean;
};

export function createAutoFitRuns(): AutoFitRuns {
  const latest: Record<AutoFitTab, number> = {
    municipalities: 0,
    lines: 0,
  };
  return {
    begin: (tab) => {
      latest[tab] += 1;
      return latest[tab];
    },
    isCurrent: (tab, token) => token !== 0 && latest[tab] === token,
  };
}

/* Whether a framing run may move the camera NOW, evaluated
   inside the live-map callback at the moment the fit would
   be issued — for the primary fit and the no-location
   fallback alike (v89 review round 3, findings 1–2). The
   run's tab must still be the one showing (a 市区町村 run's
   fallback must not fire on the 路線 tab), the run must
   still be that tab's latest (an older read landing after a
   newer one must not overwrite the newer framing), and the
   tab's OWN focus must be unpicked (a pick the reader made
   while the read was out owns the camera). */
export type AutoFitApplyInput = {
  tabShowing: boolean;
  runCurrent: boolean;
  focusPicked: boolean;
};

export function autoFitMayApply(input: AutoFitApplyInput): boolean {
  return input.tabShowing && input.runCurrent && !input.focusPicked;
}

/* Whether a framing run may publish its location read into
   the SHARED location — the position the スポット tab plots
   its marker from and recomputes its nearest spot and frame
   from (v89 review round 4). Publishing happens when the
   read lands, BEFORE the camera check above ever runs, so a
   superseded run's stale coordinates rewrote the shared
   location even though its fit was duly refused: after a
   路線 → 市区町村 → 路線 round trip, the first read landing
   last dragged the スポット map back to the old position.
   A superseded run's result is discarded before it can
   rewrite anything. Currency is the ONLY condition, by
   design: a still-current run holds the freshest real
   position, so its read keeps the shared location honest
   even when its camera fit may not apply — the reader
   picked the tab's focus meanwhile, or switched tabs (the
   スポット location deliberately follows record-tab reads,
   round 1, finding 8). Only supersession makes a read
   stale. */
export type AutoFitPublishInput = {
  runCurrent: boolean;
};

export function autoFitMayPublishLocation(
  input: AutoFitPublishInput,
): boolean {
  return input.runCurrent;
}

/* The shared location's single publisher (v89 review
   round 6, P2-1). Run tokens are per tab, so a
   municipalities run held across a lines round trip is
   still "current" for its own tab when its read finally
   lands — and its older coordinates would rewind the
   shared location the スポット tab plots from (round 5).
   Round 6 found the other half of the same hole: a
   re-take adopts a newer position into the shared
   location WITHOUT recording its capture time, so the
   ledger still measured the next read against the OLD
   bar and a held read in between rewound it. The fix
   collects the update in one place: EVERY route that
   adopts a position — framing reads, the manual frame
   button, the 60 s poll, the deviceLoc adoption, the
   mount resolve, the re-take camera request — funnels
   through publish(), which compares the candidate's
   capture time against the position already adopted and
   records the adopted capture time in the same step.
   Only a candidate at least as fresh as the adopted one
   may replace it. Equal capture times are the same
   stored position read twice, so they may adopt. The
   camera decision stays per-tab (autoFitMayApply
   above), and the publish gate in App is the
   conjunction of the run-currency check
   (autoFitMayPublishLocation) and this publish: both
   must pass, and only supersession or an older capture
   may refuse a publish — never the tab switch or the
   focus pick alone (round 1, finding 8, stands). */
export type SharedLocationPublisher = {
  /* Whether a candidate captured at this time may still
     be adopted: only when it is not older than the
     position already adopted. Nothing adopted yet admits
     anything. */
  mayAdopt: (capturedAtMs: number) => boolean;
  /* Adopt a candidate into the shared location: returns
     false and changes nothing when its capture is older
     than the position already adopted, true when it is
     adopted (and the adopted capture time moves with
     it). The comparison and the record happen together,
     so no route can adopt a position without moving the
     bar to it. */
  publish: (loc: {
    lat: number;
    lng: number;
    capturedAtMs: number;
  }) => boolean;
  /* The position currently adopted, if any — the
     coordinates a refused framing run frames on instead
     (resolveFrameLocation below). */
  adopted: () => {
    lat: number;
    lng: number;
    capturedAtMs: number;
  } | null;
};

export function createSharedLocationPublisher(): SharedLocationPublisher {
  let adoptedLoc: {
    lat: number;
    lng: number;
    capturedAtMs: number;
  } | null = null;
  return {
    mayAdopt: (capturedAtMs) =>
      adoptedLoc === null || capturedAtMs >= adoptedLoc.capturedAtMs,
    publish: (loc) => {
      if (adoptedLoc !== null && loc.capturedAtMs < adoptedLoc.capturedAtMs)
        return false;
      adoptedLoc = loc;
      return true;
    },
    adopted: () => adoptedLoc,
  };
}

/* Which coordinates a framing run frames on after its
   publish attempt (v89 review round 6, P2-2). A read
   whose publish was refused — superseded, or an older
   capture than the position already adopted — still owns
   its initial fit while the run is valid, so the fit
   continues on the adopted position instead of stopping:
   refusing the publish used to return "located" early,
   which skipped the visited-bounds fallback too and left
   the tab with no initial frame at all. A published read
   frames on its own coordinates. When nothing is adopted
   yet there is nothing to frame on; the run reports
   located as before and the newer run that superseded it
   owns the framing. The camera guard (autoFitMayApply)
   still decides whether the fit may actually land, so a
   superseded run reaching this point with an adopted
   position in hand is still refused at the camera. */
export function resolveFrameLocation(
  read: { lat: number; lng: number },
  published: boolean,
  adopted: { lat: number; lng: number } | null,
): { lat: number; lng: number } | null {
  if (published) return read;
  return adopted;
}

/* fitBounds padding for the record map. Off fullscreen the
   historical uniform padding stands. In fullscreen the map
   fills the viewport and the fixed bottom tab bar (z-40) floats
   OVER its lower edge, so the bottom padding grows by the bar's
   real height — content plus safe-area inset, measured from the
   live element — and the fitted frame ends above the bar
   instead of behind it. */
export function fitBoundsPadding(
  fullscreen: boolean,
  tabBarHeightPx: number,
  base = 36,
):
  | number
  | { top: number; bottom: number; left: number; right: number } {
  if (!fullscreen) return base;
  return {
    top: base,
    bottom: base + Math.max(0, Math.ceil(tabBarHeightPx)),
    left: base,
    right: base,
  };
}
