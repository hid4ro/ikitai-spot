/* The ridden-line focus paint: the functions that feed the
   focus sources (visited-line-focus and unridden-lines-focus)
   and switch the normal line layers out while a line is
   focused. They lived inside App.tsx until subtask 1680
   fix4 — App.tsx cannot be imported by the tests (it pulls
   the generated ghost-worker asset), so the round-3 review
   finding stood: a call site reverting to per-formal-line
   colors would pass every test, because the tests could only
   call the shared feature builders, never the code that
   hands features to the map. The functions moved here
   verbatim (behavior unchanged) so line-map-paint.test.ts
   can drive them against a mock map and assert the
   properties.color the sources actually receive. The
   normal overlay's assembly (visitedLinesOverlay, at the
   bottom) joined them in fix5: the round-4 review showed
   the normal path still assembled its source data inside
   the component's useMemo, one step past the builder the
   tests drove, so a call-site revert there passed every
   test the same way. */
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import type { MapLibreLike } from "./map-helpers.mjs";
import {
  usableRiddenService,
  type RideState,
  type RiddenServiceLink,
} from "../../shared/service-master";
import {
  focusSectionFeature,
  paintedLineFeatures,
  remainderLegFeature,
  type LineCoverage,
  type LineGeometryMap,
  type PaintedLegFeature,
  type PathLeg,
} from "./line-geometry";
import {
  ghostFeaturesMatchCoverage,
  trimUnriddenGhostFeatures,
} from "./unridden-ghost";
import {
  ensureUnriddenRemainderFocus,
  UNRIDDEN_FOCUS_SOURCE_ID,
  UNRIDDEN_LINES_SOURCE_ID,
  unriddenRemainderKeysForRow,
  unriddenRemainderKeysForSelection,
  unriddenRemainderLegsForRow,
  unriddenRemainderLegsForSelection,
  type RecordMapVariant,
  type RemainderLeg,
  type RemainderPaintedLegs,
  type UnriddenLineFeature,
} from "./map-variant";

/* The empty collection the focus sources reset to — shared
   with App.tsx's municipality focus, which clears its own
   sources to the same object. */
export const EMPTY_FOCUS_DATA = { type: "FeatureCollection", features: [] };

/* ---------------- ridden-line focus highlight ----------------
   The 路線 counterpart of App.tsx's municipality focus: while a
   line is focused, its NORMAL layers (visited-lines casing +
   color) filter it out and the focus layers below replace it.
   Unlike the municipality focus, the paint keeps the line's OWN
   color (2026-11-25, the reader's request: repainting the line
   signal orange hides which line it is). The emphasis is carried
   by width and layering instead — a halo in the line's own color
   at low opacity, a white casing, and a core in the line's own
   color, drawn wider than any normal line so the focused line
   reads at a glance without losing its identity. The color rides
   on each focus feature as a property (see setFocusSection), the
   same contract as the normal line layers. On the 市区町村 tab
   the line layers stay out of the tap hit-test set, so the
   highlight cannot intercept a municipality tap; on the 路線 tab
   the focus layers ARE hit-tested, so the highlighted track
   itself stays tappable (see the line tap handler). */

export const LINE_FOCUS_SOURCE_ID = "visited-line-focus";

function ensureLineFocusLayers(map: MapLibreLike) {
  if (!map.getSource(LINE_FOCUS_SOURCE_ID)) {
    map.addSource(LINE_FOCUS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getLayer("visited-line-focus-halo")) {
    map.addLayer({
      id: "visited-line-focus-halo",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 0.3,
        "line-width": 13,
      },
    });
  }
  if (!map.getLayer("visited-line-focus-casing")) {
    map.addLayer({
      id: "visited-line-focus-casing",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.95,
        "line-width": 8,
      },
    });
  }
  if (!map.getLayer("visited-line-focus-color")) {
    map.addLayer({
      id: "visited-line-focus-color",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 1,
        "line-width": 5,
      },
    });
  }
}

