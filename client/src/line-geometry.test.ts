/* Regression tests for the stage-2 line geometry (subtask 1421).
   Run with: bun test client/src/line-geometry.test.ts
   Two halves: synthetic geometries pin the graph math (chaining,
   projection, clipping, dedup), and the real bundled asset pins
   the numbers the user sees — every service's total and every
   migrated section against the railway kilometres, so a geometry
   regression shows up as a wrong distance, not a wrong map. */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import { JAPAN_LINE_TOTAL_KM, LINE_TOTAL_KM } from "./line-totals";
import {
  buildLineGraph,
  buildServicePath,
  clearLineGraphCache,
  clipServicePath,
  computeLineCoverage,
  computeRiddenLineCoverage,
  coveredBlockIds,
  EdgeCoverage,
  graphSectionLegs,
  haversineKm,
  parseFullPathSnapshot,
  sectionBounds,
  slicePolyline,
  type LineGeometryMap,
  type RideInterval,
  type ServicePath,
} from "./line-geometry";
import {
  blocksForService,
  MIGRATED_RIDES,
  SERVICE_MASTER_VERSION,
  serviceById,
  serviceFullPathSnapshot,
  type StationRef,
} from "../../shared/service-master";

const GEOMETRIES = RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap;

function station(id: string, name: string, lng: number, lat: number): StationRef {
  return { id, name, lng, lat };
}

/* N02 station centroids (the master's values) for the stations
   the tests project. */
const S = {
  東京: station("003766", "東京", 139.76675, 35.68128),
  神田: station("003677", "神田", 139.77088, 35.69242),
  新宿: station("003700", "新宿", 139.69993, 35.6898),
  立川: station("003634", "立川", 139.41396, 35.69793),
  高尾: station("004029", "高尾", 139.28217, 35.64202),
  国分寺: station("003606", "国分寺", 139.48013, 35.70045),
  千葉: station("004173", "千葉", 140.1136, 35.61275),
  船橋: station("003589", "船橋", 139.98422, 35.70195),
  佐倉: station("003531", "佐倉", 140.22675, 35.70974),
  銚子: station("003397", "銚子", 140.82747, 35.72933),
  府中: station("003821", "府中", 139.4801, 35.67219),
  聖蹟桜ヶ丘: station("003971", "聖蹟桜ヶ丘", 139.44687, 35.65079),
  京王八王子: station("003934", "京王八王子", 139.34298, 35.65805),
  調布: station("003966", "調布", 139.54474, 35.65177),
  大崎: station("004135", "大崎", 139.72807, 35.61985),
  池袋: station("003390", "池袋", 139.71108, 35.72981),
  赤羽: station("003155", "赤羽", 139.72105, 35.77754),
  大宮: station("002914", "大宮", 139.62356, 35.90653),
  川越: station("002909", "川越", 139.48307, 35.90705),
  品川: station("004095", "品川", 139.73896, 35.62851),
  田端: station("003335", "田端", 139.76157, 35.73748),
  渋谷: station("003922", "渋谷", 139.70165, 35.65898),
  目黒: station("004072", "目黒", 139.71568, 35.63272),
  新木場: station("003997", "新木場", 139.82668, 35.64587),
  品川シーサイド: station("004182", "品川シーサイド", 139.7498, 35.60979),
  府中本町: station("003876", "府中本町", 139.47718, 35.66583),
  南浦和: station("003004", "南浦和", 139.66878, 35.84796),
  西船橋: station("003547", "西船橋", 139.95907, 35.70737),
  京成高砂: station("003248", "京成高砂", 139.86659, 35.75087),
  印旛日本医大: station("003125", "印旛日本医大", 140.20276, 35.78782),
};

function servicePath(serviceId: string): ServicePath {
  const service = serviceById(serviceId)!;
  return buildServicePath(service, GEOMETRIES);
}

