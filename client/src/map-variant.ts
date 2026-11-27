/* Hero / ghost switching for the split record map (subtask 1439),
   extended to the スポット tab by the unification (subtask 1460):
   the スポット tab and the two record tabs share ONE mounted map
   and ONE load of every dataset (the reader's decision, 2026-11-25):
   switching tabs only swaps which overlay family is the hero and
   which is the ghost underlay, by repainting the live layers in
   place — no remount, no refetch. The pure decisions live here so
   they can be regression-tested without a map: the paint values
   each variant applies, and which ledger row a tap on a painted
   line track belongs to.

   The hero values below are the mount's own paint specs in
   App.tsx (visited-areas-fill 0.38, the line casing / color /
   unknown widths and opacities, the visited outline's zoom ramp,
   the spot dots' 0.6) — if a mount spec changes, its hero twin
   here must change with it, or a tab switch would silently
   repaint the layer to the stale value. The ghost values are
   deliberately far below the hero ones: the ghost family must
   read as a thin underlay the hero sits on, never compete with
   it. The municipality tap's painted-name → ledger-row resolution
   (the line tap's twin) and the sticky map pane's visible-range
   bound for the ledger row scroll also live here, for the same
   testability. */

import {
  usableRiddenService,
  type RideState,
  type RiddenServiceLink,
} from "../../shared/service-master";
import type { GeoJsonLineGeometry } from "./geojson";

/* Which map tab the shared map is showing: the spot list's tab,
   the municipality ledger's tab, or the ridden lines' tab. The
   スポット tab joined the shared map in the unification
   (subtask 1460); before that only the two record tabs shared it. */
export type RecordMapVariant = "spots" | "municipalities" | "lines";

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

/* The ghost-spot dots' paint (subtask 1481): the unvisited spots
   drawn as an underlay on the record tabs, in the spot tab's own
   orange (#ea580c) so they still read as the same data, but far
   below the hero dots (0.6, radius 3.5–6). The reader found the
   old ghost (0.32, radius 2.5–4.5, 1px stroke at 0.4) too loud
   on the other tabs, so the strength drops to about a quarter
   of the hero's — in line with the other ghost families (fills
   0.1 / 0.38, lines 0.32 / 0.95) — and the dots shrink, so the
   underlay reads as a background, not a second set of dots.
   Lives here, not inline in App.tsx, so the values are pinned
   by test like the other hero / ghost paint decisions. */
export const GHOST_SPOT_PAINT: Record<string, unknown> = {
  "circle-radius": [
    "interpolate", ["linear"], ["zoom"], 3, 2, 10, 2.5, 14, 3,
  ],
  "circle-color": "#ea580c",
  "circle-opacity": 0.16,
  "circle-stroke-width": 0.5,
  "circle-stroke-color": "#ea580c",
  "circle-stroke-opacity": 0.15,
};

/* Every paint / layout value a variant pins down. All variants
   set the FULL set for all three families, so a switch lands in
   the target state regardless of what the previous variant (or a
   remount) left behind. Layers a mount may not have created
   (no lines recorded, no shaped municipalities, no spots) are
   skipped by applyVariantPaint. */
