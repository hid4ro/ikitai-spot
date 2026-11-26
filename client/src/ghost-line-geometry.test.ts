/* Regression tests for the ghost-only coarse geometry (subtask
   1457, plan A). Run with: bun test
   client/src/ghost-line-geometry.test.ts
   Two halves: synthetic shapes pin the chaining and the
   Douglas–Peucker bound, and the real bundled asset pins the
   reduction the user actually gets — so a geometry regression
   shows up as a wrong point count, not a wrong map. */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import type { GeoJsonLineGeometry } from "./geojson";
import {
  GHOST_SIMPLIFY_TOLERANCE_M,
  clearGhostLineGeometryCache,
  countGeometryPoints,
  getGhostLineGeometry,
  simplifyGhostGeometry,
  simplifyPolyline,
} from "./ghost-line-geometry";

type Pt = [number, number];

function geometry(pieces: Pt[][]): GeoJsonLineGeometry {
  return { type: "MultiLineString", coordinates: pieces };
}

/* Perpendicular distance in equirectangular metres, the same
   approximation the module uses. */
function distanceToPolylineM(p: Pt, line: Pt[]): number {
  const kx = 111320 * Math.cos(((p[1] * Math.PI) / 180));
  const ky = 110540;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ax = (p[0] - a[0]) * kx;
    const ay = (p[1] - a[1]) * ky;
    const bx = (b[0] - a[0]) * kx;
    const by = (b[1] - a[1]) * ky;
    const len2 = bx * bx + by * by;
    if (len2 === 0) {
      best = Math.min(best, Math.hypot(ax, ay));
      continue;
    }
    let t = (ax * bx + ay * by) / len2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(ax - t * bx, ay - t * by));
  }
  return best;
}

describe("simplifyPolyline", () => {
  test("a straight run collapses to its endpoints", () => {
    const line: Pt[] = [
      [139.0, 35.0],
      [139.001, 35.0],
      [139.002, 35.0],
      [139.003, 35.0],
    ];
    expect(simplifyPolyline(line, 100)).toEqual([
      [139.0, 35.0],
      [139.003, 35.0],
    ]);
  });

  test("a sharp corner survives, a gentle bend does not", () => {
    /* A right angle: the corner is ~700 m off the chord, so it
       stays; a shallow kink 30 m off the chord goes. */
    const corner: Pt[] = [
      [139.0, 35.0],
      [139.01, 35.0],
      [139.01, 35.01],
    ];
    expect(simplifyPolyline(corner, 100)).toEqual(corner);
    const kink: Pt[] = [
      [139.0, 35.0],
      [139.005, 35.0003],
      [139.01, 35.0],
    ];
    expect(simplifyPolyline(kink, 100)).toEqual([
      [139.0, 35.0],
      [139.01, 35.0],
    ]);
  });

  test("two points and one point come back unchanged", () => {
    expect(
      simplifyPolyline(
        [
          [139.0, 35.0],
          [139.01, 35.0],
        ],
        100,
      ),
    ).toEqual([
      [139.0, 35.0],
      [139.01, 35.0],
    ]);
    expect(simplifyPolyline([[139.0, 35.0]], 100)).toEqual([[139.0, 35.0]]);
  });

  test("the input is not mutated", () => {
    const line: Pt[] = [
      [139.0, 35.0],
      [139.001, 35.0],
      [139.002, 35.0],
    ];
    const snapshot: Pt[] = line.map((p) => [p[0], p[1]]);
    simplifyPolyline(line, 100);
    expect(line).toEqual(snapshot);
  });
});