/* Line-focus switching, mirroring setNormalFillExclusion: while a
   line is focused its normal paint is filtered out of the
   visited-lines layers and the focus layers replace it, so the
   line is never double-painted. The exclusion is by SERVICE id
   (the property every overlay feature carries), not by formal
   line key: two services can share one key — 総武本線 and
   総武快速線 both paint JR・総武線 — and focusing one must not
   hide the other (integrated review round 1, medium). Null
   restores every line. The unknown layer is excluded the
   same way: a focused unknown ride must not show both as a
   thin whole path and as the focus highlight. */
function setNormalLineExclusion(map: MapLibreLike, serviceId: string | null) {
  const filter = serviceId
    ? ["all", ["!=", ["get", "unknown"], true], ["!=", ["get", "serviceId"], serviceId]]
    : ["!=", ["get", "unknown"], true];
  const unknownFilter = serviceId
    ? ["all", ["==", ["get", "unknown"], true], ["!=", ["get", "serviceId"], serviceId]]
    : ["==", ["get", "unknown"], true];
  if (map.getLayer("visited-lines-casing")) {
    map.setFilter("visited-lines-casing", filter);
  }
  if (map.getLayer("visited-lines-color")) {
    map.setFilter("visited-lines-color", filter);
  }
  if (map.getLayer("visited-lines-unknown")) {
    map.setFilter("visited-lines-unknown", unknownFilter);
  }
}

/* The ghost context a remainder-focus call rewrites the
   ghost's source from: the canonical features (the worker's
   latest result, held by the caller), the coverage key of
   the result they came from, and the CURRENT coverage.
   `spans` are the focused service's remainder legs in their
   full edge frame — the stretches the ghost must not also
   paint while the focus layer shows them at midway strength.
   No spans restores the canonical features untouched. The
   source is rewritten only while the features still belong
   to the current coverage (ghostFeaturesMatchCoverage):
   after a ledger change the held result is the old ledger's
   until the worker's fresh answer lands. */
export type RemainderGhostContext = {
  features: readonly UnriddenLineFeature[];
  coverageKey: string | null;
  coverage: LineCoverage;
  spans: readonly PathLeg[];
};

/* The focused line's unridden remainder (subtask 1589,
   rescoped to the service itself by subtask 1635): while a
   line is focused, the stretches of ITS OWN path it has not
   ridden yet repaint at the midway strength of the
   unridden-lines-focus layer (see map-variant.ts for the
   paint), so where the selected line is still unridden reads
   at a glance. The layer reads its OWN source, filled here
   with the service's remainder legs from the coverage — the
   old cut shared the ghost source and selected by formal-line
   key, so a branch service painted its whole formal line's
   remainder (むさしの号's 東北線 slice drew Tokyo→Aomori).
   The switching mirrors setNormalLineExclusion: every stretch
   is painted exactly once, at exactly one strength — the
   ghost's source is rewritten with the remainder's stretches
   trimmed out of it (trimUnriddenGhostFeatures in
   unridden-ghost.ts), span-precise by formal-line key and
   graph edge, so the rest of a shared formal line keeps its
   ghost while its service is focused （東北線 north of 田端
   survives a 山手線 focus). The first cut excluded whole
   formal-line keys by layer filter, keyed off the PAINTED
   legs' keys: a ride painting only one of a service's keys
   left the other keys' ghosts stacked under the remainder,
   shifting its hue (subtask 1680, review round 1). An
   unknown ride passes no keys and no legs — nothing is
   recorded as ridden for it, so there is no remainder to
   single out, and its whole path is the focus highlight
   already. Null (or no keys) restores the ghost's canonical
   features and empties the focus source. A map whose focus
   layer never joined yet gains it here, as in
   ensureLineFocusLayers. A caller that cannot supply the
   ghost context (ghost = null) leaves the ghost's source as
   it stands; the paths that can — every focus change and
   clear — pass it, and the ghost's own late join re-applies
   the current focus right after landing. */
