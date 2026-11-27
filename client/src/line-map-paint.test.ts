/* Regression tests for the colors the map's line sources
   actually receive (subtask 1680, review round 3, finding 2).

   The fix3 tests asserted through the shared feature builders
   in line-geometry.ts — but the builders are only half the
   contract: if a call site in the component stopped using
   them and painted per formal line again, every builder test
   would still pass while 山手線's loop went back to three
   colors on the real map (the reviewer proved exactly that
   by reverting the unridden focus paint). These tests drive
   the production source-feeding code itself:

   - normal overlay: visitedLinesOverlay
     (line-map-focus.ts), the assembly whose return value
     the component pushes verbatim as the visited-lines
     overlay — source data and layers (fix4 drove
     paintedLineFeatures, the builder one step below this
     assembly; the round-4 review reverted the assembly
     step itself and every test still passed);
   - ridden focus: setFocusSection (line-map-focus.ts) run
     against a mock map, asserting the data the
     visited-line-focus source received;
   - unridden focus: applySelectedLineRemainderFocus /
     reapplyUnriddenRemainderFocus (line-map-focus.ts) against a
     mock map, asserting the layer's initial visibility and the
     data the unridden-lines-focus source received — the
     selection assemblies themselves, not the helper below
     them (fix3 drove setUnriddenRemainderFocus directly, and
     the 1648 review reverted the variant pass-through at the
     App.tsx call sites while every test still passed).

   The scenario is the reader's real ledger shape: a 山手線
   ride whose legs run on all three formal lines the loop
   uses — 山手線 #80C241 green, 東北線 #00418E dark blue,
   東海道線 #F15A22 orange. Every feature on every path must
   carry the unified green; the 中央線 control keeps its own
   formal-line orange through the same paths, so the tests
   cannot pass by painting everything green either.
   Run with: bun test client/src/line-map-paint.test.ts */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import type { MapLibreLike } from "./map-helpers.mjs";
import {
  computeRiddenLineCoverage,
  ghostLegsForKey,
  type LineGeometryMap,
  type PathLeg,
} from "./line-geometry";
import {
  applySelectedLineRemainderFocus,
  applyUnriddenLineFocus,
  clearFocusLineGeometry,
  LINE_FOCUS_SOURCE_ID,
  reapplyUnriddenRemainderFocus,
  setFocusSection,
  setUnriddenRemainderFocus,
  VISITED_LINES_SOURCE_ID,
  visitedLinesOverlay,
  type RemainderGhostContext,
} from "./line-map-focus";
import {
  UNRIDDEN_FOCUS_SOURCE_ID,
  UNRIDDEN_LINES_FOCUS_LAYER_ID,
  UNRIDDEN_LINES_SOURCE_ID,
  type RecordMapVariant,
} from "./map-variant";
import {
  computeUnriddenGhostFeatures,
  ghostCoverageKey,
  serializeGhostCoverage,
} from "./unridden-ghost";
import type { StationRef } from "../../shared/service-master";

const GEOMETRIES = RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap;
const GREEN = "#80C241";
const TOHOKU_BLUE = "#00418E";
const TOKAIDO_ORANGE = "#F15A22";

function station(id: string, name: string, lng: number, lat: number): StationRef {
  return { id, name, lng, lat };
}

/* N02 station centroids (the master's values), the stations
   the scenario rides between — same values as
   line-geometry.test.ts. */
const S = {
  東京: station("003766", "東京", 139.76675, 35.68128),
  新宿: station("003700", "新宿", 139.69993, 35.6898),
  大崎: station("004135", "大崎", 139.72807, 35.61985),
  目黒: station("004072", "目黒", 139.71568, 35.63272),
};

const section = (
  fromStationId: string,
  toStationId: string,
  direction: "inner" | "outer",
) => ({
  fromStationId,
  toStationId,
  direction,
  blockId: null,
  recordedServiceId: "yamanote",
});

const yamanoteRow = (sections: ReturnType<typeof section>[]) => ({
  name: "山手線",
  serviceId: "yamanote",
  serviceLinkSource: null,
  recordedServiceId: "yamanote",
  fromStationId: S.大崎.id,
  toStationId: S.目黒.id,
  pathSnapshot: null as string | null,
  rideState: "partial" as const,
  sections,
});

