/* Camera-framing decisions shared by the record map: the
   per-tab one-shot auto-fit state (v89 review round 1,
   finding 1) and the fitBounds padding that keeps a fullscreen
   map's frame clear of the bottom tab bar (finding 6). Kept
   dependency-light so both rules are regression-testable
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
  /* Spend this tab's shot (the framing ran, or the tab was
     entered in a state — map failed, a focus already picked —
     where it must not run later). */
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