export function setUnriddenRemainderFocus(
  map: MapLibreLike,
  keys: readonly string[] | null,
  legs: readonly RemainderLeg[],
  serviceId?: string | null,
  ghost?: RemainderGhostContext | null,
  variant?: RecordMapVariant,
) {
  const active = keys && keys.length > 0 ? [...keys] : null;
  /* The current tab rides along so a remainder layer CREATED
     by this call starts at that tab's visibility (subtask
     1648): no variant paint runs after a focus call, so the
     spec's default "none" would strand a filled layer
     invisible whenever the ghost had not landed yet — and
     for good if the ghost computation then failed. */
  ensureUnriddenRemainderFocus(map, variant);
  map.getSource(UNRIDDEN_FOCUS_SOURCE_ID)?.setData({
    type: "FeatureCollection",
    /* remainderLegFeature (line-geometry.ts) builds these —
       the same builder the tests assert the colors through
       (subtask 1680, review round 2, finding 3). A
       paint-unified service (山手線) keeps its representative
       color on the remainder too, so the focused loop reads
       as one line at both strengths. */
    features: legs.map((leg) =>
      remainderLegFeature(serviceId ?? null, leg, RIDDEN_LINE_GEOMETRIES),
    ),
  });
  if (
    ghost &&
    ghost.features.length > 0 &&
    ghostFeaturesMatchCoverage(ghost.coverageKey, ghost.coverage)
  ) {
    /* The coverage-key gate (subtask 1680, review round 2,
       finding 2 — the same discipline as the worker apply
       path's, in applyUnriddenLineGhostLatest): while the
       worker recomputes after a ledger change, the held
       features belong to the old coverage, and writing them
       back here — trimmed against the new coverage's spans,
       or restored whole on a focus clear — would resurrect a
       stale ghost. Leaving the source as it stands is safe:
       the fresh result joins through the apply path, which
       re-applies the current focus right after landing. */
    map.getSource(UNRIDDEN_LINES_SOURCE_ID)?.setData({
      type: "FeatureCollection",
      features:
        active && ghost.spans.length > 0
          ? trimUnriddenGhostFeatures(
              ghost.features,
              ghost.coverage,
              RIDDEN_LINE_GEOMETRIES,
              ghost.spans,
            )
          : ghost.features,
    });
  }
  /* The ghost layer carries no filter: the exclusion lives in
     its source data now, not in a key filter. Clearing any
     filter a previous build set keeps that invariant on a map
     that outlives the switch. */
  if (map.getLayer("unridden-lines-ghost")) {
    map.setFilter("unridden-lines-ghost", null);
  }
}

/* The selection-time remainder emphasis (subtask 1648 fix3):
   the three tap paths — ledger row, operator bar, map line tap —
   shared this assembly verbatim in App.tsx: resolve the
   selected row's remainder legs and keys from the coverage,
   then hand them to setUnriddenRemainderFocus with the current
   tab's variant, so a remainder layer CREATED by the tap starts
   at that tab's visibility (subtask 1648). It moved here
   verbatim (behavior unchanged) for the same reason the focus
   paint moved in fix4: App.tsx cannot be imported by the
   tests (it pulls the generated ghost-worker asset), so a
   call site dropping the variant — the 1648 review's case —
   passed every test that only drove the helper below this
   assembly. line-map-paint.test.ts drives this function from
   an actual line selection on a map the ghost has not reached
   and asserts the layer's initial visibility and the source's
   contents. The variant is REQUIRED here (not optional as in
   setUnriddenRemainderFocus): dropping it at a call site is a
   type error, so the pass-through cannot silently strand a
   filled layer at the spec's default "none" again. */
export function applySelectedLineRemainderFocus(
  map: MapLibreLike,
  row: { rideState: RideState },
  painted: RemainderPaintedLegs | undefined,
  coverage: LineCoverage,
  serviceId: string,
  ghost: Omit<RemainderGhostContext, "spans">,
  variant: RecordMapVariant,
): void {
  const unriddenLegs = coverage.perServiceUnriddenLegs.get(serviceId);
  const remainderLegs = unriddenRemainderLegsForRow(
    row,
    painted,
    unriddenLegs,
  );
  setUnriddenRemainderFocus(
    map,
    unriddenRemainderKeysForRow(row, painted),
    remainderLegs,
    serviceId,
    {
      ...ghost,
      /* The trim cuts exactly the legs the focus
         source paints, in their full edge frame. */
      spans: remainderLegs.length > 0 ? (unriddenLegs ?? []) : [],
    },
    variant,
  );
}