describe("synthetic graph", () => {
  test("a section follows the spine, not a spur", () => {
    /* A straight main line A—B—C with a dead-end spur off B. */
    const geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [0, 0.09],
        ],
        [
          [0, 0.09],
          [0, 0.18],
        ],
        [
          [0, 0.09],
          [0.05, 0.09],
        ],
      ],
    };
    const graph = buildLineGraph("synthetic|test", geometry as never);
    expect(graph.nodes.length).toBe(4);
    const section = graphSectionLegs(graph, [0, 0], [0, 0.18])!;
    /* The spine is 2 × 10 km; the 5.5 km spur is never taken. */
    expect(section.lengthKm).toBeCloseTo(20, 0);
    expect(section.legs.length).toBe(2);
    expect(section.maxProjM).toBeLessThan(1);
  });

  test("a gap between components is bridged, not jumped", () => {
    const geometry = {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [0, 0.09],
        ],
        [
          [0, 0.094],
          [0, 0.18],
        ],
      ],
    };
    const graph = buildLineGraph("gap|test", geometry as never);
    const section = graphSectionLegs(graph, [0, 0], [0, 0.18])!;
    expect(section.lengthKm).toBeCloseTo(20, 0);
    expect(section.legs.some((leg) => leg.edge.startsWith("bridge:"))).toBe(
      true,
    );
  });

  test("slicePolyline interpolates its ends", () => {
    const pts: [number, number][] = [
      [0, 0],
      [0, 0.09],
      [0, 0.18],
    ];
    const total = haversineKm(pts[0]!, pts[1]!) + haversineKm(pts[1]!, pts[2]!);
    const sliced = slicePolyline(pts, total, 0.25, 0.75);
    expect(sliced.length).toBe(3);
    expect(sliced[0]![1]).toBeCloseTo(0.045, 3);
    expect(sliced[2]![1]).toBeCloseTo(0.135, 3);
  });
});

describe("real asset: service totals against railway kilometres", () => {
  test("single-line services land within a few percent", () => {
    /* Railway kilometres from the timetable (営業キロ); the
       shape is an approximation, so the band is ±5%. */
    const cases: [string, number][] = [
      ["keio", 37.9],
      ["jr-sobu-rapid", 39.2],
      ["jr-sobu-local", 120.5],
      ["jr-musashino", 71.8],
      ["hokuso", 32.3],
      ["rinkai", 12.3],
    ];
    for (const [serviceId, railKm] of cases) {
      const path = servicePath(serviceId);
      expect(path.missing).toEqual([]);
      expect(path.totalKm).toBeGreaterThan(railKm * 0.95);
      expect(path.totalKm).toBeLessThan(railKm * 1.05);
    }
  });

  test("the Chuo rapid total is short only by the missing Tokyo–Kanda shape", () => {
    const path = servicePath("jr-chuo-rapid");
    /* 東京〜神田 has no N02 shape, so the total is 神田→高尾
       (51.8 km) instead of 東京→高尾 (53.1 km) — and the path
       says so. */
    expect(path.totalKm).toBeGreaterThan(50);
    expect(path.totalKm).toBeLessThan(53.1);
    expect(path.approximate).toBe(true);
    expect(path.maxProjM).toBeGreaterThan(1000);
  });

  test("the Yamanote loop totals one lap, and Saikyo's legs add up", () => {
    const loop = servicePath("yamanote");
    expect(loop.totalKm).toBeGreaterThan(34.5 * 0.95);
    expect(loop.totalKm).toBeLessThan(34.5 * 1.05);
    const saikyo = servicePath("jr-saikyo");
    /* 大崎〜大宮 is 36.9 km by timetable; 大宮〜川越 is the
       rest of the service. */
    expect(saikyo.totalKm).toBeGreaterThan(36.9);
    expect(saikyo.totalKm).toBeLessThan(60);
    expect(saikyo.approximate).toBe(true); /* the freight stand-in */
  });

  test("the line totals sum every separated component (stage 2 review, M-1)", () => {
    /* The separated pieces are genuine parts of the same formal
       line: the totals now land within a few percent of the
       published lengths, where the old largest-only rule dropped
       the second half (Chikuhi 42.4, Kagoshima 230.5). */
    const cases: [string, number][] = [
      ["筑肥線|九州旅客鉄道", 68.3],
      ["鹿児島線|九州旅客鉄道", 281.9],
      ["信越線|東日本旅客鉄道", 181.6],
    ];
    for (const [key, publishedKm] of cases) {
      expect(LINE_TOTAL_KM[key]).toBeGreaterThan(publishedKm * 0.95);
      expect(LINE_TOTAL_KM[key]).toBeLessThan(publishedKm * 1.05);
    }
    /* The Nemuro Line's shape is still missing a stretch (its
       total stays well short of the published 443.8 km), but the
       second piece is counted now: 359.7, not the old 305.1. */
    expect(LINE_TOTAL_KM["根室線|北海道旅客鉄道"]).toBeGreaterThan(350);
    expect(JAPAN_LINE_TOTAL_KM).toBeCloseTo(26903.9, 0);
  });
});

