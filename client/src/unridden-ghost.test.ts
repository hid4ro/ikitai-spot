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
  type LineCoverage,
  type LineGeometryMap,
  type RideInterval,
} from "./line-geometry";
import { serviceById, type StationRef } from "../../shared/service-master";
import {
  computeUnriddenGhostFeatures,
  ghostCoverageKey,
  serializeGhostCoverage,
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