export function variantPaintOps(variant: RecordMapVariant): {
  paint: LayerPaintOp[];
  layout: LayerLayoutOp[];
} {
  const municipalitiesHero = variant === "municipalities";
  const linesHero = variant === "lines";
  const spotsHero = variant === "spots";
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
      /* Ridden lines: casing, color core, thin unknown. */
      {
        layer: "visited-lines-casing",
        name: "line-opacity",
        value: linesHero ? 0.55 : 0.15,
      },
      {
        layer: "visited-lines-casing",
        name: "line-width",
        value: linesHero ? 5.5 : 3,
      },
      {
        layer: "visited-lines-color",
        name: "line-opacity",
        value: linesHero ? 0.95 : 0.32,
      },
      {
        layer: "visited-lines-color",
        name: "line-width",
        value: linesHero ? 3.5 : 2,
      },
      {
        /* The unknown paint IS the unridden look (thin, at the
           ghost's 0.25), so the hero value matches the ghost's;
           as the other tab's underlay it drops with the family. */
        layer: "visited-lines-unknown",
        name: "line-opacity",
        value: linesHero ? 0.25 : 0.15,
      },
      /* Spot dots: the hero paint is the mount spec (0.6) on the
         スポット tab. On the record tabs the layer is hidden by
         the layout op below, so the opacity stays pinned at the
         mount value and a switch back restores the dots as they
         were — the faint unvisited dots there come from the
         ghost-spots layer instead, never from this one. */
      {
        layer: "list-spot-points-circle",
        name: "circle-opacity",
        value: 0.6,
      },
    ],
    layout: [
      /* Unridden lines ghost only on the 路線 tab (the reader
         allowed it there); on the 市区町村 tab they would bury
         the fills under 597 extra tracks. The focused line's
         unridden remainder (subtask 1589) rides the same rule:
         it is a 路線-tab reading aid, meaningless elsewhere. */
      {
        layer: "unridden-lines-ghost",
        name: "visibility",
        value: linesHero ? "visible" : "none",
      },
      {
        layer: "unridden-lines-focus",
        name: "visibility",
        value: linesHero ? "visible" : "none",
      },
      /* The hero spot dots only on the スポット tab: on the
         record tabs the ghost-spots layer carries the unvisited
         dots, and showing this layer too would paint every
         unvisited spot twice. */
      {
        layer: "list-spot-points-circle",
        name: "visibility",
        value: spotsHero ? "visible" : "none",
      },
      /* The ghost-spots underlay only on the record tabs: on the
         スポット tab the hero dots show the same unvisited
         spots, so the ghost would double them. */
      {
        layer: "ghost-spots-circle",
        name: "visibility",
        value: spotsHero ? "none" : "visible",
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

/* ---------------- the unridden ghost's late join ----------------
   The 路線 tab's ghost of everything not ridden (subtask 1457):
   its geometry is computed OFF the render path (review round 2 —
   the first cut simplified all 597 lines synchronously inside a
   useMemo, on every tab, before the first paint), so on a first
   mount the layer usually does not exist yet. It joins the live
   map through here once the computation lands, and a coverage
   change after the mount refreshes the source in place. */

export const UNRIDDEN_LINES_SOURCE_ID = "unridden-lines";
export const UNRIDDEN_LINES_LAYER_ID = "unridden-lines-ghost";
export const UNRIDDEN_LINES_FOCUS_LAYER_ID = "unridden-lines-focus";
/* The focused service's own unridden remainder rides its OWN
   source (subtask 1635) — it used to share the ghost source
   and select by formal-line key, so a branch service painted
   its whole formal line's remainder at midway strength
   (むさしの号's 東北線 slice drew the full Tokyo→Aomori
   shape). The source holds only the focused service's
   remainder features, so the layer needs no filter: an empty
   source paints nothing until a focus call fills it. */
export const UNRIDDEN_FOCUS_SOURCE_ID = "unridden-lines-focus";

/* The FOCUSED line's unridden remainder (subtask 1589, the
   reader's request of 2026-11-26; rescoped to the service
   itself by subtask 1635): while a line is focused, its
   not-yet-ridden stretches repaint from the ghost's whisper to
   a midway strength, so "where is this line still unridden"
   reads at a glance. The paint keeps each line's OWN color
   (the selection rule: emphasis never recolors) at a width /
   opacity between the ghost (1.6 / 0.25) and a ridden section
   (3.5 / 0.95) — clearly above the unselected lines' ghost,
   clearly below the ridden paint and the focus highlight, and
   never dashed (the reader's no-dash rule). App.tsx's focus
   switching fills the layer's own source with the focused
   service's remainder legs and trims the stretches they
   cover out of the ghost's source data meanwhile — span-
   precise by formal-line key and graph edge (subtask 1680,
   review round 1; the first cut excluded whole keys by
   layer filter) — so each stretch is painted exactly once,
   at exactly this strength. */
export const UNRIDDEN_FOCUS_LINE_WIDTH = 2.4;
export const UNRIDDEN_FOCUS_LINE_OPACITY = 0.5;

/* The remainder layer's spec — ONE source of truth, shared by
   the late join below and App.tsx's focus switching (the ghost
   layer's spec predates this sharing and is pinned equal by
   test instead). A fresh object per call, so no two layers
   ever share a mutable spec. */
export type UnriddenLineFocusLayerSpec = {
  id: string;
  type: string;
  source: string;
  layout: Record<string, unknown>;
  paint: Record<string, unknown>;
};

export function unriddenLineFocusLayerSpec(): UnriddenLineFocusLayerSpec {
  return {
    id: UNRIDDEN_LINES_FOCUS_LAYER_ID,
    type: "line",
    source: UNRIDDEN_FOCUS_SOURCE_ID,
    layout: {
      "line-cap": "round",
      "line-join": "round",
      visibility: "none",
    },
    paint: {
      "line-color": ["get", "color"],
      "line-width": UNRIDDEN_FOCUS_LINE_WIDTH,
      "line-opacity": UNRIDDEN_FOCUS_LINE_OPACITY,
    },
  };
}

/* One formal line's unridden remainder as a map feature, in its
   own color — the shape App.tsx's ghost computation produces
   and the mount overlay carries. */
export type UnriddenLineFeature = {
  type: "Feature";
  properties: { key: string; color: string };
  geometry: GeoJsonLineGeometry;
};

/* The minimal map surface ensureUnriddenLineGhost needs — the
   real MapLibreLike satisfies it, and tests drive it with a
   fake. */
export type UnriddenGhostMap = {
  getSource: (
    id: string,
  ) => { setData: (data: unknown) => void } | undefined;
  addSource: (id: string, source: Record<string, unknown>) => void;
  addLayer: (layer: Record<string, unknown>, beforeId?: string) => void;
  getLayer: (id: string) => unknown;
};

/* Adds the unridden-lines ghost source + layers to a live map,
   or refreshes its data when they already exist. The layer spec
   mirrors App.tsx's mount overlay exactly, inserted below the
   ridden lines — the paint order the mount's sort gives the
   family (unridden-lines sits directly under visited-lines,
   above the prefecture borders and the spot dots stay above
   it). Visibility starts at "none": the caller applies the
   variant paint right after, as the mount does, so a layer
   joining while the 路線 tab is up arrives visible and one
   joining elsewhere stays hidden. With no features and no
   source there is nothing to join yet — the next arrival
   retries. */
/* The family's insertion anchor: directly below the ridden
   lines, the paint order the mount's sort gives it. */
function unriddenInsertionAnchor(
  map: UnriddenGhostMap,
): string | undefined {
  return [
    "visited-lines-casing",
    "visited-lines-color",
    "visited-lines-unknown",
    "list-spot-points-circle",
  ].find((id) => map.getLayer(id));
}

/* Ensures the focused remainder's own source + layer exist on
   a live map (subtask 1589, own source since subtask 1635):
   the source arrives empty, the layer directly above the
   ghost. Callers fill the source with the focused service's
   remainder legs; an empty source paints nothing. A map whose
   ghost arrived through the mount already has the layer (the
   checks are no-ops there), and one built before the layer
   existed gains it here — a focus already active when the
   ghost lands is re-applied by the caller (App.tsx's ghost
   effect). */
export function ensureUnriddenRemainderFocus(map: UnriddenGhostMap): void {
  if (!map.getSource(UNRIDDEN_FOCUS_SOURCE_ID)) {
    map.addSource(UNRIDDEN_FOCUS_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer(UNRIDDEN_LINES_FOCUS_LAYER_ID)) {
    map.addLayer(
      unriddenLineFocusLayerSpec(),
      unriddenInsertionAnchor(map),
    );
  }
}

export function ensureUnriddenLineGhost(
  map: UnriddenGhostMap,
  features: readonly UnriddenLineFeature[],
): void {
  const data = { type: "FeatureCollection", features };
  const source = map.getSource(UNRIDDEN_LINES_SOURCE_ID);
  if (source) {
    source.setData(data);
    ensureUnriddenRemainderFocus(map);
    return;
  }
  if (features.length === 0) return;
  map.addSource(UNRIDDEN_LINES_SOURCE_ID, { type: "geojson", data });
  map.addLayer(
    {
      id: UNRIDDEN_LINES_LAYER_ID,
      type: "line",
      source: UNRIDDEN_LINES_SOURCE_ID,
      layout: {
        "line-cap": "round",
        "line-join": "round",
        visibility: "none",
      },
      paint: {
        "line-color": ["get", "color"],
        "line-width": 1.6,
        "line-opacity": 0.25,
      },
    },
    unriddenInsertionAnchor(map),
  );
  ensureUnriddenRemainderFocus(map);
}

/* A computed ghost and the ledger it belongs to: the coverage
   key is the fingerprint of the painted legs the features were
   computed from (ghostCoverageKey in unridden-ghost.ts). */
export type UnriddenGhostResult = {
  coverageKey: string;
  features: readonly UnriddenLineFeature[];
};

/* Applies the LATEST ghost result to the map — but only while
   it still belongs to the CURRENT ledger (subtask 1457, review
   round 3, finding 1). The deferred paths that reach the map
   (the data effect's waiter, the mount callback) call this
   with the latest result read from a ref AT EXECUTION TIME,
   never with a value captured when the waiter was registered:
   the first deferred cut captured the features at effect time,
   so a waiter registered while the ghost was still empty could
   fire after the real features had already been applied and
   wipe the source back to empty — the layer stayed visible,
   the ghost vanished. Reading the latest result at fire time
   makes a late waiter re-apply the CURRENT ghost instead, and
   the coverage-key check refuses a result whose ledger has
   already moved on (its replacement is on its way through the
   compute effect). Returns whether anything was applied. */
export function applyUnriddenLineGhostLatest(
  map: UnriddenGhostMap,
  latest: UnriddenGhostResult | null,
  currentCoverageKey: string,
): boolean {
  if (!latest || latest.coverageKey !== currentCoverageKey) return false;
  ensureUnriddenLineGhost(map, latest.features);
  return true;
}

/* ---------------- the remainder focus's key decision ----------------
   Which formal-line keys the focused row's unridden remainder
   paints at midway strength (subtask 1589), decided from the
   SELECTED ROW's own record — Codex review batch round 1,
   finding 4. The painted legs are a per-SERVICE aggregate:
   every row linked to one service contributes its sections to
   the same entry, so when two rows share a service — a partial
   「むさしの号」 and an unknown 「JRむさしの号」 — the aggregate's
   unknown flag is false even for the unknown row. Deciding
   from the aggregate alone singled out a remainder for a row
   that recorded no section at all: an unknown ride has no
   ridden section to have a remainder against (its whole path
   is the focus highlight already), so the row's own rideState
   vetoes the emphasis. A partial or full row keeps the
   aggregate's keys, exactly as subtask 1589 painted them. */

/* One service's painted legs, as the coverage computes them:
   the legs it paints and whether the SERVICE's rides are all
   unrecorded (unknown). */
export type RemainderPaintedLegs = {
  legs: readonly { key: string }[];
  unknown: boolean;
};

/* The remainder keys for one selected row: the distinct keys
   of its service's painted legs, or an empty list when nothing
   may be singled out (no painted legs, a service-level
   unknown, or the row's own unknown ride). An empty list is a
   decision, not an absence: callers apply it, clearing any
   emphasis a previous selection left on the layers. */
export function unriddenRemainderKeysForRow(
  row: { rideState: RideState },
  painted: RemainderPaintedLegs | undefined,
): string[] {
  if (!painted || painted.legs.length === 0) return [];
  if (painted.unknown) return [];
  if (row.rideState === "unknown") return [];
  return [...new Set(painted.legs.map((leg) => leg.key))];
}

/* The remainder keys for the CURRENT selection, resolved from
   the ledger rows and the coverage — the re-apply the mount
   completion and the ghost's late join share (Codex review
   batch round 1, finding 3). A map rebuilt under a live
   selection (a municipality data update remounts the map while
   the ghost result stands, so the ghost effect never re-runs)
   creates the remainder layer with its empty source, and
   only this re-apply restores the emphasis on it. Returns null
   when there is no applicable selection — no focused row, a
   focused row that has left the ledger or whose link is
   unusable, or a service with no painted legs — meaning "leave
   the layers as they are": at a mount that is the fresh
   layer's empty filter, in the ghost effect the state the tap
   already set. */
export function unriddenRemainderKeysForSelection<
  Row extends RiddenServiceLink & { id: number; rideState: RideState },
>(
  rows: readonly Row[],
  perServiceLegs: ReadonlyMap<string, RemainderPaintedLegs>,
  focusedRowId: number | null,
): string[] | null {
  if (focusedRowId === null) return null;
  const row = rows.find((candidate) => candidate.id === focusedRowId);
  if (!row) return null;
  const service = usableRiddenService(row);
  if (!service) return null;
  const painted = perServiceLegs.get(service.id);
  if (!painted || painted.legs.length === 0) return null;
  return unriddenRemainderKeysForRow(row, painted);
}

/* One leg of a service's own unridden remainder, as the focus
   layer paints it: its formal-line key (for the color) and its
   coordinates. The coverage's perServiceUnriddenLegs entries
   satisfy this shape (PathLeg carries both, plus the edge
   frame the subtraction ran on). */
export type RemainderLeg = {
  key: string;
  coords: readonly [number, number][];
};

/* The remainder LEGS for one selected row (subtask 1635): the
   service's own unridden stretches from the coverage, or an
   empty list when nothing may be singled out. The vetoes are
   the keys helper's, exactly — no painted legs, a
   service-level unknown, or the row's own unknown ride — so
   the keys (which decide whether an emphasis exists) and the
   legs (which fill the focus source and, in their full edge
   frame, drive the ghost's trim) can never disagree about
   whether an emphasis exists. An empty list is a decision,
   not an absence: callers apply it, clearing any emphasis a
   previous selection left on the layers. */
export function unriddenRemainderLegsForRow(
  row: { rideState: RideState },
  painted: RemainderPaintedLegs | undefined,
  unriddenLegs: readonly RemainderLeg[] | undefined,
): readonly RemainderLeg[] {
  if (!painted || painted.legs.length === 0) return [];
  if (painted.unknown) return [];
  if (row.rideState === "unknown") return [];
  return unriddenLegs ?? [];
}

/* The remainder legs for the CURRENT selection — the legs twin
   of unriddenRemainderKeysForSelection, resolved the same way
   and returning null under the same conditions, so the
   re-apply the mount completion and the ghost's late join
   share restores the keys and the legs together. */
export function unriddenRemainderLegsForSelection<
  Row extends RiddenServiceLink & { id: number; rideState: RideState },
>(
  rows: readonly Row[],
  perServiceLegs: ReadonlyMap<string, RemainderPaintedLegs>,
  perServiceUnriddenLegs: ReadonlyMap<string, readonly RemainderLeg[]>,
  focusedRowId: number | null,
): readonly RemainderLeg[] | null {
  if (focusedRowId === null) return null;
  const row = rows.find((candidate) => candidate.id === focusedRowId);
  if (!row) return null;
  const service = usableRiddenService(row);
  if (!service) return null;
  const painted = perServiceLegs.get(service.id);
  if (!painted || painted.legs.length === 0) return null;
  return unriddenRemainderLegsForRow(
    row,
    painted,
    perServiceUnriddenLegs.get(service.id),
  );
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

/* The スポット tab's whole-country initial camera (review round 1,
   finding 4): the mount opens on it, and entering the スポット tab
   with no Pixel position restores it instead of keeping the record
   tab's view. The zoom follows the pane width, exactly as the mount
   computed it inline before this helper existed. */
export function spotsInitialCamera(containerWidthPx: number): {
  center: { lat: number; lng: number };
  zoom: number;
} {
  return {
    center: { lat: 37.6, lng: 138.4 },
    zoom: containerWidthPx > 0 && containerWidthPx < 560 ? 3.2 : 4.2,
  };
}

/* The mount effect's dependency snapshot, for the スポット-tab
   remount skip below. */
export type MapMountKeys = {
  placesKey: string;
  riddenLinesKey: string;
  mapAttempt: number;
  mapFailed: boolean;
  boundarySettled: boolean;
  showMapPane: boolean;
};

/* Whether a mount-effect re-run may skip rebuilding the map
   (review round 1, finding 5): only when the ONLY thing that
   changed since the last mount is the record data
   (placesKey / riddenLinesKey), the スポット tab is showing, and
   a live map exists to keep using. A retry, a failure flip, the
   boundary set settling, or the pane appearing is never a
   record-only change, so those still mount; with no previous
   mount there is nothing to keep, so the first run mounts too.
   The caller remembers the skipped data as stale and rebuilds on
   the next record-tab entry. */
export function shouldSkipSpotRemount(
  lastKeys: MapMountKeys | null,
  nextKeys: MapMountKeys,
  variant: RecordMapVariant,
  hasLiveMap: boolean,
): boolean {
  if (!lastKeys || !hasLiveMap || variant !== "spots") return false;
  const recordDataChanged =
    lastKeys.placesKey !== nextKeys.placesKey ||
    lastKeys.riddenLinesKey !== nextKeys.riddenLinesKey;
  if (!recordDataChanged) return false;
  return (
    lastKeys.mapAttempt === nextKeys.mapAttempt &&
    lastKeys.mapFailed === nextKeys.mapFailed &&
    lastKeys.boundarySettled === nextKeys.boundarySettled &&
    lastKeys.showMapPane === nextKeys.showMapPane
  );
}

/* The record-data arrival's verdict for the shared map (review
   round 2, finding 5): the mount effect's own cleanup used to
   destroy the map before the new run could decide to skip, so
   the skip could never take effect — React runs the previous
   run's cleanup first. The decision therefore lives in a
   separate effect that watches only the record-data keys, and
   the mount effect no longer watches them at all:
   - "none": no previous mount yet, or the record data did not
     change — nothing to do (a re-render alone must never bump
     the retry nonce, or the mount would rebuild in a loop).
   - "skip": a record-only arrival on the スポット tab with a
     live map — remember the data as stale, rebuild on the next
     record-tab entry instead.
   - "remount": anything else that changed the record data —
     bump the retry nonce so the mount effect rebuilds. */
export type SpotDataRemountDecision = "none" | "skip" | "remount";
export function decideSpotDataRemount(
  lastKeys: MapMountKeys | null,
  nextKeys: MapMountKeys,
  variant: RecordMapVariant,
  hasLiveMap: boolean,
): SpotDataRemountDecision {
  if (!lastKeys) return "none";
  const recordDataChanged =
    lastKeys.placesKey !== nextKeys.placesKey ||
    lastKeys.riddenLinesKey !== nextKeys.riddenLinesKey;
  if (!recordDataChanged) return "none";
  return shouldSkipSpotRemount(lastKeys, nextKeys, variant, hasLiveMap)
    ? "skip"
    : "remount";
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

/* Whether the shared map's pane block renders at all on a
   tab (v89 review round 2, finding 2): the スポット tab
   always has its pane (its whole-country camera is the empty
   state), while a record tab's pane block — the fullscreen
   wrapper and its toggle button included — renders only
   when some ledger has rows; with zero records the empty
   state renders instead. Fullscreen is only meaningful
   while this holds: carried into a pane-less record tab,
   the shared flag (and the page scroll lock it holds) would
   stay on with neither a map nor an exit button rendered,
   and touch would have no way out. */
export function mapPaneBlockRendered(
  variant: RecordMapVariant,
  totalVisited: number,
  hasRiddenLines: boolean,
): boolean {
  return variant === "spots" || totalVisited > 0 || hasRiddenLines;
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
