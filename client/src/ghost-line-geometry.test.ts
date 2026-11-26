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
  ghostPointKey,
  simplifyGhostGeometry,
  simplifyGhostRemainder,
  simplifyPolyline,
  type GhostRemainderLeg,
} from "./ghost-line-geometry";
import {
  buildServicePath,
  computeLineCoverage,
  ghostLineLegs,
  type LineGeometryMap,
  type RideInterval,
} from "./line-geometry";
import { serviceById, type StationRef } from "../../shared/service-master";

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
  test("the coarse asset keeps under half of the points", () => {
    clearGhostLineGeometryCache();
    let before = 0;
    let after = 0;
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      before += countGeometryPoints(entry.geometry);
      after += countGeometryPoints(getGhostLineGeometry(key, entry.geometry));
    }
    /* Measured 63,355 → 29,872 (47.2% kept) at the spec's
       60 m tolerance, with junction pinning and the crossing
       reverts on top of DP (DP alone at 60 m keeps 26,237,
       41.4% — the first cut's 100 m kept 20,873, 32.9%). The
       band leaves room for asset drift without hiding a
       regression that stops simplifying. */
    expect(before).toBe(63355);
    expect(after / before).toBeLessThan(0.5);
    expect(after / before).toBeGreaterThan(0.35);
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

/* ------------------------------------------------------------------ */
/* Review round 1 regressions: pinned junctions and contacts, and    */
/* no invented crossings. The first cut chained pieces and ran DP    */
/* over the whole run, so a vertex the run merely passed through —   */
/* a branch junction, a point shared with the solid paint — could    */
/* be dropped, and a chord could cut across a neighbouring strand.   */
/* ------------------------------------------------------------------ */

/* Metres east/north of (139, 35) as a coordinate — the synthetic
   shapes below are drawn in metres so the geometry is readable;
   1 m ≈ 1/91190° lng and 1/110540° lat at latitude 35. */
const M = (x: number, y: number): Pt => [139 + x / 91190, 35 + y / 110540];

function orientSign(a: Pt, b: Pt, c: Pt): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function properlyCrosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orientSign(a, b, c);
  const o2 = orientSign(a, b, d);
  const o3 = orientSign(c, d, a);
  const o4 = orientSign(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/* Every proper crossing point between non-adjacent segments of
   a geometry, as [lng, lat]. */
function crossingPoints(coords: number[][][]): Pt[] {
  const segs: { a: Pt; b: Pt; run: number; idx: number }[] = [];
  coords.forEach((run, r) => {
    for (let i = 0; i < run.length - 1; i++) {
      segs.push({ a: run[i] as Pt, b: run[i + 1] as Pt, run: r, idx: i });
    }
  });
  const out: Pt[] = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]!;
      const t = segs[j]!;
      if (s.run === t.run && Math.abs(s.idx - t.idx) <= 1) continue;
      if (!properlyCrosses(s.a, s.b, t.a, t.b)) continue;
      /* Line–line intersection of s and t. */
      const d =
        (s.b[0] - s.a[0]) * (t.b[1] - t.a[1]) -
        (s.b[1] - s.a[1]) * (t.b[0] - t.a[0]);
      const u =
        ((t.a[0] - s.a[0]) * (t.b[1] - t.a[1]) -
          (t.a[1] - s.a[1]) * (t.b[0] - t.a[0])) /
        d;
      out.push([
        s.a[0] + u * (s.b[0] - s.a[0]),
        s.a[1] + u * (s.b[1] - s.a[1]),
      ]);
    }
  }
  return out;
}