describe("real asset: the migrated sections", () => {
  test("every migrated partial measures close to its railway kilometres", () => {
    const cases: [string, StationRef, StationRef, number][] = [
      ["jr-chuo-rapid", S.国分寺, S.東京, 31.4],
      ["jr-sobu-rapid", S.東京, S.千葉, 39.2],
      ["jr-sobu-local", S.佐倉, S.千葉, 15.0],
      ["keio", S.府中, S.聖蹟桜ヶ丘, 4.4],
      ["rinkai", S.大崎, S.品川シーサイド, 3.3],
    ];
    for (const [serviceId, from, to, railKm] of cases) {
      const path = servicePath(serviceId);
      const clip = clipServicePath(path, from, to)!;
      expect(clip).not.toBeNull();
      expect(clip.lengthKm).toBeGreaterThan(railKm * 0.9);
      expect(clip.lengthKm).toBeLessThan(railKm * 1.1);
    }
    /* The migrated rides' own table agrees with the master. */
    for (const ride of Object.values(MIGRATED_RIDES)) {
      if (ride.rideState !== "partial") continue;
      const path = servicePath(ride.serviceId);
      const clip = clipServicePath(path, ride.from!, ride.to!)!;
      expect(clip.lengthKm).toBeGreaterThan(1);
    }
  });

  test("the Yamanote section takes the outer side, not the long way round", () => {
    const path = servicePath("yamanote");
    const outer = clipServicePath(path, S.大崎, S.目黒, "outer")!;
    /* 大崎→目黒 is ~2.9 km outer (via 五反田); the inner way
       round is the rest of the 34.5 km loop. */
    expect(outer.lengthKm).toBeGreaterThan(1.5);
    expect(outer.lengthKm).toBeLessThan(2.5);
    const inner = clipServicePath(path, S.大崎, S.目黒, "inner")!;
    expect(inner.lengthKm).toBeGreaterThan(29);
    /* The outer clip passes 五反田 (139.72407, 35.62507). */
    const coords = outer.legs.flatMap((leg) => leg.coords);
    const nearGotanda = coords.some(
      (p) => haversineKm(p, [139.72407, 35.62507]) < 0.5,
    );
    expect(nearGotanda).toBe(true);
  });

  test("a section clipped the wrong way round a loop is the long way", () => {
    const path = servicePath("yamanote");
    /* 新宿→東京 outer runs via 田端 (~11 km); inner runs via
       渋谷・品川 (~13 km). The direction, not the shorter arc,
       decides. */
    const outer = clipServicePath(path, S.新宿, S.東京, "outer")!;
    const inner = clipServicePath(path, S.新宿, S.東京, "inner")!;
    expect(outer.lengthKm).toBeGreaterThan(14);
    expect(outer.lengthKm).toBeLessThan(19);
    expect(inner.lengthKm).toBeGreaterThan(14);
    expect(inner.lengthKm).toBeLessThan(19);
    const outerCoords = outer.legs.flatMap((leg) => leg.coords);
    expect(
      outerCoords.some((p) => haversineKm(p, [S.田端.lng, S.田端.lat]) < 0.5),
    ).toBe(true);
    const innerCoords = inner.legs.flatMap((leg) => leg.coords);
    expect(
      innerCoords.some((p) => haversineKm(p, [S.品川.lng, S.品川.lat]) < 0.5),
    ).toBe(true);
  });
});

