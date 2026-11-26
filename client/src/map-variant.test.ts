/* Tests for the record map's tab-split decisions (subtask 1439):
   the hero / ghost paint split per variant, and the map line
   tap's painted-key → ledger-row resolution. Subtask 1440 adds
   the municipality tap's painted-name → ledger-row resolution
   and the sticky map pane's visible-range bound.
   Run with: bun test client/src/map-variant.test.ts */
import { describe, expect, test } from "bun:test";
import {
  applyUnriddenLineGhostLatest,
  applyVariantPaint,
  decideSpotDataRemount,
  ensureUnriddenLineGhost,
  GHOST_SPOT_PAINT,
  lineRowForPaintedFeature,
  lineRowForPaintedKey,
  mapPaneBlockRendered,
  municipalityRowForPaintedName,
  shouldMountLiveMap,
  shouldSkipSpotRemount,
  spotsInitialCamera,
  stickyPaneVisibleTop,
  UNRIDDEN_LINES_FOCUS_LAYER_ID,
  UNRIDDEN_LINES_LAYER_ID,
  UNRIDDEN_LINES_SOURCE_ID,
  unriddenRemainderKeysForRow,
  unriddenRemainderKeysForSelection,
  variantPaintOps,
  type MapMountKeys,
  type UnriddenGhostResult,
  type UnriddenLineFeature,
} from "./map-variant";

const paintValue = (
  variant: "spots" | "municipalities" | "lines",
  layer: string,
  name: string,
) =>
  variantPaintOps(variant).paint.find(
    (op) => op.layer === layer && op.name === name,
  )?.value;
const layoutValue = (
  variant: "spots" | "municipalities" | "lines",
  layer: string,
  name: string,
) =>
  variantPaintOps(variant).layout.find(
    (op) => op.layer === layer && op.name === name,
  )?.value;

describe("variantPaintOps", () => {
  test("the ridden lines are the hero on the 路線 tab, the ghost on the 市区町村 tab", () => {
    /* Hero = the mount spec in App.tsx (casing 0.55 / 5.5, color
       0.95 / 3.5, unknown 0.25 — the unridden ghost's strength,
       since an unknown ride paints in the unridden look). On the
       市区町村 tab the lines are the other tab's data, so they
       drop to ghost strength — present as an underlay, never
       competing with the fills. */
    expect(paintValue("lines", "visited-lines-color", "line-opacity")).toBe(0.95);
    expect(paintValue("lines", "visited-lines-color", "line-width")).toBe(3.5);
    expect(paintValue("lines", "visited-lines-casing", "line-opacity")).toBe(0.55);
    expect(paintValue("lines", "visited-lines-casing", "line-width")).toBe(5.5);
    expect(paintValue("lines", "visited-lines-unknown", "line-opacity")).toBe(0.25);
    expect(paintValue("municipalities", "visited-lines-color", "line-opacity")).toBe(0.32);
    expect(paintValue("municipalities", "visited-lines-color", "line-width")).toBe(2);
    expect(paintValue("municipalities", "visited-lines-casing", "line-opacity")).toBe(0.15);
    expect(paintValue("municipalities", "visited-lines-casing", "line-width")).toBe(3);
    expect(paintValue("municipalities", "visited-lines-unknown", "line-opacity")).toBe(0.15);
  });

  test("municipalities are the hero on their tab and the ghost on the 路線 tab", () => {
    expect(paintValue("municipalities", "visited-areas-fill", "fill-opacity")).toBe(0.38);
    expect(paintValue("lines", "visited-areas-fill", "fill-opacity")).toBe(0.1);
    expect(paintValue("municipalities", "visited-fill-circle", "circle-opacity")).toBe(0.22);
    expect(paintValue("lines", "visited-fill-circle", "circle-opacity")).toBe(0.07);
    expect(paintValue("municipalities", "visited-fill-circle", "circle-stroke-opacity")).toBe(0.5);
    expect(paintValue("lines", "visited-fill-circle", "circle-stroke-opacity")).toBe(0.18);
    /* The outline zoom ramp flattens with the ghost. */
    expect(
      paintValue("lines", "visited-areas-outline", "line-opacity"),
    ).toEqual(["interpolate", ["linear"], ["zoom"], 7, 0.22, 10, 0.32]);
    expect(
      paintValue("municipalities", "visited-areas-outline", "line-opacity"),
    ).toEqual(["interpolate", ["linear"], ["zoom"], 7, 0.7, 10, 0.9]);
  });

  test("the unridden-line ghost shows only on the 路線 tab", () => {
    expect(layoutValue("lines", "unridden-lines-ghost", "visibility")).toBe("visible");
    expect(layoutValue("municipalities", "unridden-lines-ghost", "visibility")).toBe("none");
    expect(layoutValue("spots", "unridden-lines-ghost", "visibility")).toBe("none");
  });

  test("the focused line's unridden remainder rides the ghost's tab rule (subtask 1589)", () => {
    expect(layoutValue("lines", "unridden-lines-focus", "visibility")).toBe("visible");
    expect(layoutValue("municipalities", "unridden-lines-focus", "visibility")).toBe("none");
    expect(layoutValue("spots", "unridden-lines-focus", "visibility")).toBe("none");
  });

  test("the spot dots are the hero only on the スポット tab (unification, subtask 1460)", () => {
    /* Hero = the mount spec in App.tsx (circle-opacity 0.6).
       On the record tabs the hero dots are hidden outright: the
       ghost-spots layer already carries the unvisited dots there,
       and showing both would paint every unvisited spot twice. */
    expect(paintValue("spots", "list-spot-points-circle", "circle-opacity")).toBe(0.6);
    expect(layoutValue("spots", "list-spot-points-circle", "visibility")).toBe("visible");
    expect(layoutValue("municipalities", "list-spot-points-circle", "visibility")).toBe("none");
    expect(layoutValue("lines", "list-spot-points-circle", "visibility")).toBe("none");
    /* The ghost-spots underlay is the mirror: visible on the
       record tabs, hidden on the スポット tab where the hero
       dots show the same unvisited spots. */
    expect(layoutValue("spots", "ghost-spots-circle", "visibility")).toBe("none");
    expect(layoutValue("municipalities", "ghost-spots-circle", "visibility")).toBe("visible");
    expect(layoutValue("lines", "ghost-spots-circle", "visibility")).toBe("visible");
  });

  test("on the スポット tab the municipality fills and the ridden lines are both ghosts", () => {
    expect(paintValue("spots", "visited-areas-fill", "fill-opacity")).toBe(0.1);
    expect(paintValue("spots", "visited-fill-circle", "circle-opacity")).toBe(0.07);
    expect(paintValue("spots", "visited-lines-color", "line-opacity")).toBe(0.32);
    expect(paintValue("spots", "visited-lines-color", "line-width")).toBe(2);
    expect(paintValue("spots", "visited-lines-casing", "line-opacity")).toBe(0.15);
    expect(paintValue("spots", "visited-lines-unknown", "line-opacity")).toBe(0.15);
    expect(
      paintValue("spots", "visited-areas-outline", "line-opacity"),
    ).toEqual(["interpolate", ["linear"], ["zoom"], 7, 0.22, 10, 0.32]);
  });

  test("every op targets a layer the unified map actually mounts", () => {
    /* Layer ids as mounted in App.tsx. A typo here would
       silently no-op through applyVariantPaint's missing-layer
       skip, so pin the op set to the mounted set. The
       ghost-spots layer is added at runtime by
       ensureGhostSpotPoints, not by the mount overlays, but it
       is a real layer on the live map all the same. */
    const mounted = new Set([
      "visited-areas-fill",
      "visited-areas-hit",
      "visited-areas-outline",
      "visited-fill-circle",
      "visited-fill-hit",
      "designated-city-wards-unvisited-outline",
      "designated-city-wards-visited-outline",
      "unvisited-areas-outline",
      "visited-lines-casing",
      "visited-lines-color",
      "visited-lines-unknown",
      "unridden-lines-ghost",
      "unridden-lines-focus",
      "list-spot-points-circle",
      "ghost-spots-circle",
    ]);
    for (const variant of ["spots", "municipalities", "lines"] as const) {
      const ops = variantPaintOps(variant);
      for (const op of [...ops.paint, ...ops.layout]) {
        expect(mounted.has(op.layer)).toBe(true);
      }
    }
  });
});

