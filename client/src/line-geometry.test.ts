/* Regression tests for the stage-2 line geometry (subtask 1421).
   Run with: bun test client/src/line-geometry.test.ts
   Two halves: synthetic geometries pin the graph math (chaining,
   projection, clipping, dedup), and the real bundled asset pins
   the numbers the user sees — every service's total and every
   migrated section against the railway kilometres, so a geometry
   regression shows up as a wrong distance, not a wrong map. */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import type { GeoJsonLineGeometry } from "./geojson";
import { JAPAN_LINE_TOTAL_KM, LINE_TOTAL_KM } from "./line-totals";
import { buildLineKeyByName } from "./line-resolution";
import {
  buildLineGraph,
  buildServicePath,
  clearLineGraphCache,
  clipServicePath,
  computeLineCoverage,
  computeRiddenLineCoverage,
  coveredBlockIds,
  EdgeCoverage,
  ghostLineLegs,
  graphSectionLegs,
  haversineKm,
  parseFullPathSnapshot,
  sectionBounds,
  slicePolyline,
  distanceToLineGeometryM,
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
  東松戸: station("003187", "東松戸", 139.94311, 35.77013),
  北府中: station("003771", "北府中", 139.47179, 35.68086),
  印西牧の原: station("003083", "印西牧の原", 140.16713, 35.80363),
  新松戸: station("003045", "新松戸", 139.92111, 35.82549),
  新鎌ヶ谷: station("003146", "新鎌ヶ谷", 139.99836, 35.77961),
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
    /* 大崎→目黒 is 2.1 km outer, published (via 五反田); the
       asset measures ~1.85 km, inside the loose 1.5–2.5 band
       (review round 1, low — the old comment's 2.9 km was
       wrong). The inner way round is the rest of the 34.5 km
       loop. */
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

  test("a direction-less loop section is clipped the shorter-by-steps way (review round 2, medium)", () => {
    /* Without a direction, the map must draw the same side
       the block picker marks (the shorter way by station
       steps — the picker's fallback). The old clip took the
       [min, max] arc-kilometre range, which at the seam
       station 品川 flips to the long way round: 大崎→田端
       drew via 渋谷・新宿 (~18.5 km) while the picker marked
       the 東京 side, and 品川→新宿 drew via 東京 (~23.6 km)
       while the picker marked b1・b2. */
    const path = servicePath("yamanote");
    const osakiTabata = clipServicePath(path, S.大崎, S.田端)!;
    expect(osakiTabata.lengthKm).toBeCloseTo(15.84, 1);
    expect(
      osakiTabata.legs
        .flatMap((leg) => leg.coords)
        .some((p) => haversineKm(p, [S.東京.lng, S.東京.lat]) < 0.5),
    ).toBe(true);
    const shinagawaShinjuku = clipServicePath(path, S.品川, S.新宿)!;
    expect(shinagawaShinjuku.lengthKm).toBeCloseTo(10.68, 1);
    expect(
      shinagawaShinjuku.legs
        .flatMap((leg) => leg.coords)
        .some((p) => haversineKm(p, [S.渋谷.lng, S.渋谷.lat]) < 0.5),
    ).toBe(true);
    /* 品川→池袋 is unchanged by the fix: the step count
       already tips it to the 東京 side (3 steps against 4),
       and the clip stays on that side (~18.9 km). */
    const shinagawaIkebukuro = clipServicePath(path, S.品川, S.池袋)!;
    expect(shinagawaIkebukuro.lengthKm).toBeCloseTo(18.93, 1);
  });
});

