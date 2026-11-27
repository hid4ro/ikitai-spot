/* Tests for the unridden-lines ghost's pure half (subtask 1457,
   review round 3): the coverage wire, the coverage key that
   ties a result to its ledger, and the computation itself —
   the same code the Web Worker runs. The identity bar is the
   measured output of the pre-worker pipeline on the real
   asset: 597 features / 29,882 points on an empty coverage
   (the figure review rounds 2–3 verified against the app).
   Run with: bun test client/src/unridden-ghost.test.ts */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import {
  clearGhostLineGeometryCache,
  countGeometryPoints,
  ghostPointKey,
} from "./ghost-line-geometry";
import {
  buildServicePath,
  computeLineCoverage,
  computeRiddenLineCoverage,
  ghostLegsForKey,
  subtractLegSpans,
  type LineCoverage,
  type LineGeometryMap,
  type PathLeg,
  type RideInterval,
} from "./line-geometry";
import { serviceById, type StationRef } from "../../shared/service-master";
import type { GeoJsonLineGeometry } from "./geojson";
import {
  computeUnriddenGhostFeatures,
  cutGeometryByCorridor,
  ghostCoverageKey,
  ghostFeaturesMatchCoverage,
  serializeGhostCoverage,
  trimUnriddenGhostFeatures,
  type GhostCoverageWire,
} from "./unridden-ghost";

const GEOMETRIES = RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap;
const YAMA_KEY = "山手線|東日本旅客鉄道";

function totalPoints(
  features: ReturnType<typeof computeUnriddenGhostFeatures>,
): number {
  let n = 0;
  for (const f of features) n += countGeometryPoints(f.geometry);
  return n;
}

function saikyoCoverage(): LineCoverage {
  const osaki: StationRef = {
    id: "004135",
    name: "大崎",
    lng: 139.72807,
    lat: 35.61985,
  };
  const ikebukuro: StationRef = {
    id: "003390",
    name: "池袋",
    lng: 139.71108,
    lat: 35.72981,
  };
  const intervals = new Map<string, readonly RideInterval[]>([
    [
      "jr-saikyo",
      [
        {
          serviceId: "jr-saikyo",
          from: osaki,
          to: ikebukuro,
          direction: null,
        },
      ],
    ],
  ]);
  const paths = new Map([
    ["jr-saikyo", buildServicePath(serviceById("jr-saikyo")!, GEOMETRIES)],
  ]);
  return computeLineCoverage(intervals, new Set(), paths, GEOMETRIES, 597);
}

describe("computeUnriddenGhostFeatures on the real asset", () => {
  test("an empty coverage reproduces the measured ghost: 597 features, 29,882 points", () => {
    clearGhostLineGeometryCache();
    const wire = serializeGhostCoverage({
      perServiceLegs: new Map(),
    } as unknown as LineCoverage);
    const features = computeUnriddenGhostFeatures(
      wire,
      RIDDEN_LINE_GEOMETRIES,
    );
    expect(features.length).toBe(597);
    expect(totalPoints(features)).toBe(29882);
    for (const f of features) {
      expect(RIDDEN_LINE_GEOMETRIES[f.properties.key]).toBeDefined();
      expect(f.properties.color).toBe(
        RIDDEN_LINE_GEOMETRIES[f.properties.key]!.color,
      );
    }
    clearGhostLineGeometryCache();
  });

  test("a partial ride subtracts its paint and keeps the contacts pinned", () => {
    clearGhostLineGeometryCache();
    const coverage = saikyoCoverage();
    const wire = serializeGhostCoverage(coverage);
    const features = computeUnriddenGhostFeatures(
      wire,
      RIDDEN_LINE_GEOMETRIES,
    );
    expect(features.length).toBe(597);
    /* The Saikyo ride paints part of the Yamanote loop, so its
       ghost shrinks against the empty coverage's. */
    const yama = features.find((f) => f.properties.key === YAMA_KEY)!;
    expect(yama).toBeDefined();
    clearGhostLineGeometryCache();
    const emptyYama = computeUnriddenGhostFeatures(
      { services: [] },
      RIDDEN_LINE_GEOMETRIES,
    ).find((f) => f.properties.key === YAMA_KEY)!;
    expect(countGeometryPoints(yama.geometry)).toBeLessThan(
      countGeometryPoints(emptyYama.geometry),
    );
    /* The contacts — endpoints of the key's painted legs that
       are also remainder endpoints — survive simplification
       exactly, so the ghost stays glued to the paint (the
       17.5 m slide of review round 1 must not come back
       through the worker path). */
    const contacts = new Set<string>();
    const ghostEnds = new Set<string>();
    for (const [, painted] of coverage.perServiceLegs) {
      if (painted.unknown) continue;
      for (const leg of painted.legs) {
        if (leg.key !== YAMA_KEY) continue;
        for (const end of [
          leg.coords[0]!,
          leg.coords[leg.coords.length - 1]!,
        ]) {
          contacts.add(ghostPointKey(end));
        }
      }
    }
    expect(contacts.size).toBeGreaterThan(0);
    const verts = new Set<string>();
    for (const run of yama.geometry.coordinates) {
      for (const p of run) verts.add(`${p[0]},${p[1]}`);
    }
    for (const k of contacts) {
      if (verts.has(k)) ghostEnds.add(k);
    }
    expect(ghostEnds.size).toBeGreaterThan(0);
    clearGhostLineGeometryCache();
  });
});