describe("ensureUnriddenLineGhost (the ghost joins the map late, review round 2)", () => {
  /* A fake map with just the surface the ensure + the variant
     paint use: sources that remember their data, layers that
     remember their spec, insertion anchor, and layout props. */
  function fakeMap(existingLayers: string[] = []) {
    const sources = new Map<string, { data: unknown }>();
    const layers = new Map<
      string,
      { spec: Record<string, unknown>; beforeId?: string }
    >();
    for (const id of existingLayers) layers.set(id, { spec: { id } });
    return {
      sources,
      layers,
      getSource: (id: string) => {
        const s = sources.get(id);
        return s ? { setData: (data: unknown) => (s.data = data) } : undefined;
      },
      addSource: (id: string, source: Record<string, unknown>) => {
        sources.set(id, { data: source.data });
      },
      addLayer: (layer: Record<string, unknown>, beforeId?: string) => {
        layers.set(layer.id as string, { spec: layer, beforeId });
      },
      getLayer: (id: string) => layers.get(id),
      setPaintProperty: () => {},
      setLayoutProperty: (id: string, name: string, value: unknown) => {
        const l = layers.get(id);
        if (!l) return;
        const layout = (l.spec.layout ?? {}) as Record<string, unknown>;
        layout[name] = value;
        l.spec.layout = layout;
      },
    };
  }

  const feature = (key: string): UnriddenLineFeature => ({
    type: "Feature",
    properties: { key, color: "#123456" },
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [139.0, 35.0],
          [139.01, 35.0],
        ],
      ],
    },
  });

  test("a first arrival adds the source and the mount's layer, below the ridden lines", () => {
    const map = fakeMap(["visited-lines-casing", "visited-lines-color"]);
    ensureUnriddenLineGhost(map, [feature("山手線|東日本旅客鉄道")]);
    const added = map.layers.get(UNRIDDEN_LINES_LAYER_ID);
    expect(added).toBeDefined();
    /* The mount overlay's spec, verbatim: the late layer must
       be indistinguishable from a mounted one. */
    expect(added!.spec).toEqual({
      id: "unridden-lines-ghost",
      type: "line",
      source: "unridden-lines",
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      paint: { "line-color": ["get", "color"], "line-width": 1.6, "line-opacity": 0.25 },
    });
    /* Paint order: directly below the ridden lines, as the
       mount's sort places the family. */
    expect(added!.beforeId).toBe("visited-lines-casing");
    const data = map.sources.get(UNRIDDEN_LINES_SOURCE_ID)!.data as {
      features: unknown[];
    };
    expect(data.features).toHaveLength(1);
  });

  test("the focused line's remainder layer joins with the family (subtask 1589)", () => {
    const map = fakeMap(["visited-lines-casing", "visited-lines-color"]);
    ensureUnriddenLineGhost(map, [feature("山手線|東日本旅客鉄道")]);
    const focus = map.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID);
    expect(focus).toBeDefined();
    /* The shared spec from map-variant.ts — the same object
       App.tsx's mount overlay carries: midway paint (2.4 /
       0.5, between the ghost's 1.6 / 0.25 and a ridden
       section's 3.5 / 0.95), the line's own color, and an
       empty-key filter that paints nothing until a focus call
       selects a line. */
    expect(focus!.spec).toEqual({
      id: "unridden-lines-focus",
      type: "line",
      source: "unridden-lines",
      layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
      filter: ["in", ["get", "key"], ["literal", []]],
      paint: { "line-color": ["get", "color"], "line-width": 2.4, "line-opacity": 0.5 },
    });
    /* Above the ghost, below the ridden lines: the same
       insertion anchor as the ghost layer. */
    expect(focus!.beforeId).toBe("visited-lines-casing");
    /* A refresh never re-adds either layer (the count stays at
       the two seeded layers plus the family's two). */
    ensureUnriddenLineGhost(map, [feature("a|b"), feature("c|d")]);
    expect(map.layers.size).toBe(4);
  });

  test("an existing source is refreshed in place, never re-added", () => {
    const map = fakeMap([]);
    ensureUnriddenLineGhost(map, [feature("a|b")]);
    ensureUnriddenLineGhost(map, [feature("a|b"), feature("c|d")]);
    const data = map.sources.get(UNRIDDEN_LINES_SOURCE_ID)!.data as {
      features: unknown[];
    };
    expect(data.features).toHaveLength(2);
    /* The ghost layer and the remainder layer (subtask 1589). */
    expect(map.layers.size).toBe(2);
  });

  test("no features and no source: nothing joins yet", () => {
    const map = fakeMap([]);
    ensureUnriddenLineGhost(map, []);
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
  });

  test("after the join, the variant paint shows the ghost only on the 路線 tab", () => {
    /* The App.tsx sequence: ensure, then applyVariantPaint with
       the current variant — the same order the mount callback
       uses. A layer joining while the reader is on the 路線 tab
       must arrive visible; on any other tab it stays hidden. */
    const onLines = fakeMap(["visited-lines-casing"]);
    ensureUnriddenLineGhost(onLines, [feature("a|b")]);
    applyVariantPaint(onLines, "lines");
    const layout = onLines.layers.get(UNRIDDEN_LINES_LAYER_ID)!.spec
      .layout as Record<string, unknown>;
    expect(layout.visibility).toBe("visible");
    /* The remainder layer follows the same rule (subtask 1589). */
    const focusLayout = onLines.layers.get(UNRIDDEN_LINES_FOCUS_LAYER_ID)!
      .spec.layout as Record<string, unknown>;
    expect(focusLayout.visibility).toBe("visible");

    const onMunicipalities = fakeMap(["visited-lines-casing"]);
    ensureUnriddenLineGhost(onMunicipalities, [feature("a|b")]);
    applyVariantPaint(onMunicipalities, "municipalities");
    const layout2 = onMunicipalities.layers.get(UNRIDDEN_LINES_LAYER_ID)!
      .spec.layout as Record<string, unknown>;
    expect(layout2.visibility).toBe("none");
    const focusLayout2 = onMunicipalities.layers.get(
      UNRIDDEN_LINES_FOCUS_LAYER_ID,
    )!.spec.layout as Record<string, unknown>;
    expect(focusLayout2.visibility).toBe("none");
  });

  test("the insertion anchor falls back past the spot dots, then to the top", () => {
    const dotsOnly = fakeMap(["list-spot-points-circle"]);
    ensureUnriddenLineGhost(dotsOnly, [feature("a|b")]);
    expect(
      dotsOnly.layers.get(UNRIDDEN_LINES_LAYER_ID)!.beforeId,
    ).toBe("list-spot-points-circle");
    const bare = fakeMap([]);
    ensureUnriddenLineGhost(bare, [feature("a|b")]);
    expect(
      bare.layers.get(UNRIDDEN_LINES_LAYER_ID)!.beforeId,
    ).toBeUndefined();
  });
});