describe("simplifyGhostGeometry on synthetic shapes", () => {
  test("chained two-point pieces collapse into one run", () => {
    /* The asset's common case: a straight track stored as short
       2-point pieces. Chaining joins them, DP drops the joints. */
    const g = geometry([
      [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
      [
        [139.001, 35.0],
        [139.002, 35.0],
      ],
      [
        [139.002, 35.0],
        [139.003, 35.0],
      ],
    ]);
    expect(simplifyGhostGeometry(g, 100)).toEqual({
      type: "MultiLineString",
      coordinates: [
        [
          [139.0, 35.0],
          [139.003, 35.0],
        ],
      ],
    });
  });

  test("pieces in no order still chain", () => {
    const g = geometry([
      [
        [139.002, 35.0],
        [139.003, 35.0],
      ],
      [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
      [
        [139.001, 35.0],
        [139.002, 35.0],
      ],
    ]);
    const coarse = simplifyGhostGeometry(g, 100);
    expect(coarse.coordinates).toEqual([
      [
        [139.0, 35.0],
        [139.003, 35.0],
      ],
    ]);
  });

  test("a branch at a junction keeps all three arms", () => {
    /* A T: the main line runs east–west, a spur leaves the
       middle north. Every arm must survive as a run. */
    const g = geometry([
      [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
      [
        [139.001, 35.0],
        [139.002, 35.0],
      ],
      [
        [139.001, 35.0],
        [139.001, 35.001],
      ],
    ]);
    const coarse = simplifyGhostGeometry(g, 100);
    const covered = new Set<string>();
    for (const run of coarse.coordinates) {
      for (const p of run) covered.add(`${p[0]},${p[1]}`);
    }
    for (const end of ["139,35", "139.002,35", "139.001,35.001"]) {
      expect(covered.has(end)).toBe(true);
    }
    /* The junction itself is a chain endpoint somewhere. */
    expect(covered.has("139.001,35")).toBe(true);
  });

  test("a closed loop stays closed", () => {
    /* Sides of ~1.1 km, so every corner sits ~780 m off the
       diagonal chord and survives the 100 m tolerance. */
    const g = geometry([
      [
        [139.0, 35.0],
        [139.01, 35.0],
      ],
      [
        [139.01, 35.0],
        [139.01, 35.01],
      ],
      [
        [139.01, 35.01],
        [139.0, 35.01],
      ],
      [
        [139.0, 35.01],
        [139.0, 35.0],
      ],
    ]);
    const coarse = simplifyGhostGeometry(g, 100);
    expect(coarse.coordinates).toHaveLength(1);
    const run = coarse.coordinates[0]!;
    expect(run[0]).toEqual(run[run.length - 1]);
    expect(run).toHaveLength(5);
  });

  test("an empty geometry stays empty", () => {
    expect(simplifyGhostGeometry(geometry([]), 100)).toEqual({
      type: "MultiLineString",
      coordinates: [],
    });
  });

  test("a single short piece is untouched", () => {
    const g = geometry([
      [
        [139.0, 35.0],
        [139.001, 35.001],
      ],
    ]);
    expect(simplifyGhostGeometry(g, 100)).toEqual(g);
  });
});

describe("getGhostLineGeometry cache", () => {
  test("the same key returns the same object, and clearing rebuilds", () => {
    clearGhostLineGeometryCache();
    const g = geometry([
      [
        [139.0, 35.0],
        [139.001, 35.0],
      ],
      [
        [139.001, 35.0],
        [139.002, 35.0],
      ],
    ]);
    const first = getGhostLineGeometry("test-line|test", g);
    const second = getGhostLineGeometry("test-line|test", g);
    expect(second).toBe(first);
    clearGhostLineGeometryCache();
    const third = getGhostLineGeometry("test-line|test", g);
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
    clearGhostLineGeometryCache();
  });
});

describe("real asset: the ghost actually gets lighter", () => {
  test("the coarse asset keeps about a third of the points", () => {
    clearGhostLineGeometryCache();
    let before = 0;
    let after = 0;
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      before += countGeometryPoints(entry.geometry);
      after += countGeometryPoints(getGhostLineGeometry(key, entry.geometry));
    }
    /* Measured 63,355 → 20,873 (32.9% kept) at the 100 m
       tolerance; the band leaves room for asset drift without
       hiding a regression that stops simplifying. */
    expect(before).toBe(63355);
    expect(after / before).toBeLessThan(0.4);
    expect(after / before).toBeGreaterThan(0.2);
    clearGhostLineGeometryCache();
  });

  test("every original vertex stays within the tolerance", () => {
    clearGhostLineGeometryCache();
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      const coarse = getGhostLineGeometry(key, entry.geometry);
      const runs = coarse.coordinates as Pt[][];
      for (const piece of entry.geometry.coordinates) {
        for (const p of piece as Pt[]) {
          let nearest = Infinity;
          for (const run of runs) {
            nearest = Math.min(nearest, distanceToPolylineM(p, run));
          }
          expect(nearest).toBeLessThanOrEqual(
            GHOST_SIMPLIFY_TOLERANCE_M + 1,
          );
        }
      }
    }
    clearGhostLineGeometryCache();
  });

  test("simplification never invents endpoints", () => {
    clearGhostLineGeometryCache();
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      const coarse = getGhostLineGeometry(key, entry.geometry);
      const original = new Set<string>();
      for (const piece of entry.geometry.coordinates) {
        for (const p of piece) original.add(`${p[0]},${p[1]}`);
      }
      /* Every run endpoint is a vertex of the original shape —
         DP only drops vertices, it never creates new ones — so
         the coarse shape meets the network at real junctions. */
      for (const run of coarse.coordinates) {
        expect(original.has(`${run[0]![0]},${run[0]![1]}`)).toBe(true);
        const last = run[run.length - 1]!;
        expect(original.has(`${last[0]},${last[1]}`)).toBe(true);
      }
    }
    clearGhostLineGeometryCache();
  });
});