/* A ride spanning the whole east side: 新宿→大崎 (inner) plus
   大崎→東京 (inner), whose legs run on the 東北線 key
   explicitly — the stretch that painted orange/blue. */
const yamanoteCoverage = () =>
  computeRiddenLineCoverage(
    [
      yamanoteRow([
        section(S.新宿.id, S.大崎.id, "inner"),
        section(S.大崎.id, S.東京.id, "inner"),
      ]),
    ],
    GEOMETRIES,
    597,
  );

/* ---------------- the mock map ----------------
   Just the source/layer surface the focus paint touches:
   sources record every setData payload verbatim, so the
   assertions read what a real map would have received. */
type FeatureData = {
  type: string;
  features: { properties: { key: string; color: string } }[];
};

class MockSource {
  data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
  setData(data: unknown) {
    this.data = data;
  }
}

class MockMap {
  sources = new Map<string, MockSource>();
  layers = new Map<string, Record<string, unknown>>();
  filters = new Map<string, unknown>();
  getSource(id: string) {
    return this.sources.get(id);
  }
  addSource(id: string, spec: Record<string, unknown>) {
    this.sources.set(id, new MockSource(spec.data));
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  addLayer(layer: Record<string, unknown>) {
    this.layers.set(layer.id as string, layer);
  }
  setFilter(id: string, filter: unknown) {
    this.filters.set(id, filter);
  }
  sourceFeatures(id: string) {
    const data = this.sources.get(id)?.data as FeatureData | undefined;
    return data?.features ?? [];
  }
}

const asMap = (mock: MockMap) => mock as unknown as MapLibreLike;

describe("the colors the line sources receive (subtask 1680 fix5)", () => {
  test("normal overlay: the assembled visited-lines source data paints every 山手線 leg unified green", () => {
    const coverage = yamanoteCoverage();
    const painted = coverage.perServiceLegs.get("yamanote")!;
    /* The input really does put legs on all three keys, or
       the color assertions would not cover the stretch that
       broke. */
    const keys = new Set(painted.legs.map((leg) => leg.key));
    expect(keys.has("山手線|東日本旅客鉄道")).toBe(true);
    expect(keys.has("東北線|東日本旅客鉄道")).toBe(true);
    expect(keys.has("東海道線|東日本旅客鉄道")).toBe(true);

    /* Drive the assembly itself — the object the component
       pushes as the overlay — not the builder below it. */
    const overlay = visitedLinesOverlay(coverage.perServiceLegs, GEOMETRIES);
    expect(overlay).not.toBeNull();
    expect(overlay!.id).toBe(VISITED_LINES_SOURCE_ID);
    expect(overlay!.layers.map((layer) => layer.id)).toEqual([
      "visited-lines-casing",
      "visited-lines-color",
      "visited-lines-unknown",
    ]);
    const features = overlay!.data.features;
    expect(features.length).toBe(painted.legs.length);
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.properties.color).toBe(GREEN);
      expect(feature.properties.color).not.toBe(TOHOKU_BLUE);
      expect(feature.properties.color).not.toBe(TOKAIDO_ORANGE);
    }
  });

  test("normal overlay: nothing painted assembles to no overlay", () => {
    expect(visitedLinesOverlay(new Map(), GEOMETRIES)).toBeNull();
  });

  test("ridden focus: setFocusSection hands the focus source unified-green features", () => {
    const coverage = yamanoteCoverage();
    const painted = coverage.perServiceLegs.get("yamanote")!;
    const map = new MockMap();
    setFocusSection(asMap(map), "yamanote", painted.legs);
    const features = map.sourceFeatures(LINE_FOCUS_SOURCE_ID);
    expect(features.length).toBe(painted.legs.length);
    expect(features.length).toBeGreaterThan(0);
    /* The legs the source received still span all three
       formal lines — and every one carries the green. */
    const keys = new Set(features.map((f) => f.properties.key));
    expect(keys.has("東北線|東日本旅客鉄道")).toBe(true);
    expect(keys.has("東海道線|東日本旅客鉄道")).toBe(true);
    for (const feature of features) {
      expect(feature.properties.color).toBe(GREEN);
    }
  });