describe("applyUnriddenLineGhostLatest (a late waiter must not wipe the ghost, review round 3)", () => {
  /* The same fake-map surface as the ensure tests above. */
  function fakeMap(existingLayers: string[] = []) {
    const sources = new Map<string, { data: unknown }>();
    const layers = new Map<string, { spec: Record<string, unknown> }>();
    for (const id of existingLayers) layers.set(id, { spec: { id } });
    return {
      sources,
      layers,
      getSource: (id: string) => {
        const s = sources.get(id);
        return s ? { setData: (data: unknown) => (s.data = data) } : undefined;
      },
      addSource: (id: string, source: Record<string, unknown>) => {
        sources.set(id, { data: source.data });
      },
      addLayer: (layer: Record<string, unknown>) => {
        layers.set(layer.id as string, { spec: layer });
      },
      getLayer: (id: string) => layers.get(id),
    };
  }

  const feature = (key: string): UnriddenLineFeature => ({
    type: "Feature",
    properties: { key, color: "#123456" },
    geometry: {
      type: "MultiLineString",
      coordinates: [
        [
          [139.0, 35.0],
          [139.01, 35.0],
        ],
      ],
    },
  });

  const sourceFeatures = (
    map: ReturnType<typeof fakeMap>,
  ): UnriddenLineFeature[] =>
    (
      map.sources.get(UNRIDDEN_LINES_SOURCE_ID)?.data as {
        features: UnriddenLineFeature[];
      }
    )?.features ?? [];

  test("the reversed order the review reproduced: a waiter registered with the empty ghost fires after the real one landed — the ghost survives", () => {
    const KEY = "ledger-1";
    const map = fakeMap(["visited-lines-casing"]);
    /* The App.tsx pattern after the fix: the result lives in a
       ref-shaped box, and a waiter reads the box when it FIRES,
       never the value from when it was registered. */
    const latest: { current: UnriddenGhostResult | null } = {
      current: { coverageKey: KEY, features: [] },
    };
    const waiters: (() => void)[] = [];
    const registerWaiter = () =>
      waiters.push(() =>
        applyUnriddenLineGhostLatest(map, latest.current, KEY),
      );
    /* 1. The data effect runs while the ghost is still empty
       and the map is not ready: its waiter stays registered. */
    registerWaiter();
    /* 2. The worker's result lands; the next effect run applies
       it at once (the map is ready by now). */
    latest.current = { coverageKey: KEY, features: [feature("a|b")] };
    expect(applyUnriddenLineGhostLatest(map, latest.current, KEY)).toBe(true);
    expect(sourceFeatures(map)).toHaveLength(1);
    /* The layer is up and — with the variant paint the effect
       runs right after — visible on the 路線 tab. */
    expect(map.layers.has(UNRIDDEN_LINES_LAYER_ID)).toBe(true);
    /* 3. The stale waiter from step 1 finally fires. Reading
       the latest result, it re-applies the REAL ghost; with
       the round-2 capture it applied the empty array it was
       registered with and the source went empty under a
       visible layer. */
    for (const fire of waiters) fire();
    expect(sourceFeatures(map)).toHaveLength(1);
    expect(sourceFeatures(map)[0]!.properties.key).toBe("a|b");
  });

  test("a result whose ledger has moved on is refused — it neither overwrites nor wipes", () => {
    const map = fakeMap(["visited-lines-casing"]);
    expect(
      applyUnriddenLineGhostLatest(
        map,
        { coverageKey: "k1", features: [feature("a|b")] },
        "k1",
      ),
    ).toBe(true);
    expect(sourceFeatures(map)).toHaveLength(1);
    /* The ledger is at k2 now. A late path carrying k1's (even
       emptier) result must leave the map exactly as it is; the
       k2 result joins through its own effect run. */
    expect(
      applyUnriddenLineGhostLatest(
        map,
        { coverageKey: "k1", features: [] },
        "k2",
      ),
    ).toBe(false);
    expect(sourceFeatures(map)).toHaveLength(1);
    expect(
      applyUnriddenLineGhostLatest(map, null, "k2"),
    ).toBe(false);
    expect(sourceFeatures(map)).toHaveLength(1);
    /* And the current ledger's result applies normally. */
    expect(
      applyUnriddenLineGhostLatest(
        map,
        { coverageKey: "k2", features: [feature("a|b"), feature("c|d")] },
        "k2",
      ),
    ).toBe(true);
    expect(sourceFeatures(map)).toHaveLength(2);
  });
});