describe("coverage: dedup and per-service isolation", () => {
  function coverageFor(
    intervals: ReadonlyMap<string, readonly RideInterval[]>,
    full: readonly string[] = [],
  ) {
    clearLineGraphCache();
    const paths = new Map<string, ServicePath>();
    for (const service of [
      "jr-chuo-rapid",
      "jr-sobu-rapid",
      "jr-sobu-local",
      "jr-saikyo",
      "yamanote",
      "keio",
      "jr-musashino",
      "hokuso",
      "rinkai",
    ]) {
      paths.set(service, servicePath(service));
    }
    return computeLineCoverage(
      intervals,
      new Set(full),
      paths,
      GEOMETRIES,
      597,
    );
  }

  test("overlapping sections on one line count once", () => {
    const intervals = new Map<string, readonly RideInterval[]>([
      [
        "jr-sobu-rapid",
        [{ serviceId: "jr-sobu-rapid", from: S.東京, to: S.千葉 }],
      ],
      [
        "jr-sobu-local",
        [{ serviceId: "jr-sobu-local", from: S.東京, to: S.千葉 }],
      ],
    ]);
    const coverage = coverageFor(intervals);
    const keyKm = coverage.perKeyKm.get("総武線|東日本旅客鉄道")!;
    /* Both services rode the same 東京〜千葉 stretch: the key
       counts it once (~39 km), not twice. */
    expect(keyKm).toBeGreaterThan(38);
    expect(keyKm).toBeLessThan(41);
    /* But each service's own row keeps its own distance. */
    expect(coverage.perService.get("jr-sobu-rapid")!.riddenKm).toBeGreaterThan(38);
    expect(coverage.perService.get("jr-sobu-local")!.riddenKm).toBeGreaterThan(38);
    expect(coverage.perOperatorKm.get("東日本旅客鉄道")).toBeCloseTo(keyKm, 0);
  });

  test("two blocks of one service accumulate without double-counting", () => {
    const intervals = new Map<string, readonly RideInterval[]>([
      [
        "jr-chuo-rapid",
        [
          { serviceId: "jr-chuo-rapid", from: S.東京, to: S.新宿 },
          { serviceId: "jr-chuo-rapid", from: S.新宿, to: S.立川 },
          /* The same block twice must not double-count. */
          { serviceId: "jr-chuo-rapid", from: S.東京, to: S.新宿 },
        ],
      ],
    ]);
    const coverage = coverageFor(intervals);
    const service = coverage.perService.get("jr-chuo-rapid")!;
    /* 東京→立川 is 37.5 km by timetable (東京〜新宿 10.3 +
       新宿〜立川 27.2); the 東京〜神田 shape is missing, so the
       shape gives a little less. */
    expect(service.riddenKm).toBeGreaterThan(35);
    expect(service.riddenKm).toBeLessThan(38);
    expect(service.complete).toBe(false);
  });

  test("a full ride covers the whole service and counts as complete", () => {
    const coverage = coverageFor(new Map(), ["keio"]);
    const service = coverage.perService.get("keio")!;
    expect(service.complete).toBe(true);
    expect(service.riddenKm).toBeCloseTo(service.totalKm, 1);
    expect(coverage.completeServiceIds).toContain("keio");
  });

  test("sections covering a whole service complete it without a full ride", () => {
    const intervals = new Map<string, readonly RideInterval[]>([
      [
        "keio",
        [
          { serviceId: "keio", from: S.新宿, to: S.調布 },
          { serviceId: "keio", from: S.調布, to: S.府中 },
          { serviceId: "keio", from: S.府中, to: S.京王八王子 },
        ],
      ],
    ]);
    const coverage = coverageFor(intervals);
    expect(coverage.perService.get("keio")!.complete).toBe(true);
    expect(coverage.completeServiceIds).toContain("keio");
  });

  test("selecting every block completes the service (stage 2 review, H-2)", () => {
    /* The block picker tiles a service: picking all its blocks
       must complete it. Before the end-snap fix, three services
       fell short by 0.12–0.17 km — a clip ending at a terminus
       station whose recorded point sits up to ~300 m off the
       shape, and the 0.1 km snap did not reach it. */
    for (const serviceId of [
      "jr-chuo-rapid",
      "jr-sobu-rapid",
      "jr-sobu-local",
      "jr-saikyo",
      "yamanote",
      "keio",
      "jr-musashino",
      "hokuso",
      "rinkai",
    ]) {
      const intervals = blocksForService(serviceId).map((block) => ({
        serviceId,
        from: block.from,
        to: block.to,
        direction: block.direction,
      }));
      const coverage = coverageFor(new Map([[serviceId, intervals]]));
      const service = coverage.perService.get(serviceId)!;
      expect(service.complete).toBe(true);
      expect(service.riddenKm).toBeCloseTo(service.totalKm, 1);
    }
  });

  test("the unprepared-lines note counts the lines the master does not cover", () => {
    const coverage = coverageFor(new Map());
    /* 11 formal keys across the 9 services' paths. */
    expect(coverage.unpreparedLines).toBe(597 - 11);
  });

  test("perServiceLegs paints the clipped sections, not the whole path", () => {
    const intervals = new Map<string, readonly RideInterval[]>([
      [
        "jr-sobu-rapid",
        [{ serviceId: "jr-sobu-rapid", from: S.東京, to: S.千葉 }],
      ],
    ]);
    const coverage = coverageFor(intervals);
    const painted = coverage.perServiceLegs.get("jr-sobu-rapid")!;
    expect(painted.unknown).toBe(false);
    /* The painted legs are 東京〜千葉 (~39 km), far short of the
       service's whole path (東京〜銚子, ~120 km). */
    const paintedKm = painted.legs.reduce((sum, leg) => sum + leg.lengthKm, 0);
    expect(paintedKm).toBeGreaterThan(38);
    expect(paintedKm).toBeLessThan(41);
  });

  test("a service with no section paints its whole path dashed and counts nothing", () => {
    /* No intervals and no full rides: every service in the input
       paints its whole path with unknown=true, and none of it
       counts toward the distance. */
    const coverage = coverageFor(new Map());
    const painted = coverage.perServiceLegs.get("keio")!;
    expect(painted.unknown).toBe(true);
    expect(painted.legs.length).toBeGreaterThan(0);
    expect(coverage.perService.get("keio")!.riddenKm).toBe(0);
    expect(coverage.networkRiddenKm).toBe(0);
  });
});

