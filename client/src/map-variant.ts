/* Hero / ghost switching for the split record map (subtask 1439).
   The 市区町村 tab and the 路線 tab share ONE mounted map and ONE
   load of every dataset (the reader's decision, 2026-11-25):
   switching tabs only swaps which overlay family is the hero and
   which is the ghost underlay, by repainting the live layers in
   place — no remount, no refetch. The pure decisions live here so
   they can be regression-tested without a map: the paint values
   each variant applies, and which ledger row a tap on a painted
   line track belongs to.

   The hero values below are the mount's own paint specs in
   App.tsx (visited-areas-fill 0.38, the line casing / color /
   unknown widths and opacities, the visited outline's zoom ramp)
   — if a mount spec changes, its hero twin here must change with
   it, or a tab switch would silently repaint the layer to the
   stale value. The ghost values are deliberately far below the
   hero ones: the ghost family must read as a thin underlay the
   hero sits on, never compete with it. The municipality tap's
   painted-name → ledger-row resolution (the line tap's twin)
   and the sticky map pane's visible-range bound for the ledger
   row scroll also live here, for the same testability. */

import {
  usableRiddenService,
  type RiddenServiceLink,
} from "../../shared/service-master";

/* Which record tab the shared map is showing: the municipality
   ledger's tab, or the ridden lines' tab. */
export type RecordMapVariant = "municipalities" | "lines";

export type LayerPaintOp = { layer: string; name: string; value: unknown };
export type LayerLayoutOp = { layer: string; name: string; value: unknown };

/* The visited outline's zoom ramp, at hero strength and ghost
   strength (same stops, scaled opacities). */
const OUTLINE_OPACITY_HERO = [
  "interpolate", ["linear"], ["zoom"], 7, 0.7, 10, 0.9,
];
const OUTLINE_OPACITY_GHOST = [
  "interpolate", ["linear"], ["zoom"], 7, 0.22, 10, 0.32,
];

/* Every paint / layout value a variant pins down. Both variants
   set the FULL set for both families, so a switch lands in the
   target state regardless of what the previous variant (or a
   remount) left behind. Layers a mount may not have created
   (no lines recorded, no shaped municipalities) are skipped by
   applyVariantPaint. */
export function variantPaintOps(variant: RecordMapVariant): {
  paint: LayerPaintOp[];
  layout: LayerLayoutOp[];
} {
  const municipalitiesHero = variant === "municipalities";
  return {
    paint: [
      /* Municipality fills + point circles. */
      {
        layer: "visited-areas-fill",
        name: "fill-opacity",
        value: municipalitiesHero ? 0.38 : 0.1,
      },
      {
        layer: "visited-fill-circle",
        name: "circle-opacity",
        value: municipalitiesHero ? 0.22 : 0.07,
      },
      {
        layer: "visited-fill-circle",
        name: "circle-stroke-opacity",
        value: municipalitiesHero ? 0.5 : 0.18,
      },
      {
        layer: "visited-areas-outline",
        name: "line-opacity",
        value: municipalitiesHero ? OUTLINE_OPACITY_HERO : OUTLINE_OPACITY_GHOST,
      },
      /* Ridden lines: casing, color core, dashed unknown. */
      {
        layer: "visited-lines-casing",
        name: "line-opacity",
        value: municipalitiesHero ? 0.15 : 0.55,
      },
      {
        layer: "visited-lines-casing",
        name: "line-width",
        value: municipalitiesHero ? 3 : 5.5,
      },
      {
        layer: "visited-lines-color",
        name: "line-opacity",
        value: municipalitiesHero ? 0.32 : 0.95,
      },
      {
        layer: "visited-lines-color",
        name: "line-width",
        value: municipalitiesHero ? 2 : 3.5,
      },
      {
        layer: "visited-lines-unknown",
        name: "line-opacity",
        value: municipalitiesHero ? 0.28 : 0.6,
      },
    ],
    layout: [
      /* Unridden lines ghost only on the 路線 tab (the reader
         allowed it there); on the 市区町村 tab they would bury
         the fills under 597 extra tracks. */
      {
        layer: "unridden-lines-ghost",
        name: "visibility",
        value: municipalitiesHero ? "none" : "visible",
      },
    ],
  };
}

/* The minimal map surface applyVariantPaint needs — the real
   MapLibreLike satisfies it, and tests drive it with a fake. */
export type VariantPaintMap = {
  getLayer: (id: string) => unknown;
  setPaintProperty: (layerId: string, name: string, value: unknown) => void;
  setLayoutProperty: (layerId: string, name: string, value: unknown) => void;
};

/* Applies a variant's hero / ghost paint to a live map, skipping
   layers the mount never created. Throws nothing itself, but a
   half-torn-down map may throw inside a setter — callers guard. */
export function applyVariantPaint(
  map: VariantPaintMap,
  variant: RecordMapVariant,
): void {
  const ops = variantPaintOps(variant);
  for (const op of ops.paint) {
    if (map.getLayer(op.layer)) {
      map.setPaintProperty(op.layer, op.name, op.value);
    }
  }
  for (const op of ops.layout) {
    if (map.getLayer(op.layer)) {
      map.setLayoutProperty(op.layer, op.name, op.value);
    }
  }
}

