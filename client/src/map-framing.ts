/* Camera-framing decisions shared by the record map: the
   per-tab one-shot auto-fit state and its gate (v89 review
   round 1, finding 1; round 2, finding 1), the per-tab run
   tokens and the apply-time validity check for fits that
   resolve late (round 3, findings 1–2), and the fitBounds
   padding that keeps a fullscreen map's frame clear of the
   bottom tab bar (finding 6). Kept dependency-light so both
   rules are regression-testable without mounting the map —
   see map-framing.test.ts. */

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
