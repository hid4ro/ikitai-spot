import { describe, expect, test } from "bun:test";
import type { GeoJsonGeometry } from "./geojson";
import {
  geometryBounds,
  geometryContainsPoint,
  ringContainsPoint,
} from "./municipality-geometry";

/* The pre-1586 implementations, kept as the reference the indexed
   versions must agree with on every point: the optimisation may
   only skip work, never change an answer. */
function referenceRingContainsPoint(
  ring: number[][],
  lng: number,
  lat: number,
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a as [number, number];
    const [xj, yj] = b as [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function referenceContainsPoint(
  geometry: GeoJsonGeometry,
  lng: number,
  lat: number,
): boolean {
  const polygons: number[][][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon;
    if (!outer || !referenceRingContainsPoint(outer, lng, lat)) continue;
    if (holes.some((hole) => referenceRingContainsPoint(hole, lng, lat))) {
      continue;
    }
    return true;
  }
  return false;
}

function referenceBounds(
  geometry: GeoJsonGeometry,
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      const [lng, lat] = coords as [number, number];
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geometry.coordinates);
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/* A square with a square hole, centred on the origin. */
const HOLED_SQUARE: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ],
    [
      [-0.4, -0.4],
      [0.4, -0.4],
      [0.4, 0.4],
      [-0.4, 0.4],
      [-0.4, -0.4],
    ],
  ],
};

/* Two disjoint parts — a diamond (whose bounds corners lie
   outside the ring) and a small square — like a designated city
   or an island municipality in the real boundary data. */
const TWO_PARTS: GeoJsonGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [3, 0],
        [4, 1],
        [3, 2],
        [2, 1],
        [3, 0],
      ],
    ],
    [
      [
        [6, 6],
        [7, 6],
        [7, 7],
        [6, 7],
        [6, 6],
      ],
    ],
  ],
};

/* A concave L, the classic ray-casting trap. */
const CONCAVE: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 3],
      [0, 3],
      [0, 0],
    ],
  ],
};

describe("geometryContainsPoint", () => {
  test("agrees with the uncached ring walk on a grid over every fixture", () => {
    for (const geometry of [HOLED_SQUARE, TWO_PARTS, CONCAVE]) {
      for (let gx = -30; gx <= 90; gx++) {
        for (let gy = -30; gy <= 90; gy++) {
          const lng = gx / 10;
          const lat = gy / 10;
          expect(geometryContainsPoint(geometry, lng, lat)).toBe(
            referenceContainsPoint(geometry, lng, lat),
          );
        }
      }
    }
  });

  test("a point inside a hole is outside", () => {
    expect(geometryContainsPoint(HOLED_SQUARE, 0, 0)).toBe(false);
    expect(geometryContainsPoint(HOLED_SQUARE, 0.7, 0)).toBe(true);
  });

  test("a point inside only the second part of a MultiPolygon hits", () => {
    expect(geometryContainsPoint(TWO_PARTS, 6.5, 6.5)).toBe(true);
    expect(geometryContainsPoint(TWO_PARTS, 3, 1)).toBe(true);
    expect(geometryContainsPoint(TWO_PARTS, 5, 5)).toBe(false);
  });

  test("a bounds corner outside the ring is not a false positive", () => {
    /* (2.1, 0.1) sits inside the diamond's bounds but outside
       the diamond itself: the inclusive bounds check must pass
       it through to the ring test, which rejects it. */
    expect(geometryContainsPoint(TWO_PARTS, 2.1, 0.1)).toBe(false);
  });

  test("an empty geometry contains nothing", () => {
    const empty: GeoJsonGeometry = { type: "MultiPolygon", coordinates: [] };
    expect(geometryContainsPoint(empty, 0, 0)).toBe(false);
  });

  test("repeat calls return the same answer (cached index)", () => {
    for (let i = 0; i < 3; i++) {
      expect(geometryContainsPoint(HOLED_SQUARE, 0.7, 0.2)).toBe(true);
      expect(geometryContainsPoint(HOLED_SQUARE, 0, 0)).toBe(false);
    }
  });
});

describe("geometryBounds", () => {
  test("matches the reference walk on every fixture", () => {
    for (const geometry of [HOLED_SQUARE, TWO_PARTS, CONCAVE]) {
      expect(geometryBounds(geometry)).toEqual(referenceBounds(geometry));
    }
  });

  test("spans every part of a MultiPolygon", () => {
    expect(geometryBounds(TWO_PARTS)).toEqual([
      [2, 0],
      [7, 7],
    ]);
  });

  test("an empty geometry has no bounds", () => {
    const empty: GeoJsonGeometry = { type: "Polygon", coordinates: [] };
    expect(geometryBounds(empty)).toBeNull();
  });

  test("mutating a returned tuple does not poison the cache", () => {
    const first = geometryBounds(TWO_PARTS)!;
    first[0][0] = -999;
    expect(geometryBounds(TWO_PARTS)).toEqual([
      [2, 0],
      [7, 7],
    ]);
  });
});

describe("ringContainsPoint", () => {
  test("classifies a square's inside and outside", () => {
    const ring = HOLED_SQUARE.coordinates[0]!;
    expect(ringContainsPoint(ring, 0, 0)).toBe(true);
    expect(ringContainsPoint(ring, 2, 0)).toBe(false);
  });
});