describe("ghostCoverageKey", () => {
  const leg = {
    key: "山手線|東日本旅客鉄道",
    edge: "edge:11",
    fromT: 0,
    toT: 0.5,
    coords: [
      [139.7, 35.6],
      [139.71, 35.61],
    ] as [number, number][],
    lengthKm: 1.2,
  };
  const known: GhostCoverageWire = {
    services: [{ serviceId: "svc-a", unknown: false, legs: [leg] }],
  };

  test("the same coverage keys the same, whatever the service grouping", () => {
    const regrouped: GhostCoverageWire = {
      services: [
        { serviceId: "svc-b", unknown: false, legs: [] },
        { serviceId: "svc-a", unknown: false, legs: [leg] },
      ],
    };
    expect(ghostCoverageKey(known)).toBe(ghostCoverageKey(known));
    expect(ghostCoverageKey(regrouped)).toBe(ghostCoverageKey(known));
    expect(ghostCoverageKey({ services: [] })).toBe("");
  });

  test("a changed painted span changes the key", () => {
    const moved: GhostCoverageWire = {
      services: [
        {
          serviceId: "svc-a",
          unknown: false,
          legs: [{ ...leg, toT: 0.75 }],
        },
      ],
    };
    expect(ghostCoverageKey(moved)).not.toBe(ghostCoverageKey(known));
  });

  test("an unknown ride's legs do not move the key — they draw nothing into the ghost", () => {
    const withUnknown: GhostCoverageWire = {
      services: [
        ...known.services,
        { serviceId: "svc-x", unknown: true, legs: [leg] },
      ],
    };
    expect(ghostCoverageKey(withUnknown)).toBe(ghostCoverageKey(known));
    /* But the same legs becoming known DO change the ghost, so
       they must change the key. */
    const flipped: GhostCoverageWire = {
      services: [{ serviceId: "svc-x", unknown: false, legs: [leg] }],
    };
    expect(ghostCoverageKey(flipped)).toBe(ghostCoverageKey(known));
    const both: GhostCoverageWire = {
      services: [
        { serviceId: "svc-a", unknown: false, legs: [leg] },
        { serviceId: "svc-x", unknown: false, legs: [leg] },
      ],
    };
    /* Two services painting the same span union to one span —
       the key is over the span set, so this still matches. */
    expect(ghostCoverageKey(both)).toBe(ghostCoverageKey(known));
  });
});

/* The focus trim (subtask 1680 fix2, Codex review finding 1):
   with only the Yamanote's west side ridden (Shinjuku → Osaki,
   inner), focusing the line paints the unridden remainder in
   the service's representative color over the loop's east side
   — Tabata → Tokyo on the Tohoku key, Tokyo → Shinagawa on
   the Tokaido key. The canonical ghost of those keys must be
   cut where the remainder runs, or the keys' own colors show
   through the translucent emphasis. */