/* The ledger row a tap on a painted line track belongs to: the
   FIRST row in ledger order whose service paints that formal
   line key. A formal line can carry several services （総武線
   paints both 総武快速線 and 総武本線）, and their painted legs
   overlap, so a tap cannot tell them apart by key alone —
   ledger order is the deterministic tie-break, the same rule
   firstLineByOperator uses for bar jumps. Rows without a usable
   service (unlinked, or held for review) paint nothing and
   never match. Null when no row paints the key (e.g. the tap
   hit an unridden ghost track, which has no row). The
   key-only rule survives as the fallback of
   lineRowForPaintedFeature below, for features painted before
   they carried a serviceId. */
export function lineRowForPaintedKey<
  Row extends RiddenServiceLink & { id: number },
>(
  rows: readonly Row[],
  perServiceLegs: ReadonlyMap<
    string,
    { legs: readonly { key: string }[]; unknown: boolean }
  >,
  key: string,
): Row | null {
  for (const row of rows) {
    const service = usableRiddenService(row);
    if (!service) continue;
    const painted = perServiceLegs.get(service.id);
    if (!painted) continue;
    if (painted.legs.some((leg) => leg.key === key)) return row;
  }
  return null;
}

/* The ledger row a tap on a painted line feature belongs to
   (integrated review round 1, medium): the feature carries the
   SERVICE that painted it, so a tap resolves to that service's
   row — the 総武本線 track no longer selects the 総武快速線 row
   just because both paint JR・総武線 and the 快速 row sorts
   first. The service's row must actually paint the tapped key
   (a feature and the coverage are built from the same legs, so
   this is a consistency check, not a restriction). A feature
   without a serviceId falls back to the key-only rule above.
   A feature WITH a serviceId never falls back (integrated
   review round 2, medium): when no row paints for that service
   — the ledger holds only the OTHER service on the shared
   formal line — the key-only rule would hand the tap to that
   other service's row, the very mix-up the serviceId exists to
   prevent, so the tap resolves to no row instead. */
export function lineRowForPaintedFeature<
  Row extends RiddenServiceLink & { id: number },
>(
  rows: readonly Row[],
  perServiceLegs: ReadonlyMap<
    string,
    { legs: readonly { key: string }[]; unknown: boolean }
  >,
  feature: { key: string; serviceId: string | null },
): Row | null {
  if (feature.serviceId) {
    for (const row of rows) {
      const service = usableRiddenService(row);
      if (!service || service.id !== feature.serviceId) continue;
      const painted = perServiceLegs.get(service.id);
      if (painted && painted.legs.some((leg) => leg.key === feature.key)) {
        return row;
      }
    }
    return null;
  }
  return lineRowForPaintedKey(rows, perServiceLegs, feature.key);
}

/* Whether the live map's mount effect should run. The mount
   waits for the priority boundary set to settle, and — since
   integrated review round 2 (high) — for there to be anything
   to show at all: the map container only renders when
   showLiveMap holds (a mappable municipality, or a ridden-lines
   record), and a mount attempted while the container is absent
   finds nothing and quietly does nothing. When the boundary set
   settled first and an unlinked ride arrived afterwards, the
   frame appeared (showLiveMap flipped) but no key the effect
   watched had changed, so it never re-ran and the pane sat on
   読み込み中 forever. showLiveMap is therefore one of the
   effect's own conditions, and one of its dependencies. */
export function shouldMountLiveMap(
  mapFailed: boolean,
  boundarySettled: boolean,
  showLiveMap: boolean,
): boolean {
  return !mapFailed && boundarySettled && showLiveMap;
}

/* The ledger row a tap on a painted municipality shape belongs
   to: the mount builds the hit-layer features with the name
   "${prefecture} ${name}", and the ledger holds at most one row
   per municipality, so the first exact match is the row. Null
   when the painted name matches no row — the shape is not in
   the ledger, and the caller falls back to the geometric lookup
   (which can still name an unvisited municipality). The
   municipality twin of lineRowForPaintedKey above. */
export function municipalityRowForPaintedName<
  Row extends { id: number; prefecture: string; name: string },
>(rows: readonly Row[], paintedName: string): Row | null {
  for (const row of rows) {
    if (`${row.prefecture} ${row.name}` === paintedName) return row;
  }
  return null;
}

/* The visible range's top for a ledger row while the record
   map's pane is stuck to the viewport top: the pane (its height
   is min(40dvh, 20rem) — MAP_PANE_HEIGHT in App.tsx) overlays
   the top of the viewport while the page scrolls beneath it, so
   a row whose rect starts above the pane's bottom edge is
   hidden behind the map even though it sits inside the raw
   viewport — the row scroll's verify loop must not count it as
   visible, or a map tap can be declared "already in view" and
   never scroll at all (subtask 1440). Returns 0 (no bound) when
   there is no pane rect, or the pane is not stuck yet (its top
   is still below the viewport's top edge, so what is above it
   is ordinary page content), or the pane has scrolled fully
   past. Clamped so the visible range never inverts against the
   bottom allowance (the fixed tab bar). */
export function stickyPaneVisibleTop(
  paneRect: { top: number; bottom: number } | null,
  viewportHeight: number,
  bottomAllowance: number,
): number {
  if (!paneRect) return 0;
  if (paneRect.top > 8 || paneRect.bottom <= 0) return 0;
  return Math.max(
    0,
    Math.min(paneRect.bottom, viewportHeight - bottomAllowance - 1),
  );
}
