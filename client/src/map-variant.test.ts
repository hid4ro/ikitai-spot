/* Tests for the record map's tab-split decisions (subtask 1439):
   the hero / ghost paint split per variant, and the map line
   tap's painted-key → ledger-row resolution. Subtask 1440 adds
   the municipality tap's painted-name → ledger-row resolution
   and the sticky map pane's visible-range bound.
   Run with: bun test client/src/map-variant.test.ts */
import { describe, expect, test } from "bun:test";
import {
  lineRowForPaintedFeature,
  lineRowForPaintedKey,
  municipalityRowForPaintedName,
  shouldMountLiveMap,
  shouldSkipSpotRemount,
  spotsInitialCamera,
  stickyPaneVisibleTop,
  variantPaintOps,
  type MapMountKeys,
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
       0.95 / 3.5, unknown 0.6). On the 市区町村 tab the lines are
       the other tab's data, so they drop to ghost strength —
       present as an underlay, never competing with the fills. */
    expect(paintValue("lines", "visited-lines-color", "line-opacity")).toBe(0.95);
    expect(paintValue("lines", "visited-lines-color", "line-width")).toBe(3.5);
    expect(paintValue("lines", "visited-lines-casing", "line-opacity")).toBe(0.55);
    expect(paintValue("lines", "visited-lines-casing", "line-width")).toBe(5.5);
    expect(paintValue("lines", "visited-lines-unknown", "line-opacity")).toBe(0.6);
    expect(paintValue("municipalities", "visited-lines-color", "line-opacity")).toBe(0.32);
    expect(paintValue("municipalities", "visited-lines-color", "line-width")).toBe(2);
    expect(paintValue("municipalities", "visited-lines-casing", "line-opacity")).toBe(0.15);
    expect(paintValue("municipalities", "visited-lines-casing", "line-width")).toBe(3);
    expect(paintValue("municipalities", "visited-lines-unknown", "line-opacity")).toBe(0.28);
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
    expect(paintValue("spots", "visited-lines-unknown", "line-opacity")).toBe(0.28);
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