describe("pinned junctions and contacts (review round 1)", () => {
  test("a branch on a curved main line stays connected", () => {
    /* The main line bows gently through the junction J (35 m
       off the end-to-end chord — inside the 60 m tolerance, so
       unpinned DP drops J and the branch ends 35 m from the
       drawn main line). The old branch test used a STRAIGHT
       main line, where the dropped junction still lies on the
       chord and nothing reads as detached. */
    const J = M(800, 35);
    const g = geometry([
      [M(0, 0), M(400, 10), J],
      [J, M(1200, 10), M(1600, 0)],
      [J, M(800, 300)],
    ]);
    const coarse = simplifyGhostGeometry(g, 60);
    /* The main run (the one holding both ends of the main line)
       keeps J as an exact vertex, so the branch — its own run
       ending at J — meets it there. */
    const main = coarse.coordinates.find(
      (run) =>
        run.some((p) => p[0] === M(0, 0)[0] && p[1] === M(0, 0)[1]) &&
        run.some((p) => p[0] === M(1600, 0)[0] && p[1] === M(1600, 0)[1]),
    );
    expect(main).toBeDefined();
    expect(main!.some((p) => p[0] === J[0] && p[1] === J[1])).toBe(true);
    expect(distanceToPolylineM(J, main! as Pt[])).toBe(0);
  });

  test("a caller-protected point survives; unprotected it is dropped", () => {
    /* A gentle wave: every interior vertex sits within 20 m of
       the end-to-end chord, so DP drops them all — including Q,
       the middle one, unless the caller protects it (the paint
       contact case). */
    const Q = M(800, 20);
    const g = geometry([[M(0, 0), M(400, 8), Q, M(1200, 8), M(1600, 0)]]);
    const bare = simplifyGhostGeometry(g, 60);
    expect(
      bare.coordinates[0]!.some((p) => p[0] === Q[0] && p[1] === Q[1]),
    ).toBe(false);
    const pinned = simplifyGhostGeometry(g, 60, new Set([ghostPointKey(Q)]));
    expect(
      pinned.coordinates[0]!.some((p) => p[0] === Q[0] && p[1] === Q[1]),
    ).toBe(true);
  });

  test("a chord that would cross a neighbouring strand keeps the original points", () => {
    /* Run 1 bows from A through P to B; its end-to-end chord
       cuts across run 2's straight strand, which the original
       polyline passes just beyond the end of (the P→B leg
       crosses run 2's LINE at x ≈ 1005 m, past D at 1000 m, so
       the originals never cross). Unpinned, unguarded DP draws
       the chord and invents the crossing. */
    const A = M(-800, 60);
    const P = M(500, 25);
    const B = M(1800, -60);
    const g = geometry([
      [A, P, B],
      [M(0, -8), M(1000, -8)],
    ]);
    expect(crossingPoints(g.coordinates)).toHaveLength(0);
    const coarse = simplifyGhostGeometry(g, 60);
    expect(crossingPoints(coarse.coordinates)).toHaveLength(0);
    /* The crossing span fell back to the original shape: P is
       still a vertex of run 1. */
    const run1 = coarse.coordinates.find((run) =>
      run.some((p) => p[0] === A[0] && p[1] === A[1]),
    );
    expect(run1).toBeDefined();
    expect(run1!.some((p) => p[0] === P[0] && p[1] === P[1])).toBe(true);
  });
});

describe("simplifyGhostRemainder memo (review round 1)", () => {
  const leg = (toT: number, coords: Pt[]): GhostRemainderLeg => ({
    edge: "edge:1",
    fromT: 0,
    toT,
    coords,
  });

  test("an unchanged remainder returns the cached object; a changed one recomputes", () => {
    clearGhostLineGeometryCache();
    const straight: Pt[] = [M(0, 0), M(400, 8), M(800, 20), M(1600, 0)];
    const first = simplifyGhostRemainder("memo-test|x", [leg(1, straight)]);
    const second = simplifyGhostRemainder("memo-test|x", [leg(1, straight)]);
    expect(second).toBe(first);
    /* Same coordinates but a different span fingerprint — the
       coverage moved — must not serve the stale simplification. */
    const changed = simplifyGhostRemainder("memo-test|x", [
      leg(0.5, straight),
    ]);
    expect(changed).not.toBe(first);
    clearGhostLineGeometryCache();
  });
});