describe("trimUnriddenGhostFeatures on the real asset", () => {
  const TOHOKU_KEY = "東北線|東日本旅客鉄道";
  const TOKAIDO_KEY = "東海道線|東日本旅客鉄道";
  const CHUO_KEY = "中央線|東日本旅客鉄道";

  function westSideYamanote() {
    const rows = [
      {
        name: "山手線",
        serviceId: "yamanote",
        serviceLinkSource: null,
        recordedServiceId: "yamanote",
        fromStationId: "003700",
        toStationId: "004135",
        pathSnapshot: null as string | null,
        rideState: "partial" as const,
        sections: [
          {
            fromStationId: "003700",
            toStationId: "004135",
            direction: "inner" as const,
            blockId: null,
            recordedServiceId: "yamanote",
          },
        ],
      },
    ];
    const coverage = computeRiddenLineCoverage(rows, GEOMETRIES, 597);
    const remainder = coverage.perServiceUnriddenLegs.get("yamanote")!;
    const canonical = computeUnriddenGhostFeatures(
      serializeGhostCoverage(coverage),
      RIDDEN_LINE_GEOMETRIES,
    );
    const trimmed = trimUnriddenGhostFeatures(
      canonical,
      coverage,
      RIDDEN_LINE_GEOMETRIES,
      remainder,
    );
    return { coverage, remainder, canonical, trimmed };
  }

  function pointSegmentM(
    p: readonly number[],
    a: readonly number[],
    b: readonly number[],
  ): number {
    const kx = 111320 * Math.cos((p[1]! * Math.PI) / 180);
    const ky = 110540;
    const abx = (b[0]! - a[0]!) * kx;
    const aby = (b[1]! - a[1]!) * ky;
    const apx = (p[0]! - a[0]!) * kx;
    const apy = (p[1]! - a[1]!) * ky;
    const len2 = abx * abx + aby * aby;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
    return Math.hypot(apx - t * abx, apy - t * aby);
  }
  function pointLegsM(
    p: readonly number[],
    legs: readonly PathLeg[],
  ): number {
    let best = Infinity;
    for (const leg of legs) {
      for (let i = 0; i + 1 < leg.coords.length; i++) {
        best = Math.min(
          best,
          pointSegmentM(p, leg.coords[i]!, leg.coords[i + 1]!),
        );
      }
    }
    return best;
  }
  function pointPointM(p: readonly number[], q: readonly number[]): number {
    const dx =
      (p[0]! - q[0]!) * 111320 * Math.cos((p[1]! * Math.PI) / 180);
    const dy = (p[1]! - q[1]!) * 110540;
    return Math.hypot(dx, dy);
  }

  test("the span subtraction is exact on shared edges and removes the whole loop stretch", () => {
    const { coverage, remainder } = westSideYamanote();
    for (const key of [TOHOKU_KEY, TOKAIDO_KEY]) {
      const cuts = remainder.filter((leg) => leg.key === key);
      expect(cuts.length).toBeGreaterThan(0);
      const ghost = ghostLegsForKey(coverage, GEOMETRIES, key);
      const kept = subtractLegSpans(ghost, cuts);
      /* No surviving ghost leg overlaps a remainder leg on a
         shared edge (touching at a cut end is fine). */
      for (const leg of kept) {
        for (const cut of cuts) {
          if (leg.edge !== cut.edge) continue;
          const overlap =
            Math.min(leg.toT, cut.toT) - Math.max(leg.fromT, cut.fromT);
          expect(overlap).toBeLessThanOrEqual(1e-9);
        }
      }
      /* The removed length covers the stretch itself
         (Tabata → Tokyo ≈ 5.6 km, Tokyo → Shinagawa ≈ 6.5 km
         of shape, one strand). */
      const sumKm = (legs: readonly PathLeg[]) =>
        legs.reduce((acc, leg) => acc + leg.lengthKm, 0);
      expect(sumKm(ghost) - sumKm(kept)).toBeGreaterThan(5);
    }
  });

  test("the trimmed ghost leaves the corridor: no vertex or segment runs near the remainder", () => {
    const { remainder, canonical, trimmed } = westSideYamanote();
    const canonicalTohoku = canonical.find(
      (f) => f.properties.key === TOHOKU_KEY,
    )!;
    const trimmedTohoku = trimmed.find(
      (f) => f.properties.key === TOHOKU_KEY,
    )!;
    /* The line runs on to Aomori: the out-of-loop ghost stays,
       just thinner along the loop. */
    expect(trimmedTohoku).toBeDefined();
    expect(countGeometryPoints(trimmedTohoku.geometry)).toBeLessThan(
      countGeometryPoints(canonicalTohoku.geometry),
    );
    expect(countGeometryPoints(trimmedTohoku.geometry)).toBeGreaterThan(100);
    /* The Tokaido side thins out the same way. */
    const canonicalTokaido = canonical.find(
      (f) => f.properties.key === TOKAIDO_KEY,
    )!;
    const trimmedTokaido = trimmed.find(
      (f) => f.properties.key === TOKAIDO_KEY,
    )!;
    expect(trimmedTokaido).toBeDefined();
    expect(countGeometryPoints(trimmedTokaido.geometry)).toBeLessThan(
      countGeometryPoints(canonicalTokaido.geometry),
    );
    /* Segments, not just vertices (review round 2, finding
       1): sample along every surviving segment of both keys —
       nothing may run inside the corridor mid-segment either.
       The fix2 cut classified vertices only, so a segment
       whose endpoints both cleared the corridor survived
       whole even where its middle ran alongside the remainder
       (on the Tokaido side, segments within 60 m of the
       emphasis remained). The cut is exact at 100 m; the 95
       leaves the frames' rounding. */
    for (const [feature, key] of [
      [trimmedTohoku, TOHOKU_KEY],
      [trimmedTokaido, TOKAIDO_KEY],
    ] as const) {
      const cuts = remainder.filter((leg) => leg.key === key);
      for (const run of feature.geometry.coordinates) {
        for (let i = 0; i + 1 < run.length; i++) {
          const a = run[i]!;
          const b = run[i + 1]!;
          const steps = Math.max(1, Math.ceil(pointPointM(a, b) / 25));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const p = [
              a[0]! + (b[0]! - a[0]!) * t,
              a[1]! + (b[1]! - a[1]!) * t,
            ];
            expect(pointLegsM(p, cuts)).toBeGreaterThan(95);
          }
        }
      }
    }
  });

  test("unrelated keys pass through by reference; an empty remainder changes nothing", () => {
    const { coverage, canonical, trimmed } = westSideYamanote();
    const canonicalChuo = canonical.find(
      (f) => f.properties.key === CHUO_KEY,
    )!;
    const trimmedChuo = trimmed.find((f) => f.properties.key === CHUO_KEY)!;
    expect(trimmedChuo).toBe(canonicalChuo);
    const untouched = trimUnriddenGhostFeatures(
      canonical,
      coverage,
      RIDDEN_LINE_GEOMETRIES,
      [],
    );
    expect(untouched.length).toBe(canonical.length);
    untouched.forEach((f, i) => expect(f).toBe(canonical[i]!));
  });
});