/* The CURRENT selection's re-apply (subtask 1648 fix3): the
   mount completion and the ghost's late join share this routine
   in App.tsx (Codex review batch round 1, finding 3) — both
   paths (re)build the layer with its empty source, and when the
   ghost result itself did not change, the ghost effect never
   re-runs, so without this the row would stay selected while
   its emphasis is gone. Moved here verbatim (behavior
   unchanged) with the tap assembly above, for the same
   testability reason: it is the fourth setUnriddenRemainderFocus
   call site, and the one the mount and ghost-join paths run.
   No applicable selection — the layers keep their state (a
   fresh layer's empty source is exactly that state). The
   variant is REQUIRED here too, for the same reason. */
export function reapplyUnriddenRemainderFocus(
  map: MapLibreLike,
  rows: readonly (RiddenServiceLink & {
    id: number;
    rideState: RideState;
  })[],
  coverage: LineCoverage,
  focusedLineId: number | null,
  ghost: Omit<RemainderGhostContext, "spans">,
  variant: RecordMapVariant,
): void {
  const keys = unriddenRemainderKeysForSelection(
    rows,
    coverage.perServiceLegs,
    focusedLineId,
  );
  const legs = unriddenRemainderLegsForSelection(
    rows,
    coverage.perServiceLegs,
    coverage.perServiceUnriddenLegs,
    focusedLineId,
  );
  if (keys !== null && legs !== null) {
    /* The selection's service, resolved the same way the
       keys/legs helpers resolve it, so a paint-unified
       service's remainder keeps its representative color
       on this re-apply path too (subtask 1680). */
    const focusedRow = rows.find((row) => row.id === focusedLineId);
    const focusService = focusedRow
      ? usableRiddenService(focusedRow)
      : undefined;
    /* The ghost trim's spans: the service's remainder legs
       in their full edge frame — the same legs the focus
       source paints, before the RemainderLeg projection
       drops the frame. An empty remainder trims nothing. */
    const spans =
      legs.length > 0 && focusService
        ? (coverage.perServiceUnriddenLegs.get(focusService.id) ?? [])
        : [];
    setUnriddenRemainderFocus(map, keys, legs, focusService?.id ?? null, {
      ...ghost,
      spans,
    }, variant);
  }
}

/* Paints one ridden service's painted legs as the focus
   highlight, swapping them out of the normal line layers (see
   setNormalLineExclusion). `legs` are the service's painted legs
   from the line coverage — a partial ride highlights only its
   ridden section, a full ride its whole path, an unknown ride
   its whole path. Each feature carries its leg's own color (the
   asset entry for the leg's key, the same lookup the normal
   overlay features use) so the focus layers paint the line in
   its own color; a leg whose asset entry has no color falls
   back to the signal orange, the pre-2026-11-25 paint. The
   features carry the serviceId too, so a tap on the highlight
   itself resolves to the same service (the focus layers are in
   the tap hit-test set — see the line tap handler). */
export function setFocusSection(
  map: MapLibreLike,
  serviceId: string,
  legs: readonly { key: string; coords: readonly [number, number][] }[],
) {
  ensureLineFocusLayers(map);
  setNormalLineExclusion(map, serviceId);
  map.getSource(LINE_FOCUS_SOURCE_ID)?.setData({
    type: "FeatureCollection",
    /* focusSectionFeature (line-geometry.ts) builds these —
       the same builder the tests assert the colors through
       (subtask 1680, review round 2, finding 3). A
       paint-unified service (山手線) highlights in its
       representative color throughout, not per formal line —
       the highlight is the service's identity cue. */
    features: legs.map((leg) =>
      focusSectionFeature(serviceId, leg, RIDDEN_LINE_GEOMETRIES),
    ),
  });
}