describe("coverage from saved ledger rows", () => {
  const oldLink = {
    name: "中央線（各駅停車）",
    serviceId: "jr-chuo-rapid",
    fromStationId: null,
    toStationId: null,
    pathSnapshot: null,
    sections: [],
  };

  test.each(["unknown", "partial", "full"] as const)(
    "leaves a pending-review ride in state %s off the map and out of the distances",
    (rideState) => {
      const row = {
        ...oldLink,
        rideState,
        fromStationId: rideState === "partial" ? S.東京.id : null,
        toStationId: rideState === "partial" ? S.国分寺.id : null,
      };
      const coverage = computeRiddenLineCoverage([row], GEOMETRIES, 597);
      expect(coverage.networkRiddenKm).toBe(0);
      expect(coverage.perServiceLegs.size).toBe(0);
      expect(coverage.perOperatorKm.size).toBe(0);
      expect(coverage.perService.size).toBe(0);
      expect(coverage.completeServiceIds).toEqual([]);
    },
  );

  test("a pending full ride does not extend a verified ride on the same service", () => {
    const verified = {
      ...oldLink,
      name: "JR中央線（快速）",
      rideState: "partial" as const,
      fromStationId: S.東京.id,
      toStationId: S.国分寺.id,
    };
    const coverage = computeRiddenLineCoverage(
      [{ ...oldLink, rideState: "full" }, verified],
      GEOMETRIES,
      597,
    );
    expect(coverage.networkRiddenKm).toBeCloseTo(30.2, 0);
    expect(coverage.perServiceLegs.get("jr-chuo-rapid")?.unknown).toBe(false);
    expect(coverage.completeServiceIds).toEqual([]);
  });
});