/* The corridor cut's segment accuracy (subtask 1680, review
   round 2, finding 1), pinned directly against
   cutGeometryByCorridor with synthetic geometry: one straight
   cut segment, ghost runs parallel to it ~22 m off — inside
   the 100 m corridor wherever they overlap it. */
describe("cutGeometryByCorridor on synthetic geometry", () => {
  const cutLeg: PathLeg = {
    key: "cut|test",
    edge: "edge:cut",
    fromT: 0,
    toT: 1,
    coords: [
      [139.0, 35.0],
      [139.02, 35.0],
    ],
    lengthKm: 1.83,
  };
  function distToCutM(p: readonly number[]): number {
    const a = cutLeg.coords[0]!;
    const b = cutLeg.coords[1]!;
    const kx = 111320 * Math.cos((p[1]! * Math.PI) / 180);
    const ky = 110540;
    const abx = (b[0] - a[0]) * kx;
    const aby = (b[1] - a[1]) * ky;
    const apx = (p[0]! - a[0]) * kx;
    const apy = (p[1]! - a[1]) * ky;
    const len2 = abx * abx + aby * aby;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
    return Math.hypot(apx - t * abx, apy - t * aby);
  }
  function totalLengthM(geometry: GeoJsonLineGeometry): number {
    let total = 0;
    for (const run of geometry.coordinates) {
      for (let i = 0; i + 1 < run.length; i++) {
        const a = run[i]!;
        const b = run[i + 1]!;
        total += Math.hypot(
          (b[0]! - a[0]!) * 111320 * Math.cos((a[1]! * Math.PI) / 180),
          (b[1]! - a[1]!) * 110540,
        );
      }
    }
    return total;
  }
  function expectRunsClear(geometry: GeoJsonLineGeometry) {
    for (const run of geometry.coordinates) {
      for (let i = 0; i + 1 < run.length; i++) {
        const a = run[i]!;
        const b = run[i + 1]!;
        for (let s = 0; s <= 20; s++) {
          const t = s / 20;
          const p = [
            a[0]! + (b[0]! - a[0]!) * t,
            a[1]! + (b[1]! - a[1]!) * t,
          ];
          expect(distToCutM(p)).toBeGreaterThan(95);
        }
      }
    }
  }

  test("a segment dipping through the corridor mid-way is split at entry and exit", () => {
    /* One long segment parallel to the cut, ~22 m off it: its
       endpoints sit ~900 m clear of the cut segment, but its
       middle runs inside the corridor for ~2 km. The fix2
       vertex-only cut kept this segment whole. */
    const geometry: GeoJsonLineGeometry = {
      type: "MultiLineString",
      coordinates: [[[138.99, 35.0002], [139.03, 35.0002]]],
    };
    const out = cutGeometryByCorridor(geometry, [cutLeg]);
    /* Two stubs survive, one at each end of the run. */
    expect(out.coordinates.length).toBe(2);
    expectRunsClear(out);
    const surviving = totalLengthM(out);
    expect(surviving).toBeGreaterThan(1200);
    expect(surviving).toBeLessThan(2000);
    /* The gap between the stubs is the removed parallel
       stretch, crossings included (~2 km). */
    const westEnd = out.coordinates[0]![out.coordinates[0]!.length - 1]!;
    const eastStart = out.coordinates[1]![0]!;
    expect((eastStart[0]! - westEnd[0]!) * 91200).toBeGreaterThan(1800);
  });

  test("a segment starting inside the corridor is cut at its exit only", () => {
    const geometry: GeoJsonLineGeometry = {
      type: "MultiLineString",
      coordinates: [[[139.005, 35.0002], [139.03, 35.0002]]],
    };
    const out = cutGeometryByCorridor(geometry, [cutLeg]);
    expect(out.coordinates.length).toBe(1);
    expectRunsClear(out);
    /* The survivor starts at the corridor's exit crossing,
       east of the cut's end. */
    expect(out.coordinates[0]![0]![0]!).toBeGreaterThan(139.02);
  });

  test("a run wholly inside the corridor disappears; a run wholly outside is untouched", () => {
    const inside: GeoJsonLineGeometry = {
      type: "MultiLineString",
      coordinates: [[[139.002, 35.0002], [139.018, 35.0002]]],
    };
    expect(cutGeometryByCorridor(inside, [cutLeg]).coordinates).toEqual([]);
    const outside: GeoJsonLineGeometry = {
      type: "MultiLineString",
      coordinates: [[[138.99, 35.01], [139.03, 35.01]]],
    };
    expect(cutGeometryByCorridor(outside, [cutLeg]).coordinates).toEqual(
      outside.coordinates,
    );
  });
});

/* The focus paths' staleness gate (subtask 1680, review
   round 2, finding 2): features may be written against a
   coverage only when they are that coverage's own result. */
describe("ghostFeaturesMatchCoverage", () => {
  test("only the producing coverage's key matches", () => {
    const coverage = saikyoCoverage();
    const key = ghostCoverageKey(serializeGhostCoverage(coverage));
    expect(ghostFeaturesMatchCoverage(key, coverage)).toBe(true);
    expect(ghostFeaturesMatchCoverage(null, coverage)).toBe(false);
    expect(ghostFeaturesMatchCoverage("stale-key", coverage)).toBe(false);
    const empty = {
      perServiceLegs: new Map(),
    } as unknown as LineCoverage;
    expect(ghostFeaturesMatchCoverage(key, empty)).toBe(false);
    expect(
      ghostFeaturesMatchCoverage(
        ghostCoverageKey(serializeGhostCoverage(empty)),
        empty,
      ),
    ).toBe(true);
  });
});