export function clearFocusLineGeometry(
  map: MapLibreLike,
  ghost?: Omit<RemainderGhostContext, "spans"> | null,
  variant?: RecordMapVariant,
) {
  setNormalLineExclusion(map, null);
  /* No spans: the ghost's source goes back to the canonical
     features, undoing the cleared focus's trim. */
  setUnriddenRemainderFocus(
    map,
    null,
    [],
    null,
    ghost ? { ...ghost, spans: [] } : ghost,
    variant,
  );
  map.getSource(LINE_FOCUS_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
}

/* ---------------- the normal ridden-lines overlay ----------------
   The overlay spec the component pushes for the visited-lines
   source at mount: the painted features as the source data,
   plus the three layers that paint them. This assembly lived
   in the component until subtask 1680 fix5 — the features
   came from paintedLineFeatures (line-geometry.ts), but the
   component wrapped them into the source data itself, and
   the round-4 review proved that reverting just that
   wrapping step to per-formal-line colors passed all 344
   tests: the tests drove the builder, never the assembly
   whose result the source actually receives. Assembling
   here puts the normal path under the same assertion as the
   focus paths (line-map-paint.test.ts drives this function
   and reads the colors off the returned data). Returns null
   when nothing paints, matching the component's old gate. */

export const VISITED_LINES_SOURCE_ID = "visited-lines";

export type VisitedLinesOverlay = {
  id: typeof VISITED_LINES_SOURCE_ID;
  data: { type: "FeatureCollection"; features: PaintedLegFeature[] };
  layers: {
    id: string;
    type: "line";
    source: typeof VISITED_LINES_SOURCE_ID;
    layout: Record<string, string>;
    filter: unknown[];
    paint: Record<string, unknown>;
  }[];
};

export function visitedLinesOverlay(
  perServiceLegs: LineCoverage["perServiceLegs"],
  geometries: LineGeometryMap,
): VisitedLinesOverlay | null {
  /* paintedLineFeatures (line-geometry.ts) builds the
     features — the same builder the focus paths' tests
     assert through. A paint-unified service (山手線) paints
     every leg in its representative color: the loop is one
     named line to the reader even where its trains run on
     the 東北線・東海道線 formal lines. The leg's key still
     names its formal line for coverage and the ghost; a leg
     with no color at all is skipped, as before. */
  const features = paintedLineFeatures(perServiceLegs, geometries);
  if (features.length === 0) return null;
  return {
    id: VISITED_LINES_SOURCE_ID,
    data: {
      type: "FeatureCollection",
      features,
    },
    layers: [
      {
        id: "visited-lines-casing",
        type: "line",
        source: VISITED_LINES_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        filter: ["!=", ["get", "unknown"], true],
        paint: {
          "line-color": "#ffffff",
          "line-width": 5.5,
          "line-opacity": 0.55,
        },
      },
      {
        id: "visited-lines-color",
        type: "line",
        source: VISITED_LINES_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        filter: ["!=", ["get", "unknown"], true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 3.5,
          "line-opacity": 0.95,
        },
      },
      /* Unknown rides (a row with no section on record):
         the whole path as a thin solid line in the
         service's color — the same look as the unridden
         ghost, never a ridden section's strength. The
         reader's rule: ridden = solid, unridden and
         unknown = thin, no dashes. The layer stays
         separate from the ghost so a tap on the track
         still resolves to the ride's ledger row and a
         line focus can filter it out (see
         setNormalLineExclusion). */
      {
        id: "visited-lines-unknown",
        type: "line",
        source: VISITED_LINES_SOURCE_ID,
        layout: { "line-cap": "round", "line-join": "round" },
        filter: ["==", ["get", "unknown"], true],
        paint: {
          "line-color": ["get", "color"],
          "line-width": 1.6,
          "line-opacity": 0.25,
        },
      },
    ],
  };
}