describe("real asset: junctions and crossings survive (review round 1)", () => {
  test("every junction of every line stays a vertex of its coarse shape", () => {
    clearGhostLineGeometryCache();
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      /* Junctions by the module's degree rule: 1 per piece end,
         2 per interior pass, degree ≥ 3 branches. */
      const degree = new Map<string, number>();
      for (const piece of entry.geometry.coordinates) {
        piece.forEach((p, i) => {
          const w = i === 0 || i === piece.length - 1 ? 1 : 2;
          const k = `${p[0]},${p[1]}`;
          degree.set(k, (degree.get(k) ?? 0) + w);
        });
      }
      const coarse = getGhostLineGeometry(key, entry.geometry);
      const verts = new Set<string>();
      for (const run of coarse.coordinates) {
        for (const p of run) verts.add(`${p[0]},${p[1]}`);
      }
      for (const [k, d] of degree) {
        if (d >= 3) expect(verts.has(k)).toBe(true);
      }
    }
    clearGhostLineGeometryCache();
  });

  test("simplification invents no crossings on any line", () => {
    clearGhostLineGeometryCache();
    for (const [key, entry] of Object.entries(RIDDEN_LINE_GEOMETRIES)) {
      const origPts = crossingPoints(entry.geometry.coordinates);
      const coarse = getGhostLineGeometry(key, entry.geometry);
      const simpPts = crossingPoints(coarse.coordinates);
      /* Every crossing the coarse shape draws must sit where
         the original already crosses (within twice the
         tolerance — a kept crossing's chords stay within one
         tolerance of the strands that cross). A line whose
         original has no crossings at all must gain none. */
      if (origPts.length === 0) {
        expect(simpPts).toHaveLength(0);
        continue;
      }
      for (const p of simpPts) {
        let nearest = Infinity;
        for (const q of origPts) {
          nearest = Math.min(nearest, distanceToPolylineM(p, [q, q]));
        }
        expect(nearest).toBeLessThanOrEqual(
          2 * GHOST_SIMPLIFY_TOLERANCE_M + 1,
        );
      }
      /* 鹿児島線 is the review's example: the original crosses
         nowhere, and the first cut's simplification invented
         three crossings. */
      if (key.startsWith("鹿児島線")) {
        expect(origPts).toHaveLength(0);
        expect(simpPts).toHaveLength(0);
      }
    }
    clearGhostLineGeometryCache();
  });
});

describe("subtraction → simplification, as App.tsx runs it (review round 1)", () => {
  test("a Saikyo partial ride keeps every paint contact on the Yamanote ghost", () => {
    clearGhostLineGeometryCache();
    const GEOMETRIES = RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap;
    const YAMA_KEY = "山手線|東日本旅客鉄道";
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
    const coverage = computeLineCoverage(
      intervals,
      new Set(),
      paths,
      GEOMETRIES,
      597,
    );
    /* The contacts, exactly as App.tsx collects them: endpoints
       of the key's painted legs. */
    const contacts = new Set<string>();
    for (const [, painted] of coverage.perServiceLegs) {
      if (painted.unknown) continue;
      for (const paintLeg of painted.legs) {
        if (paintLeg.key !== YAMA_KEY) continue;
        for (const end of [
          paintLeg.coords[0]!,
          paintLeg.coords[paintLeg.coords.length - 1]!,
        ]) {
          contacts.add(ghostPointKey(end));
        }
      }
    }
    const legs = ghostLineLegs(coverage, GEOMETRIES).get(YAMA_KEY) ?? [];
    expect(legs.length).toBeGreaterThan(0);
    /* The shared points: contacts that are also remainder-leg
       endpoints — the spots where ghost meets paint. The first
       cut dropped one of them mid-run and the ghost slid
       17.5 m off the paint (measured on this very fixture). */
    const ghostEnds = new Set<string>();
    for (const ghostLeg of legs) {
      for (const end of [
        ghostLeg.coords[0]!,
        ghostLeg.coords[ghostLeg.coords.length - 1]!,
      ]) {
        ghostEnds.add(ghostPointKey(end));
      }
    }
    const shared = [...contacts].filter((k) => ghostEnds.has(k));
    expect(shared.length).toBeGreaterThan(0);
    const coarse = simplifyGhostRemainder(YAMA_KEY, legs, contacts);
    const verts = new Set<string>();
    for (const run of coarse.coordinates) {
      for (const p of run) verts.add(`${p[0]},${p[1]}`);
    }
    for (const k of shared) expect(verts.has(k)).toBe(true);
    clearGhostLineGeometryCache();
  });
});