describe("unriddenRemainderKeysForRow (the remainder decision reads the ROW's own rideState, review batch round 1, finding 4)", () => {
  /* むさしの号's painted legs: two formal lines, one of them
     painted by two legs — the keys come back deduped. */
  const painted = {
    legs: [
      { key: "武蔵野線|東日本旅客鉄道" },
      { key: "武蔵野線|東日本旅客鉄道" },
      { key: "東北線|東日本旅客鉄道" },
    ],
    unknown: false,
  };

  test("a partial row singles out its service's formal-line keys, deduped", () => {
    expect(
      unriddenRemainderKeysForRow({ rideState: "partial" }, painted),
    ).toEqual(["武蔵野線|東日本旅客鉄道", "東北線|東日本旅客鉄道"]);
  });

  test("a full row keeps the keys, as subtask 1589 painted them", () => {
    expect(
      unriddenRemainderKeysForRow({ rideState: "full" }, painted),
    ).toEqual(["武蔵野線|東日本旅客鉄道", "東北線|東日本旅客鉄道"]);
  });

  test("an unknown row gets NO remainder even when a sibling row made the service aggregate known — the finding's case", () => {
    /* 「JRむさしの号」 (unknown) and 「むさしの号」 (partial) share
       the jr-musashino-omiya service; the partial row's sections
       make the aggregate's unknown flag false. Selecting the
       unknown row must not single out a remainder: it recorded
       no section, so there is nothing ridden for a remainder
       to be the remainder OF. Deciding from the aggregate
       alone painted the emphasis on the unknown row. */
    expect(
      unriddenRemainderKeysForRow({ rideState: "unknown" }, painted),
    ).toEqual([]);
  });

  test("a service-level unknown singles out nothing, whatever the row says", () => {
    expect(
      unriddenRemainderKeysForRow(
        { rideState: "partial" },
        { legs: painted.legs, unknown: true },
      ),
    ).toEqual([]);
  });

  test("no painted legs — nothing to single out", () => {
    expect(
      unriddenRemainderKeysForRow({ rideState: "partial" }, undefined),
    ).toEqual([]);
    expect(
      unriddenRemainderKeysForRow(
        { rideState: "partial" },
        { legs: [], unknown: false },
      ),
    ).toEqual([]);
  });
});