describe("real asset: the subtask-1455 estimated sections", () => {
  test("the two single-line sections measure their published rail kilometres", () => {
    /* 武蔵野線 東松戸 64.0 km − 北府中 1.7 km = 62.3 km;
       北総線 印西牧の原 28.5 km − 東松戸 7.5 km = 21.0 km
       (Wikipedia station distances from 府中本町 / 京成高砂).
       The ±10% band is the same one the migrated sections use. */
    const cases: [string, StationRef, StationRef, number][] = [
      ["jr-musashino", S.東松戸, S.北府中, 62.3],
      ["hokuso", S.東松戸, S.印西牧の原, 21.0],
    ];
    for (const [serviceId, from, to, railKm] of cases) {
      const path = servicePath(serviceId);
      const clip = clipServicePath(path, from, to)!;
      expect(clip).not.toBeNull();
      expect(clip.approximate).toBe(false);
      expect(clip.lengthKm).toBeGreaterThan(railKm * 0.9);
      expect(clip.lengthKm).toBeLessThan(railKm * 1.1);
    }
    /* The clips follow the line through the stations between:
       南浦和・新松戸 on 武蔵野線, 新鎌ヶ谷 on 北総線. */
    const musashino = clipServicePath(
      servicePath("jr-musashino"),
      S.東松戸,
      S.北府中,
    )!;
    const musashinoCoords = musashino.legs.flatMap((leg) => leg.coords);
    for (const via of [S.南浦和, S.新松戸]) {
      expect(
        musashinoCoords.some(
          (p) => haversineKm(p, [via.lng, via.lat]) < 0.5,
        ),
      ).toBe(true);
    }
    const hokuso = clipServicePath(
      servicePath("hokuso"),
      S.東松戸,
      S.印西牧の原,
    )!;
    const hokusoCoords = hokuso.legs.flatMap((leg) => leg.coords);
    expect(
      hokusoCoords.some(
        (p) => haversineKm(p, [S.新鎌ヶ谷.lng, S.新鎌ヶ谷.lat]) < 0.5,
      ),
    ).toBe(true);
  });

  test("the Yamanote section takes the inner side, via 渋谷・目黒", () => {
    const path = servicePath("yamanote");
    const inner = clipServicePath(path, S.新宿, S.大崎, "inner")!;
    /* Published 8.6 km; the asset measures 8.58 km, matching
       the published figure to the first decimal (review round
       1, low — the old comment's 9.8 km was wrong, and so was
       the 7–10 km band it justified). What matters is that it
       is the short way, via 渋谷・目黒, and not the long way
       round via 田端・東京. */
    expect(inner.lengthKm).toBeCloseTo(8.6, 1);
    const innerCoords = inner.legs.flatMap((leg) => leg.coords);
    for (const via of [S.渋谷, S.目黒]) {
      expect(
        innerCoords.some((p) => haversineKm(p, [via.lng, via.lat]) < 0.5),
      ).toBe(true);
    }
    for (const notVia of [S.田端, S.東京]) {
      expect(
        innerCoords.some(
          (p) => haversineKm(p, [notVia.lng, notVia.lat]) < 0.5,
        ),
      ).toBe(false);
    }
    const outer = clipServicePath(path, S.新宿, S.大崎, "outer")!;
    expect(outer.lengthKm).toBeGreaterThan(20);
  });

  test("ledger rows carrying the three sections count their union", () => {
    /* The live rows as they will stand after registration:
       武蔵野線・北総線 move from unknown to partial with one
       added section each; 山手線 keeps its primary 大崎→目黒
       and gains 新宿→大崎 (inner). The Yamanote overlap
       （目黒→大崎 is inside the new section) counts once. */
    const rows = [
      {
        name: "JR武蔵野線",
        serviceId: "jr-musashino",
        serviceLinkSource: null,
        fromStationId: null,
        toStationId: null,
        pathSnapshot: null as string | null,
        rideState: "partial" as const,
        sections: [
          {
            fromStationId: S.東松戸.id,
            toStationId: S.北府中.id,
            direction: null,
            blockId: null,
            recordedServiceId: "jr-musashino",
          },
        ],
      },
      {
        name: "北総線",
        serviceId: "hokuso",
        serviceLinkSource: null,
        fromStationId: null,
        toStationId: null,
        pathSnapshot: null as string | null,
        rideState: "partial" as const,
        sections: [
          {
            fromStationId: S.東松戸.id,
            toStationId: S.印西牧の原.id,
            direction: null,
            blockId: null,
            recordedServiceId: "hokuso",
          },
        ],
      },
      {
        name: "山手線",
        serviceId: "yamanote",
        serviceLinkSource: null,
        recordedServiceId: "yamanote",
        fromStationId: S.大崎.id,
        toStationId: S.目黒.id,
        pathSnapshot: null as string | null,
        rideState: "partial" as const,
        sections: [
          {
            fromStationId: S.新宿.id,
            toStationId: S.大崎.id,
            direction: "inner" as const,
            blockId: null,
            recordedServiceId: "yamanote",
          },
        ],
      },
    ];
    const coverage = computeRiddenLineCoverage(rows, GEOMETRIES, 597);
    expect(coverage.perService.get("jr-musashino")!.riddenKm).toBeCloseTo(
      62.3,
      0,
    );
    expect(coverage.perService.get("hokuso")!.riddenKm).toBeCloseTo(21.0, 0);
    /* 山手線's union is the inner section alone (8.58 km): the
       primary 大崎→目黒 sits inside it, and the row carries
       its recordedServiceId so the primary is attributed at
       all — without it the overlap would never be counted
       twice and this test would be vacuous (review round 1,
       medium). The tight precision is the point: the
       double-count measured 8.686 km before the fix. */
    expect(coverage.perService.get("yamanote")!.riddenKm).toBeCloseTo(
      8.58,
      1,
    );
    expect(coverage.networkRiddenKm).toBeCloseTo(91.9, 0);
    expect(coverage.completeServiceIds).toEqual([]);
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

  test("a service with no section paints its whole path thin and counts nothing", () => {
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

  test("a Yamanote inner section ending at a non-boundary station covers the block it runs over whole", () => {
    /* 新宿→大崎 inner (review round 1, medium): 大崎 is no
       boundary station, but the section runs yamanote/b2
       （渋谷〜新宿) end to end, so the block is covered and
       cannot be picked again — the old version located
       endpoints among boundary stations only and marked
       nothing, leaving the same range re-registerable.
       yamanote/b1 （品川〜渋谷) is only partly ridden
       （渋谷→大崎), so it stays open. */
    const covered = coveredBlockIds("yamanote", [
      {
        serviceId: "yamanote",
        from: S.新宿,
        to: S.大崎,
        direction: "inner",
      },
    ]);
    expect([...covered].sort()).toEqual(["yamanote/b2"]);
  });

  test("a Yamanote outer section the long way round does not cover the block it never runs (review round 2, medium)", () => {
    /* 新宿→渋谷 outer runs via 田端・東京・品川, so it never
       runs yamanote/b2 （渋谷〜新宿) — but the old version
       judged by the set of stations passed, and both of b2's
       endpoints are passed (one at each end of the long way
       round), so it marked all six blocks. The block is
       covered only when the section runs over it end to end:
       the five blocks the long way round actually traverses. */
    const covered = coveredBlockIds("yamanote", [
      {
        serviceId: "yamanote",
        from: S.新宿,
        to: S.渋谷,
        direction: "outer",
      },
    ]);
    expect([...covered].sort()).toEqual([
      "yamanote/b1",
      "yamanote/b3",
      "yamanote/b4",
      "yamanote/b5",
      "yamanote/b6",
    ]);
  });

  test("several added sections jointly covering one block mark it (review round 2, low)", () => {
    /* 北総線's single block hokuso/b1 is covered by two
       sections together （京成高砂→東松戸 and
       東松戸→印旛日本医大) — the old version judged each
       section alone, so neither marked anything and the block
       stayed pickable even though the whole block is ridden. */
    const jointly = coveredBlockIds("hokuso", [
      { serviceId: "hokuso", from: S.京成高砂, to: S.東松戸 },
      { serviceId: "hokuso", from: S.東松戸, to: S.印旛日本医大 },
    ]);
    expect([...jointly].sort()).toEqual(["hokuso/b1"]);
    const alone = coveredBlockIds("hokuso", [
      { serviceId: "hokuso", from: S.京成高砂, to: S.東松戸 },
    ]);
    expect(alone.size).toBe(0);
  });

  test("direction-less loop sections use the shorter-by-steps way (review round 2, medium)", () => {
    /* Without a direction, the shorter way by station steps
       is taken — the same fallback the map's clip uses, so
       the check column and the drawing agree. 大崎 counts as
       a listed station on yamanote/b1, which is what tips
       品川→池袋 to the 東京 side (3 steps against 4). */
    expect(
      [...coveredBlockIds("yamanote", [
        { serviceId: "yamanote", from: S.品川, to: S.池袋 },
      ])].sort(),
    ).toEqual(["yamanote/b4", "yamanote/b5", "yamanote/b6"]);
    expect(
      [...coveredBlockIds("yamanote", [
        { serviceId: "yamanote", from: S.大崎, to: S.田端 },
      ])].sort(),
    ).toEqual(["yamanote/b5", "yamanote/b6"]);
    expect(
      [...coveredBlockIds("yamanote", [
        { serviceId: "yamanote", from: S.品川, to: S.新宿 },
      ])].sort(),
    ).toEqual(["yamanote/b1", "yamanote/b2"]);
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

describe("distanceToLineGeometryM (the nearest-line pick, subtask 1483)", () => {
  test("a point on a segment is 0, a point off it is its perpendicular distance", () => {
    const geometry: GeoJsonLineGeometry = {
      type: "MultiLineString",
      coordinates: [[[139.0, 35.0], [139.1, 35.0]]],
    };
    expect(distanceToLineGeometryM([139.05, 35.0], geometry)).toBeCloseTo(0, 6);
    /* 0.01° north at lat 35° is ~1105 m on the local projection. */
    expect(distanceToLineGeometryM([139.05, 35.01], geometry)).toBeCloseTo(1105.4, 0);
    /* Past the segment's end the nearest point is the endpoint —
       the local projection approximates the haversine within
       tens of metres, so compare loosely. */
    expect(
      distanceToLineGeometryM([139.2, 35.0], geometry),
    ).toBeCloseTo(haversineKm([139.1, 35.0], [139.2, 35.0]) * 1000, -2);
    /* A point beside the middle of a long straight counts as near,
       not only a point beside a vertex. */
    expect(distanceToLineGeometryM([139.05, 35.001], geometry)).toBeLessThan(200);
    expect(
      distanceToLineGeometryM([139.05, 35.0], {
        type: "MultiLineString",
        coordinates: [],
      }),
    ).toBeNull();
    expect(
      distanceToLineGeometryM([139.05, 35.0], {
        type: "MultiLineString",
        coordinates: [[[139.0, 35.0]]],
      }),
    ).toBeNull();
  });

  test("against the real asset: 府中駅 sits on 京王線, far from 北総線", () => {
    const keyByName = buildLineKeyByName(GEOMETRIES);
    const geometryOf = (name: string) =>
      GEOMETRIES[keyByName.get(name)!]!.geometry;
    /* The station sits on the line; the shape wanders a little,
       so "on it" means well under a kilometre, not exactly 0. */
    expect(distanceToLineGeometryM([S.府中.lng, S.府中.lat], geometryOf("京王線"))).toBeLessThan(1000);
    expect(distanceToLineGeometryM([S.府中.lng, S.府中.lat], geometryOf("北総線"))).toBeGreaterThan(30000);
    expect(distanceToLineGeometryM([S.千葉.lng, S.千葉.lat], geometryOf("総武線"))).toBeLessThan(1000);
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

describe("rides recorded under another service (integrated review round 1, high)", () => {
  /* A row explicitly linked to 京王線 whose RECORD was made on
     中央線快速 — the shape the review reproduced by relinking a
     完乗 row: the old service's ride must not become the new
     service's achievement. */
  const keioRow = {
    name: "京王線",
    serviceId: "keio",
    serviceLinkSource: "explicit" as const,
    fromStationId: null,
    toStationId: null,
    pathSnapshot: null as string | null,
    sections: [] as never[],
  };

  test("a full ride whose snapshot belongs to another service completes nothing", () => {
    const coverage = computeRiddenLineCoverage(
      [
        {
          ...keioRow,
          rideState: "full" as const,
          pathSnapshot: JSON.stringify(serviceFullPathSnapshot("jr-chuo-rapid")),
        },
      ],
      GEOMETRIES,
      597,
    );
    expect(coverage.perServiceLegs.has("keio")).toBe(false);
    expect(coverage.completeServiceIds).toEqual([]);
    expect(coverage.networkRiddenKm).toBe(0);
  });

  test("the same full ride with its own service's snapshot completes it", () => {
    const coverage = computeRiddenLineCoverage(
      [
        {
          ...keioRow,
          rideState: "full" as const,
          pathSnapshot: JSON.stringify(serviceFullPathSnapshot("keio")),
        },
      ],
      GEOMETRIES,
      597,
    );
    expect(coverage.completeServiceIds).toEqual(["keio"]);
    expect(coverage.perService.get("keio")!.riddenKm).toBeGreaterThan(30);
  });

  test("a partial section whose endpoints belong to another service counts nothing", () => {
    const coverage = computeRiddenLineCoverage(
      [
        {
          ...keioRow,
          rideState: "partial" as const,
          fromStationId: S.国分寺.id,
          toStationId: S.立川.id,
        },
      ],
      GEOMETRIES,
      597,
    );
    expect(coverage.perService.get("keio")!.riddenKm).toBe(0);
    expect(coverage.networkRiddenKm).toBe(0);
    expect(coverage.completeServiceIds).toEqual([]);
  });

  test("a partial section on the service's own stations still counts", () => {
    const coverage = computeRiddenLineCoverage(
      [
        {
          ...keioRow,
          rideState: "partial" as const,
          fromStationId: S.新宿.id,
          toStationId: S.府中.id,
        },
      ],
      GEOMETRIES,
      597,
    );
    expect(coverage.perService.get("keio")!.riddenKm).toBeGreaterThan(15);
  });
});

describe("rides whose route the record cannot pin down (integrated review round 2, high)", () => {
  const base = {
    serviceLinkSource: "explicit" as const,
    fromStationId: null,
    toStationId: null,
    pathSnapshot: null as string | null,
    sections: [] as never[],
  };

  test("an ambiguous primary section with no recorded service counts for neither", () => {
    /* 東京→新宿 is 中央線（快速）'s first block — and also a
       山手線 pair, over a different route. Relinked to 山手線,
       the record's ~9.1 km came back as 山手線's ~16.9 km. The
       endpoints cannot tell the routes apart without the
       service the section was recorded on. */
    for (const [name, serviceId] of [
      ["山手線", "yamanote"],
      ["JR中央線（快速）", "jr-chuo-rapid"],
    ] as const) {
      const coverage = computeRiddenLineCoverage(
        [
          {
            ...base,
            name,
            serviceId,
            rideState: "partial" as const,
            fromStationId: "003766",
            toStationId: "003700",
          },
        ],
        GEOMETRIES,
        597,
      );
      expect(coverage.perService.get(serviceId)!.riddenKm).toBe(0);
      expect(coverage.networkRiddenKm).toBe(0);
      expect(coverage.completeServiceIds).toEqual([]);
    }
  });

  test("primary sections count when the recording or endpoints identify the route", () => {
    const cases = [
      /* The migration supplies the source of the 山手線 and
         埼京線 sections, which each have an alternative route
         around the loop without that evidence. */
      ["山手線", "yamanote", "004135", "004072", "yamanote"],
      ["JR埼京線", "jr-saikyo", "003700", "004135", "jr-saikyo"],
      /* 総武快速線 and 総武本線 share 東京→千葉 over the one
         formal line 総武線. */
      ["JR総武快速線", "jr-sobu-rapid", "003766", "004173", null],
      /* 京王線's restored section, ending at a mid-segment
         station no other service serves. */
      ["京王線", "keio", "003821", "003971", null],
    ] as const;
    for (const [name, serviceId, fromStationId, toStationId, recordedServiceId] of cases) {
      const coverage = computeRiddenLineCoverage(
        [
          {
            ...base,
            name,
            serviceId,
            recordedServiceId,
            rideState: "partial" as const,
            fromStationId,
            toStationId,
          },
        ],
        GEOMETRIES,
        597,
      );
      expect(coverage.perService.get(serviceId)!.riddenKm).toBeGreaterThan(0);
    }
  });

  test("an ambiguous blockless section uses its own recorded service", () => {
    const row = {
      ...base,
      name: "山手線",
      serviceId: "yamanote",
      recordedServiceId: "yamanote",
      rideState: "partial" as const,
    };
    const section = {
      fromStationId: "003766",
      toStationId: "003700",
      direction: "inner" as const,
      blockId: null,
    };
    for (const [recordedServiceId, expectedKm] of [
      [null, 0],
      ["jr-chuo-rapid", 0],
      ["yamanote", 16.93],
    ] as const) {
      const coverage = computeRiddenLineCoverage(
        [{ ...row, sections: [{ ...section, recordedServiceId }] }],
        GEOMETRIES,
        597,
      );
      expect(coverage.perService.get("yamanote")?.riddenKm).toBeCloseTo(
        expectedKm,
        1,
      );
      expect(coverage.networkRiddenKm).toBeCloseTo(expectedKm, 1);
    }
  });

  test("an added section naming another service's block counts nothing; unpinned, it counts", () => {
    const row = {
      ...base,
      name: "JR総武快速線",
      serviceId: "jr-sobu-rapid",
      rideState: "partial" as const,
      fromStationId: "003589" /* 船橋 */,
      toStationId: "004173" /* 千葉 */,
      sections: [
        {
          fromStationId: "003766",
          toStationId: "004173",
          direction: null,
          blockId: "jr-sobu-local/b1",
        },
      ],
    };
    const held = computeRiddenLineCoverage([row], GEOMETRIES, 597);
    /* Only the primary section 船橋→千葉 counts (~14 km); the
       総武本線 block's 東京→千葉 would have nearly tripled it
       and completed the rapid service's painted range. */
    expect(held.perService.get("jr-sobu-rapid")!.riddenKm).toBeGreaterThan(5);
    expect(held.perService.get("jr-sobu-rapid")!.riddenKm).toBeLessThan(20);
    const unpinned = computeRiddenLineCoverage(
      [
        {
          ...row,
          sections: [
            {
              fromStationId: "003766",
              toStationId: "004173",
              direction: null,
              blockId: null,
            },
          ],
        },
      ],
      GEOMETRIES,
      597,
    );
    expect(
      unpinned.perService.get("jr-sobu-rapid")!.riddenKm,
    ).toBeGreaterThan(35);
  });

  test("an added section naming the row's own service's block counts", () => {
    const coverage = computeRiddenLineCoverage(
      [
        {
          ...base,
          name: "JR総武快速線",
          serviceId: "jr-sobu-rapid",
          rideState: "partial" as const,
          fromStationId: "003589",
          toStationId: "004173",
          sections: [
            {
              fromStationId: "003766",
              toStationId: "003589",
              direction: null,
              blockId: "jr-sobu-rapid/b1",
            },
          ],
        },
      ],
      GEOMETRIES,
      597,
    );
    /* 船橋→千葉 plus the block's 東京→船橋： the whole
       東京→千葉 range. */
    expect(coverage.perService.get("jr-sobu-rapid")!.riddenKm).toBeGreaterThan(35);
  });
});

describe("ghostLineLegs: the 路線 tab's ghost, edge by edge (subtask 1456, review round 1)", () => {
  const YAMA_KEY = "山手線|東日本旅客鉄道";
  const TOHOKU_KEY = "東北線|東日本旅客鉄道";
  const TOKAIDO_KEY = "東海道線|東日本旅客鉄道";
  const KEIO_KEY = "京王線|京王電鉄";
  const CHUO_KEY = "中央線|東日本旅客鉄道";
  const AKABANE_KEY = "赤羽線|東日本旅客鉄道";
  const MUSA_KEY = "武蔵野線|東日本旅客鉄道";

  function coverageFor(
    intervals: ReadonlyMap<string, readonly RideInterval[]>,
    full: ReadonlySet<string>,
  ) {
    const ids = new Set<string>([...intervals.keys(), ...full]);
    const paths = new Map([...ids].map((id) => [id, servicePath(id)]));
    return computeLineCoverage(intervals, full, paths, GEOMETRIES, 597);
  }

  /* Ghost kilometres on one formal-line key — the remainder of
     the shape, measured on the legs themselves. */
  function ghostKm(
    coverage: ReturnType<typeof computeLineCoverage>,
    key: string,
  ): number {
    const legs = ghostLineLegs(coverage, GEOMETRIES).get(key);
    return legs ? legs.reduce((sum, leg) => sum + leg.lengthKm, 0) : 0;
  }

  /* Bounding box of the ghost legs on a key, so a test can say
     WHERE the remainder is, not just how long it is. */
  function ghostBounds(
    coverage: ReturnType<typeof computeLineCoverage>,
    key: string,
  ): { minLng: number; maxLng: number; minLat: number; maxLat: number } | null {
    const legs = ghostLineLegs(coverage, GEOMETRIES).get(key);
    if (!legs || legs.length === 0) return null;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const leg of legs) {
      for (const [lng, lat] of leg.coords) {
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    }
    return { minLng, maxLng, minLat, maxLat };
  }

  test("a partially ridden Yamanote keeps the rest of the loop as ghost", () => {
    /* The bug: any leg on the 山手線 key excluded the whole key
       from the ghost, so after the 新宿〜大崎 ride the unridden
       arcs of the loop showed nothing and the loop read as
       gapped. A partial ride paints 8.58 of the key's 23.46 km
       shape; the remaining 14.88 km stays as ghost, all the way
       round the north side (past 池袋, 35.73) to 大崎. */
    const coverage = coverageFor(
      new Map([
        [
          "yamanote",
          [
            {
              serviceId: "yamanote",
              from: S.新宿,
              to: S.大崎,
              direction: "inner" as const,
            },
          ],
        ],
      ]),
      new Set(),
    );
    expect(coverage.perKeyKm.get(YAMA_KEY)).toBeCloseTo(8.58, 1);
    expect(ghostKm(coverage, YAMA_KEY)).toBeCloseTo(14.88, 1);
    expect(ghostBounds(coverage, YAMA_KEY)!.maxLat).toBeGreaterThan(35.72);
  });

  test("a full Yamanote lap leaves only the shape's off-spine remainder", () => {
    /* A lap paints the whole loop, so the ghost shrinks to the
       pieces the shortest path never takes — short bits at
       junctions and station throats, 2.88 km in all. The
       東北線 / 東海道線 keys the loop also runs on keep almost
       their whole shapes (the lap paints only short stretches
       of them). */
    const coverage = coverageFor(new Map(), new Set(["yamanote"]));
    expect(ghostKm(coverage, YAMA_KEY)).toBeCloseTo(2.88, 1);
    expect(ghostKm(coverage, TOHOKU_KEY)).toBeCloseTo(597.3, 0);
    expect(ghostKm(coverage, TOKAIDO_KEY)).toBeCloseTo(160.0, 0);
  });

  test("a full Saikyo ride does not kill the Yamanote ghost", () => {
    /* 埼京線 shares the 山手線 key but runs only part of it
       (大崎〜池袋, 13.18 of 23.46 km): completing the service
       must not clear the key — the per-service `complete`
       flag would have done exactly that. */
    const coverage = coverageFor(new Map(), new Set(["jr-saikyo"]));
    expect(coverage.perKeyKm.get(YAMA_KEY)).toBeCloseTo(13.18, 1);
    expect(ghostKm(coverage, YAMA_KEY)).toBeCloseTo(10.27, 1);
    /* The same ride DOES paint the 赤羽線 key's spine end to
       end (池袋〜赤羽), so only the shape's off-spine slivers
       at the two ends remain — 0.57 km, not the whole line. */
    expect(ghostKm(coverage, AKABANE_KEY)).toBeCloseTo(0.57, 1);
  });

  test("a full Keio ride leaves the 京王新線 branch as ghost", () => {
    /* 新宿〜京王八王子 paints 37.65 km; the 京王線 key's shape
       still holds the 京王新線 side （笹塚〜新宿, about
       2.8 km) unpainted, so the ghost stays — reaching the
       新宿 side (lng 139.6993, next to 新宿 139.69993). */
    const coverage = coverageFor(new Map(), new Set(["keio"]));
    expect(ghostKm(coverage, KEIO_KEY)).toBeCloseTo(2.93, 1);
    expect(ghostBounds(coverage, KEIO_KEY)!.maxLng).toBeGreaterThan(139.69);
  });

  test("a partial Keio ride keeps the rest of the line as ghost", () => {
    /* 府中→聖蹟桜ヶ丘 paints only 4.40 km of the 京王線
       key's 40.58 km shape; the rest stays as ghost. */
    const coverage = coverageFor(
      new Map([
        [
          "keio",
          [
            {
              serviceId: "keio",
              from: S.府中,
              to: S.聖蹟桜ヶ丘,
              direction: null,
            },
          ],
        ],
      ]),
      new Set(),
    );
    expect(coverage.perKeyKm.get(KEIO_KEY)).toBeCloseTo(4.4, 1);
    expect(ghostKm(coverage, KEIO_KEY)).toBeCloseTo(36.18, 1);
  });

  test("one unridden block leaves exactly that block's shape as ghost", () => {
    /* 新宿→府中 (blocks b1+b2) leaves b3 （府中→京王八王子)
       unridden: the ghost is b3's shape plus the 京王新線
       branch and the endpoint slivers, 18.92 km — and it
       reaches the 京王八王子 end (lng 139.3425, next to
       京王八王子 139.34298). */
    const coverage = coverageFor(
      new Map([
        [
          "keio",
          [
            {
              serviceId: "keio",
              from: S.新宿,
              to: S.府中,
              direction: null,
            },
          ],
        ],
      ]),
      new Set(),
    );
    expect(ghostKm(coverage, KEIO_KEY)).toBeCloseTo(18.92, 1);
    expect(ghostBounds(coverage, KEIO_KEY)!.minLng).toBeLessThan(139.35);
  });

  test("a full Musashino ride leaves the 大宮 branch as ghost", () => {
    /* 府中本町〜西船橋 paints 71.78 km; the 武蔵野線 key's
       shape still holds the unridden branch toward 大宮
       (4.58 km: the 4.40 km leg up from 西浦和 plus the
       0.18 km tip) and small off-spine bits, 5.45 km in all.
       The ghost reaches north to lat 35.8851, toward 大宮
       (35.90653). */
    const coverage = coverageFor(new Map(), new Set(["jr-musashino"]));
    expect(ghostKm(coverage, MUSA_KEY)).toBeCloseTo(5.45, 1);
    expect(ghostBounds(coverage, MUSA_KEY)!.maxLat).toBeGreaterThan(35.88);
  });

  test("a complete service covering only part of its line keeps the ghost", () => {
    /* 中央線（快速） complete is 東京〜高尾, 51.77 of the
       中央線 key's 273.05 km shape — the line is far from
       fully painted even though the service is complete. */
    const coverage = coverageFor(new Map(), new Set(["jr-chuo-rapid"]));
    expect(coverage.perService.get("jr-chuo-rapid")!.complete).toBe(true);
    expect(ghostKm(coverage, CHUO_KEY)).toBeCloseTo(221.28, 1);
  });

  test("an unknown ride leaves the whole shape as ghost", () => {
    /* A row with no section paints its whole path thin and
       counts zero kilometres: nothing is subtracted, so the
       ghost is the key's whole 23.46 km shape. */
    const paths = new Map([["yamanote", servicePath("yamanote")]]);
    const coverage = computeLineCoverage(
      new Map(),
      new Set(),
      paths,
      GEOMETRIES,
      597,
    );
    expect(coverage.perServiceLegs.get("yamanote")!.unknown).toBe(true);
    expect(coverage.perKeyKm.has(YAMA_KEY)).toBe(false);
    expect(ghostKm(coverage, YAMA_KEY)).toBeCloseTo(23.46, 1);
  });
});