describe("coveredBlockIds: whole-block coverage for the block picker", () => {
  test("a Keio section covering two blocks marks both", () => {
    const covered = coveredBlockIds("keio", [
      { serviceId: "keio", from: S.新宿, to: S.府中 },
    ]);
    expect([...covered].sort()).toEqual(["keio/b1", "keio/b2"]);
  });

  test("a section that only clips a block marks nothing", () => {
    /* 府中→聖蹟桜ヶ丘 stays inside block b3 （府中→京王八王子):
       no block is fully ridden. */
    const covered = coveredBlockIds("keio", [
      { serviceId: "keio", from: S.府中, to: S.聖蹟桜ヶ丘 },
    ]);
    expect(covered.size).toBe(0);
  });

  test("a Yamanote outer section covers the outer blocks", () => {
    const covered = coveredBlockIds("yamanote", [
      {
        serviceId: "yamanote",
        from: S.品川,
        to: S.田端,
        direction: "outer",
      },
    ]);
    expect([...covered].sort()).toEqual([
      "yamanote/b1",
      "yamanote/b2",
      "yamanote/b3",
      "yamanote/b4",
    ]);
  });

  test("the same Yamanote endpoints the inner way cover the same blocks", () => {
    const covered = coveredBlockIds("yamanote", [
      {
        serviceId: "yamanote",
        from: S.田端,
        to: S.品川,
        direction: "inner",
      },
    ]);
    expect([...covered].sort()).toEqual([
      "yamanote/b1",
      "yamanote/b2",
      "yamanote/b3",
      "yamanote/b4",
    ]);
  });

  test("the short way round a loop is taken when no direction is given", () => {
    const covered = coveredBlockIds("yamanote", [
      { serviceId: "yamanote", from: S.田端, to: S.品川 },
    ]);
    expect([...covered].sort()).toEqual(["yamanote/b5", "yamanote/b6"]);
  });
});

describe("sectionBounds", () => {
  test("bounds span the painted legs, and empty legs give null", () => {
    const path = servicePath("keio");
    const bounds = sectionBounds(path.legs);
    expect(bounds).not.toBeNull();
    const [[minLng, minLat], [maxLng, maxLat]] = bounds!;
    /* 新宿 in the east, 京王八王子 in the west. */
    expect(minLng).toBeLessThan(139.36);
    expect(maxLng).toBeGreaterThan(139.69);
    expect(minLat).toBeLessThan(35.66);
    expect(maxLat).toBeGreaterThan(35.68);
    expect(sectionBounds([])).toBeNull();
  });
});

describe("full-path snapshots", () => {
  test("a snapshot round-trips and reproduces the recorded range", () => {
    const snapshot = serviceFullPathSnapshot("jr-saikyo")!;
    expect(snapshot.masterVersion).toBe(SERVICE_MASTER_VERSION);
    const parsed = parseFullPathSnapshot(JSON.stringify(snapshot))!;
    expect(parsed.pathId).toBe("jr-saikyo");
    expect(parsed.segments.length).toBe(4);
    const path = buildServicePath(serviceById("jr-saikyo")!, GEOMETRIES, parsed);
    expect(path.totalKm).toBeCloseTo(
      servicePath("jr-saikyo").totalKm,
      1,
    );
    expect(parseFullPathSnapshot(null)).toBeNull();
    expect(parseFullPathSnapshot("not json")).toBeNull();
    expect(parseFullPathSnapshot('{"pathId": 1}')).toBeNull();
  });
});

describe("EdgeCoverage", () => {
  test("merged ranges on one edge count once", () => {
    const cover = new EdgeCoverage();
    const leg = (fromT: number, toT: number) => ({
      key: "x|y",
      edge: "edge:0",
      fromT,
      toT,
      coords: [] as [number, number][],
      lengthKm: 0,
    });
    cover.addLeg(leg(0, 0.6));
    cover.addLeg(leg(0.4, 1));
    /* The edge is 10 km in this synthetic graph. */
    const graph = buildLineGraph("x|y", {
      type: "MultiLineString",
      coordinates: [
        [
          [0, 0],
          [0, 0.09],
        ],
      ],
    } as never);
    void graph;
    const geometries = {
      "x|y": {
        name: "x",
        operator: "y",
        color: "#000",
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [
              [0, 0],
              [0, 0.09],
            ],
          ],
        },
      },
    } as unknown as LineGeometryMap;
    clearLineGraphCache();
    expect(cover.kilometresOn("x|y", geometries)).toBeCloseTo(10, 0);
  });
});