describe("unriddenRemainderKeysForSelection (the mount / ghost-late-join re-apply, review batch round 1, finding 3)", () => {
  /* The finding-4 ledger: two rows on the SAME service, one
     partial and one unknown. The re-apply resolves the CURRENT
     selection from the rows + coverage, as App.tsx's refs hand
     them over at mount / ghost-landing time. */
  const rows = [
    {
      id: 21,
      name: "むさしの号",
      serviceId: "jr-musashino-omiya",
      serviceLinkSource: "explicit" as const,
      rideState: "partial" as const,
    },
    {
      id: 22,
      name: "JRむさしの号",
      serviceId: "jr-musashino-omiya",
      serviceLinkSource: "explicit" as const,
      rideState: "unknown" as const,
    },
  ];
  const perServiceLegs = new Map([
    [
      "jr-musashino-omiya",
      {
        legs: [
          { key: "武蔵野線|東日本旅客鉄道" },
          { key: "東北線|東日本旅客鉄道" },
        ],
        unknown: false,
      },
    ],
  ]);

  test("no focus — null: leave the layers as they are", () => {
    expect(unriddenRemainderKeysForSelection(rows, perServiceLegs, null)).toBeNull();
  });

  test("the focused partial row's keys are what a rebuilt map re-applies", () => {
    expect(unriddenRemainderKeysForSelection(rows, perServiceLegs, 21)).toEqual([
      "武蔵野線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
    ]);
  });

  test("the focused UNKNOWN alias row resolves to an empty list — a decision to clear, not null", () => {
    /* Null would leave a previous selection's emphasis on the
       rebuilt layers; the unknown row's answer is an explicit
       empty selection. */
    expect(unriddenRemainderKeysForSelection(rows, perServiceLegs, 22)).toEqual([]);
  });

  test("a focused row that left the ledger, or whose service paints nothing, leaves the layers alone", () => {
    expect(unriddenRemainderKeysForSelection(rows, perServiceLegs, 99)).toBeNull();
    expect(unriddenRemainderKeysForSelection(rows, new Map(), 21)).toBeNull();
  });

  test("a focused row with an unusable link leaves the layers alone", () => {
    const unlinked = [
      {
        id: 23,
        name: "むさしの号",
        serviceId: null,
        serviceLinkSource: "explicit" as const,
        rideState: "partial" as const,
      },
    ];
    expect(
      unriddenRemainderKeysForSelection(unlinked, perServiceLegs, 23),
    ).toBeNull();
  });
});

describe("ghostSpotPaint (the unvisited-spot underlay, subtask 1481)", () => {
  test("the ghost dots stay a faint underlay, well below the hero dots", () => {
    /* Hero = the mount spec in App.tsx (circle-opacity 0.6,
       radius 3.5 at zoom 3 → 6 at zoom 14, no stroke). The
       reader found the old ghost (0.32, radius 2.5–4.5, 1px
       stroke at 0.4) too loud on the record tabs, so the ghost
       now sits at about a quarter of the hero's strength — in
       line with the other ghost families — and shrinks, with
       the stroke thinned to a whisper. The hue stays #ea580c
       so the dots still read as the same data. */
    expect(GHOST_SPOT_PAINT["circle-color"]).toBe("#ea580c");
    expect(GHOST_SPOT_PAINT["circle-opacity"]).toBe(0.16);
    expect(GHOST_SPOT_PAINT["circle-radius"]).toEqual([
      "interpolate", ["linear"], ["zoom"], 3, 2, 10, 2.5, 14, 3,
    ]);
    expect(GHOST_SPOT_PAINT["circle-stroke-width"]).toBe(0.5);
    expect(GHOST_SPOT_PAINT["circle-stroke-color"]).toBe("#ea580c");
    expect(GHOST_SPOT_PAINT["circle-stroke-opacity"]).toBe(0.15);
    /* Guardrails, not just pinned numbers: a future edit that
       creeps the ghost back toward hero strength fails here. */
    expect(GHOST_SPOT_PAINT["circle-opacity"] as number).toBeLessThan(0.6 / 2);
    expect(GHOST_SPOT_PAINT["circle-stroke-opacity"] as number).toBeLessThan(
      0.2,
    );  });
});