  test("unridden focus: setUnriddenRemainderFocus hands the remainder source unified-green features", () => {
    /* West-side-only ride: the remainder is the loop's east
       side, again on all three keys. */
    const westOnly = computeRiddenLineCoverage(
      [yamanoteRow([section(S.新宿.id, S.大崎.id, "inner")])],
      GEOMETRIES,
      597,
    );
    const remainder = westOnly.perServiceUnriddenLegs.get("yamanote")!;
    expect(remainder.length).toBeGreaterThan(0);
    const remainderKeys = [...new Set(remainder.map((leg) => leg.key))];
    expect(remainderKeys).toContain("東北線|東日本旅客鉄道");
    expect(remainderKeys).toContain("東海道線|東日本旅客鉄道");

    const map = new MockMap();
    setUnriddenRemainderFocus(
      asMap(map),
      remainderKeys,
      remainder,
      "yamanote",
      null,
    );
    const features = map.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID);
    expect(features.length).toBe(remainder.length);
    for (const feature of features) {
      expect(feature.properties.color).toBe(GREEN);
      expect(feature.properties.color).not.toBe(TOHOKU_BLUE);
      expect(feature.properties.color).not.toBe(TOKAIDO_ORANGE);
    }
  });

  test("unridden focus: a line selection before the ghost lands starts visible on the 路線 tab (1648 review, minor, fix3)", () => {
    /* Codex's case (review of 1648, minor): the 1648 tests drove
       setUnriddenRemainderFocus directly, so dropping the variant
       on the selection path — App.tsx's four
       setUnriddenRemainderFocus calls — passed all of them while
       a filled layer stayed invisible until the next tab switch.
       The selection assemblies moved to line-map-focus.ts in
       fix3 (App.tsx cannot be imported by the tests — it pulls
       the generated ghost-worker asset), and this test drives
       them from an actual line selection, on a map the ghost has
       not reached: the layer must be created at the current tab's
       visibility, and the source must already hold the
       remainder's features. The variant is REQUIRED on the
       assemblies, so dropping it at an App.tsx call site is a
       type error; the dropped calls below (an explicit undefined
       cast) pin the runtime half — the stranded layer the fault
       would leave behind. */
    const sections = [section(S.新宿.id, S.大崎.id, "inner")];
    const westOnly = computeRiddenLineCoverage(
      [yamanoteRow(sections)],
      GEOMETRIES,
      597,
    );
    const row = yamanoteRow(sections);
    const painted = westOnly.perServiceLegs.get("yamanote")!;
    const remainder = westOnly.perServiceUnriddenLegs.get("yamanote")!;
    expect(remainder.length).toBeGreaterThan(0);
    /* The ghost has not landed: no features, no coverage key —
       exactly what App.tsx's remainderGhostContext hands over
       before the worker answers. */
    const ghostNotLanded: Omit<RemainderGhostContext, "spans"> = {
      features: [],
      coverageKey: null,
      coverage: westOnly,
    };
    const layerVisibility = (map: MockMap) =>
      (
        map.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)!
          .layout as Record<string, unknown>
      ).visibility;

    /* A row tap on the 路線 tab: visible at once, source
       filled with the whole remainder, no ghost joined. */
    const map = new MockMap();
    applySelectedLineRemainderFocus(
      asMap(map),
      row,
      painted,
      westOnly,
      "yamanote",
      ghostNotLanded,
      "lines",
    );
    expect(map.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)).toBeDefined();
    expect(layerVisibility(map)).toBe("visible");
    const features = map.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID);
    expect(features.length).toBe(remainder.length);
    for (const feature of features) {
      expect(feature.properties.color).toBe(GREEN);
    }
    expect(map.sources.get("unridden-lines")).toBeUndefined();
    expect(map.layers.get("unridden-lines-ghost")).toBeUndefined();

    /* Off the 路線 tab the same selection still fills the
       source, but the layer starts hidden. */
    const offTab = new MockMap();
    applySelectedLineRemainderFocus(
      asMap(offTab),
      row,
      painted,
      westOnly,
      "yamanote",
      ghostNotLanded,
      "spots",
    );
    expect(layerVisibility(offTab)).toBe("none");
    expect(offTab.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID).length).toBe(
      remainder.length,
    );

    /* And with the variant dropped — the pass-through fault —
       the layer strands at the spec's default "none" even
       though the tab is the 路線 tab. */
    const dropped = new MockMap();
    applySelectedLineRemainderFocus(
      asMap(dropped),
      row,
      painted,
      westOnly,
      "yamanote",
      ghostNotLanded,
      undefined as unknown as RecordMapVariant,
    );
    expect(layerVisibility(dropped)).toBe("none");

    /* The re-apply path (mount completion / ghost's late join)
       resolves the same selection from the ledger rows and the
       focused row id, and starts visible on the 路線 tab too. */
    const reapplyMap = new MockMap();
    reapplyUnriddenRemainderFocus(
      asMap(reapplyMap),
      [{ ...row, id: 1 }],
      westOnly,
      1,
      ghostNotLanded,
      "lines",
    );
    expect(layerVisibility(reapplyMap)).toBe("visible");
    expect(
      reapplyMap.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID).length,
    ).toBe(remainder.length);

    /* With the variant dropped on the re-apply path, the same
       stranded layer. */
    const reapplyDropped = new MockMap();
    reapplyUnriddenRemainderFocus(
      asMap(reapplyDropped),
      [{ ...row, id: 1 }],
      westOnly,
      1,
      ghostNotLanded,
      undefined as unknown as RecordMapVariant,
    );
    expect(layerVisibility(reapplyDropped)).toBe("none");

    /* No applicable selection (nothing focused): the re-apply
       leaves the layers as they are — no layer is created. */
    const noSelection = new MockMap();
    reapplyUnriddenRemainderFocus(
      asMap(noSelection),
      [{ ...row, id: 1 }],
      westOnly,
      null,
      ghostNotLanded,
      "lines",
    );
    expect(noSelection.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)).toBeUndefined();
    expect(
      noSelection.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID).length,
    ).toBe(0);
  });

  test("control: a non-unified service keeps its own formal-line color on all three paths", () => {
    const chuoKey = "中央線|東日本旅客鉄道";
    const chuoColor = GEOMETRIES[chuoKey]!.color;
    expect(chuoColor).toBe(TOKAIDO_ORANGE);
    expect(chuoColor).not.toBe(GREEN);
    const chuoLeg: PathLeg = {
      key: chuoKey,
      edge: "edge:control",
      fromT: 0,
      toT: 1,
      coords: [
        [139.7, 35.6],
        [139.71, 35.61],
      ],
      lengthKm: 1,
    };

    const normalOverlay = visitedLinesOverlay(
      new Map([["jr-chuo-rapid", { legs: [chuoLeg], unknown: false }]]),
      GEOMETRIES,
    );
    expect(normalOverlay).not.toBeNull();
    const normal = normalOverlay!.data.features;
    expect(normal).toHaveLength(1);
    expect(normal[0]!.properties.color).toBe(chuoColor);

    const focusMap = new MockMap();
    setFocusSection(asMap(focusMap), "jr-chuo-rapid", [chuoLeg]);
    const focusFeatures = focusMap.sourceFeatures(LINE_FOCUS_SOURCE_ID);
    expect(focusFeatures).toHaveLength(1);
    expect(focusFeatures[0]!.properties.color).toBe(chuoColor);

    const remainderMap = new MockMap();
    setUnriddenRemainderFocus(
      asMap(remainderMap),
      [chuoKey],
      [chuoLeg],
      "jr-chuo-rapid",
      null,
    );
    const remainderFeatures = remainderMap.sourceFeatures(
      UNRIDDEN_FOCUS_SOURCE_ID,
    );
    expect(remainderFeatures).toHaveLength(1);
    expect(remainderFeatures[0]!.properties.color).toBe(chuoColor);
  });

  test("unridden-line focus (subtask 1623): a fully unridden line paints its whole remainder at its own color, and the ghost loses exactly that line", () => {
    /* West-side-only 山手線 ride: 中央線 has no painted leg
       anywhere, so its remainder is the whole line. */
    const westOnly = computeRiddenLineCoverage(
      [yamanoteRow([section(S.新宿.id, S.大崎.id, "inner")])],
      GEOMETRIES,
      597,
    );
    const chuoKey = "中央線|東日本旅客鉄道";
    const legs = ghostLegsForKey(westOnly, GEOMETRIES, chuoKey);
    expect(legs.length).toBeGreaterThan(0);
    /* The ghost as the worker would deliver it for this
       coverage, already joined on the map — the trim writes
       back into this source. */
    const wire = serializeGhostCoverage(westOnly);
    const ghostFeatures = computeUnriddenGhostFeatures(wire, GEOMETRIES);
    expect(
      ghostFeatures.some((f) => f.properties.key === chuoKey),
    ).toBe(true);
    const ghost: Omit<RemainderGhostContext, "spans"> = {
      features: ghostFeatures,
      coverageKey: ghostCoverageKey(wire),
      coverage: westOnly,
    };
    const map = new MockMap();
    map.addSource(UNRIDDEN_LINES_SOURCE_ID, {
      type: "geojson",
      data: { type: "FeatureCollection", features: ghostFeatures },
    });
    expect(
      applyUnriddenLineFocus(asMap(map), chuoKey, legs, ghost, "lines"),
    ).toBe(true);
    /* The focus layer starts visible on the 路線 tab, and its
       source holds the whole line in the line's own orange —
       the midway paint, never a recolor. */
    expect(
      (
        map.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)!
          .layout as Record<string, unknown>
      ).visibility,
    ).toBe("visible");
    const features = map.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID);
    expect(features.length).toBe(legs.length);
    for (const feature of features) {
      expect(feature.properties.key).toBe(chuoKey);
      expect(feature.properties.color).toBe(TOKAIDO_ORANGE);
    }
    /* The ghost trimmed exactly that line out — every other
       unridden line stays in the ghost. */
    const ghostAfter = map.sourceFeatures(UNRIDDEN_LINES_SOURCE_ID);
    expect(
      ghostAfter.some((f) => f.properties.key === chuoKey),
    ).toBe(false);
    expect(ghostAfter.length).toBe(ghostFeatures.length - 1);
  });

  test("unridden-line focus (subtask 1623): no remainder left means the call is a no-op", () => {
    /* A full ride still leaves slivers of its formal lines'
       asset shapes unpainted (parallel strands the service
       path never uses), so a "fully ridden" key is not the
       way to reach an empty remainder — the contract under
       test is the empty-legs guard itself: no legs, no
       layer, no paint, false. */
    const full = computeRiddenLineCoverage(
      [{ ...yamanoteRow([]), rideState: "full" as const }],
      GEOMETRIES,
      597,
    );
    expect(full.perServiceLegs.get("yamanote")).toBeDefined();
    const map = new MockMap();
    const ghost: Omit<RemainderGhostContext, "spans"> = {
      features: [],
      coverageKey: null,
      coverage: full,
    };
    expect(
      applyUnriddenLineFocus(
        asMap(map),
        "山手線|東日本旅客鉄道",
        [],
        ghost,
        "lines",
      ),
    ).toBe(false);
    expect(map.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)).toBeUndefined();
    expect(map.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID)).toHaveLength(0);
  });

  test("clearing the focus empties the focus source again", () => {
    const coverage = yamanoteCoverage();
    const painted = coverage.perServiceLegs.get("yamanote")!;
    const map = new MockMap();
    setFocusSection(asMap(map), "yamanote", painted.legs);
    expect(map.sourceFeatures(LINE_FOCUS_SOURCE_ID).length).toBeGreaterThan(0);
    clearFocusLineGeometry(asMap(map), null);
    expect(map.sourceFeatures(LINE_FOCUS_SOURCE_ID)).toHaveLength(0);
    expect(map.sourceFeatures(UNRIDDEN_FOCUS_SOURCE_ID)).toHaveLength(0);
  });
});
