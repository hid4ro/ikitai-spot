/* Camera-framing decisions shared by the record map: the
   per-tab one-shot auto-fit state and its gate (v89 review
   round 1, finding 1; round 2, finding 1) and the fitBounds
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