describe("lineRowForPaintedKey (map line tap → ledger row)", () => {
  const rows = [
    {
      id: 8,
      name: "JR埼京線",
      serviceId: "jr-saikyo",
      serviceLinkSource: "explicit" as const,
    },
    {
      id: 5,
      name: "JR総武快速線",
      serviceId: "jr-sobu-rapid",
      serviceLinkSource: "explicit" as const,
    },
  ];
  const perServiceLegs = new Map([
    [
      "jr-saikyo",
      {
        legs: [
          { key: "赤羽線|東日本旅客鉄道" },
          { key: "東北本線|東日本旅客鉄道" },
          { key: "川越線|東日本旅客鉄道" },
        ],
        unknown: false,
      },
    ],
    [
      "jr-sobu-rapid",
      { legs: [{ key: "総武線|東日本旅客鉄道" }], unknown: false },
    ],
  ]);

  test("a decomposed service's formal lines resolve to its row", () => {
    /* 埼京線 has no track of its own: its four formal lines are
       what the map paints, and a tap on any of them is a tap on
       the 埼京線 row. */
    expect(
      lineRowForPaintedKey(rows, perServiceLegs, "赤羽線|東日本旅客鉄道")?.id,
    ).toBe(8);
    expect(
      lineRowForPaintedKey(rows, perServiceLegs, "川越線|東日本旅客鉄道")?.id,
    ).toBe(8);
    expect(
      lineRowForPaintedKey(rows, perServiceLegs, "総武線|東日本旅客鉄道")?.id,
    ).toBe(5);
  });

  test("a key no usable service paints resolves to no row", () => {
    expect(
      lineRowForPaintedKey(rows, perServiceLegs, "山手線|東日本旅客鉄道"),
    ).toBeNull();
    expect(lineRowForPaintedKey([], perServiceLegs, "赤羽線|東日本旅客鉄道")).toBeNull();
  });

  test("a row whose link is pending review never claims a track", () => {
    /* The auto-linked 中央線（各駅停車） row (the existing
       line-focus fixture): its service paints 中央線， but until
       the link is confirmed the tap must not focus it. */
    const reviewRows = [
      { id: 11, name: "中央線（各駅停車）", serviceId: "jr-chuo-rapid" },
    ];
    const legs = new Map([
      [
        "jr-chuo-rapid",
        { legs: [{ key: "中央線|東日本旅客鉄道" }], unknown: false },
      ],
    ]);
    expect(
      lineRowForPaintedKey(reviewRows, legs, "中央線|東日本旅客鉄道"),
    ).toBeNull();
    /* The confirmed row for the same service does claim it. */
    const confirmed = [
      ...reviewRows,
      {
        id: 12,
        name: "JR中央線（快速）",
        serviceId: "jr-chuo-rapid",
        serviceLinkSource: "explicit" as const,
      },
    ];
    expect(
      lineRowForPaintedKey(confirmed, legs, "中央線|東日本旅客鉄道")?.id,
    ).toBe(12);
  });
});

describe("municipalityRowForPaintedName (map municipality tap → ledger row)", () => {
  const rows = [
    { id: 3, prefecture: "東京都", name: "府中市" },
    { id: 7, prefecture: "東京都", name: "調布市" },
    { id: 9, prefecture: "神奈川県", name: "川崎市" },
  ];

  test("a painted shape's name resolves to its ledger row", () => {
    /* The mount builds the hit-layer features with the name
       "${prefecture} ${name}" — that exact string is the key. */
    expect(municipalityRowForPaintedName(rows, "東京都 府中市")?.id).toBe(3);
    expect(municipalityRowForPaintedName(rows, "東京都 調布市")?.id).toBe(7);
    expect(municipalityRowForPaintedName(rows, "神奈川県 川崎市")?.id).toBe(9);
  });

  test("a painted name with no ledger row resolves to null", () => {
    /* An unvisited shape is not in the ledger: the caller falls
       back to the geometric lookup, which names it instead. */
    expect(municipalityRowForPaintedName(rows, "東京都 狛江市")).toBeNull();
    expect(municipalityRowForPaintedName([], "東京都 府中市")).toBeNull();
  });

  test("the prefecture is part of the key (same name, different prefecture)", () => {
    expect(municipalityRowForPaintedName(rows, "神奈川県 府中市")).toBeNull();
    expect(municipalityRowForPaintedName(rows, "府中市")).toBeNull();
  });
});

describe("stickyPaneVisibleTop (row scroll's visible range under the stuck map)", () => {
  /* A phone-ish viewport: 800 tall, the tab-bar allowance 96,
     so the raw visible range ends at 704. The stuck map pane
     (min(40dvh, 20rem)) reaches about 320 down. */
  test("a stuck pane bounds the visible top at its bottom edge", () => {
    expect(stickyPaneVisibleTop({ top: 0, bottom: 320 }, 800, 96)).toBe(320);
    /* The wrapper's padding leaves the container a few px below
       the very top while stuck — still stuck. */
    expect(stickyPaneVisibleTop({ top: 4, bottom: 324 }, 800, 96)).toBe(324);
  });

  test("a pane that has not reached the top yet imposes no bound", () => {
    /* Page at rest: the pane sits below the section's padding,
       its top well under the viewport top — rows above it are
       ordinary content, not hidden. */
    expect(stickyPaneVisibleTop({ top: 24, bottom: 344 }, 800, 96)).toBe(0);
  });

  test("no pane, or a pane scrolled fully past, imposes no bound", () => {
    expect(stickyPaneVisibleTop(null, 800, 96)).toBe(0);
    expect(stickyPaneVisibleTop({ top: -330, bottom: -10 }, 800, 96)).toBe(0);
  });

  test("the bound never inverts the visible range", () => {
    /* A pane bottom below the tab-bar allowance clamps to just
       above it, so top < bottom always holds. */
    expect(stickyPaneVisibleTop({ top: 0, bottom: 790 }, 800, 96)).toBe(703);
  });
});

describe("lineRowForPaintedFeature (map line tap → ledger row, by service)", () => {
  /* 総武快速線 and 総武本線 both paint the one formal line
     総武線： by key alone the tap always lands on whichever row
     sorts first (the reviewer's reproduction). The feature's
     serviceId tells them apart. */
  const rows = [
    {
      id: 5,
      name: "JR総武快速線",
      serviceId: "jr-sobu-rapid",
      serviceLinkSource: "explicit" as const,
    },
    {
      id: 6,
      name: "JR総武本線",
      serviceId: "jr-sobu-local",
      serviceLinkSource: "explicit" as const,
    },
  ];
  const perServiceLegs = new Map([
    [
      "jr-sobu-rapid",
      { legs: [{ key: "総武線|東日本旅客鉄道" }], unknown: false },
    ],
    [
      "jr-sobu-local",
      { legs: [{ key: "総武線|東日本旅客鉄道" }], unknown: false },
    ],
  ]);

  test("a tap on the 本線's track selects the 本線 row, not the first row on the shared key", () => {
    expect(
      lineRowForPaintedFeature(rows, perServiceLegs, {
        key: "総武線|東日本旅客鉄道",
        serviceId: "jr-sobu-local",
      })?.id,
    ).toBe(6);
    expect(
      lineRowForPaintedFeature(rows, perServiceLegs, {
        key: "総武線|東日本旅客鉄道",
        serviceId: "jr-sobu-rapid",
      })?.id,
    ).toBe(5);
  });

  test("a feature without a serviceId falls back to the key-only rule", () => {
    expect(
      lineRowForPaintedFeature(rows, perServiceLegs, {
        key: "総武線|東日本旅客鉄道",
        serviceId: null,
      })?.id,
    ).toBe(5);
  });

  test("a serviceId whose service does not paint the tapped key resolves to no row", () => {
    expect(
      lineRowForPaintedFeature(rows, perServiceLegs, {
        key: "中央線|東日本旅客鉄道",
        serviceId: "jr-sobu-local",
      }),
    ).toBeNull();
  });

  test("a serviceId with no row of its own never falls back to the other service on the shared key (round 2)", () => {
    /* The reviewer's shape: the feature carries 総武本線's
       serviceId, but the ledger and the painted legs hold only
       総武快速線. The key-only fallback would hand the tap to
       the 快速 row — the mix-up the serviceId exists to
       prevent — so the tap resolves to no row. */
    const rapidOnlyRows = [rows[0]!];
    const rapidOnlyLegs = new Map([
      [
        "jr-sobu-rapid",
        { legs: [{ key: "総武線|東日本旅客鉄道" }], unknown: false },
      ],
    ]);
    expect(
      lineRowForPaintedFeature(rapidOnlyRows, rapidOnlyLegs, {
        key: "総武線|東日本旅客鉄道",
        serviceId: "jr-sobu-local",
      }),
    ).toBeNull();
  });
});

describe("shouldMountLiveMap (the mount waits for something to show, round 2 high)", () => {
  test("the reviewer's order: boundaries settle first, the only ride arrives later", () => {
    /* 市区町村 0件 with the boundary data settled and no ride
       record yet: the container is not rendered, so mounting
       must not be attempted... */
    expect(shouldMountLiveMap(false, true, false)).toBe(false);
    /* ...and when the unlinked ride arrives and the frame
       appears, the mount runs. */
    expect(shouldMountLiveMap(false, true, true)).toBe(true);
  });

  test("an unsettled boundary set or a failed map never mounts", () => {
    expect(shouldMountLiveMap(false, false, true)).toBe(false);
    expect(shouldMountLiveMap(true, true, true)).toBe(false);
  });
});

describe("spotsInitialCamera (review round 1, finding 4)", () => {
  test("the whole-country center, with the narrow-pane zoom under 560px", () => {
    expect(spotsInitialCamera(0)).toEqual({
      center: { lat: 37.6, lng: 138.4 },
      zoom: 4.2,
    });
    expect(spotsInitialCamera(559)).toEqual({
      center: { lat: 37.6, lng: 138.4 },
      zoom: 3.2,
    });
    expect(spotsInitialCamera(560)).toEqual({
      center: { lat: 37.6, lng: 138.4 },
      zoom: 4.2,
    });
    expect(spotsInitialCamera(1200).zoom).toBe(4.2);
  });
});

describe("shouldSkipSpotRemount (review round 1, finding 5)", () => {
  const base: MapMountKeys = {
    placesKey: "1g,2g",
    riddenLinesKey: "[]",
    mapAttempt: 0,
    mapFailed: false,
    boundarySettled: true,
    showMapPane: true,
  };

  test("a record-data-only change on the スポット tab with a live map skips the rebuild", () => {
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g,2g,3g" },
        "spots",
        true,
      ),
    ).toBe(true);
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, riddenLinesKey: "[x]" },
        "spots",
        true,
      ),
    ).toBe(true);
  });

  test("anything else still mounts", () => {
    /* No previous mount: the first run mounts. */
    expect(shouldSkipSpotRemount(null, base, "spots", true)).toBe(false);
    /* No live map to keep: mount. */
    expect(
      shouldSkipSpotRemount(base, { ...base, placesKey: "1g" }, "spots", false),
    ).toBe(false);
    /* A record tab wants the fresh shapes: rebuild. */
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g" },
        "municipalities",
        true,
      ),
    ).toBe(false);
    /* A retry, a failure flip, the boundary set settling, or the
       pane appearing is never a record-only change. */
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g", mapAttempt: 1 },
        "spots",
        true,
      ),
    ).toBe(false);
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g", mapFailed: true },
        "spots",
        true,
      ),
    ).toBe(false);
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g", boundarySettled: false },
        "spots",
        true,
      ),
    ).toBe(false);
    expect(
      shouldSkipSpotRemount(
        base,
        { ...base, placesKey: "1g", showMapPane: false },
        "spots",
        true,
      ),
    ).toBe(false);
    /* Nothing changed at all: no skip decision is needed (the
       effect would not re-run), and the predicate says mount. */
    expect(shouldSkipSpotRemount(base, base, "spots", true)).toBe(false);
  });
});

describe("decideSpotDataRemount (review round 2, finding 5)", () => {
  const base: MapMountKeys = {
    placesKey: "1g,2g",
    riddenLinesKey: "[]",
    mapAttempt: 0,
    mapFailed: false,
    boundarySettled: true,
    showMapPane: true,
  };

  test("no previous mount, or no record-data change, means nothing to do", () => {
    /* The first run belongs to the mount effect, and a re-render
       alone must never bump the retry nonce — or the mount
       would rebuild in a loop. */
    expect(decideSpotDataRemount(null, base, "spots", true)).toBe("none");
    expect(decideSpotDataRemount(base, base, "spots", true)).toBe("none");
    expect(
      decideSpotDataRemount(base, { ...base, mapAttempt: 1 }, "spots", true),
    ).toBe("none");
  });

  test("a record-only arrival on the スポット tab with a live map is skipped", () => {
    expect(
      decideSpotDataRemount(
        base,
        { ...base, placesKey: "1g,2g,3g" },
        "spots",
        true,
      ),
    ).toBe("skip");
    expect(
      decideSpotDataRemount(
        base,
        { ...base, riddenLinesKey: "[x]" },
        "spots",
        true,
      ),
    ).toBe("skip");
  });

  test("the same arrival on a record tab, or without a live map, rebuilds", () => {
    expect(
      decideSpotDataRemount(
        base,
        { ...base, placesKey: "1g,2g,3g" },
        "municipalities",
        true,
      ),
    ).toBe("remount");
    expect(
      decideSpotDataRemount(
        base,
        { ...base, placesKey: "1g,2g,3g" },
        "lines",
        true,
      ),
    ).toBe("remount");
    expect(
      decideSpotDataRemount(
        base,
        { ...base, placesKey: "1g,2g,3g" },
        "spots",
        false,
      ),
    ).toBe("remount");
    /* A retry nonce moving at the same time is never a
       record-only change, so it rebuilds too. */
    expect(
      decideSpotDataRemount(
        base,
        { ...base, placesKey: "1g", mapAttempt: 1 },
        "spots",
        true,
      ),
    ).toBe("remount");
  });
});

describe("mapPaneBlockRendered (v89 review round 2, finding 2)", () => {
  test("the スポット tab always renders its pane, even with no records", () => {
    expect(mapPaneBlockRendered("spots", 0, false)).toBe(true);
  });

  test("a record tab renders the pane when either ledger has rows", () => {
    expect(mapPaneBlockRendered("municipalities", 3, false)).toBe(true);
    expect(mapPaneBlockRendered("municipalities", 0, true)).toBe(true);
    expect(mapPaneBlockRendered("lines", 3, false)).toBe(true);
    expect(mapPaneBlockRendered("lines", 0, true)).toBe(true);
  });

  test("with zero records a record tab renders NO pane — fullscreen must not survive there", () => {
    /* The reviewed trap: fullscreen carried from スポット into
       an empty 市区町村 / 路線 tab left the shared flag (and
       the scroll lock) on while neither the map nor its exit
       button was rendered, and touch had no way out. */
    expect(mapPaneBlockRendered("municipalities", 0, false)).toBe(false);
    expect(mapPaneBlockRendered("lines", 0, false)).toBe(false);
  });
});
