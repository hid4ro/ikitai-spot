/* Municipality geometry primitives: bounding boxes and point
   containment for the boundary shapes, shared by the map tap
   lookup (findMunicipalityAt in App.tsx), the focus camera
   framing and the default framing.

   Both reads run off a lazily built per-geometry index — the
   whole-geometry bounds plus one bounds per polygon part, taken
   from the part's outer ring — cached in a WeakMap keyed by the
   geometry object itself. The tap lookup scans every loaded
   boundary (1,747 municipalities, ~500k ring vertices) whenever
   a tap hits no painted shape, and ray-casting every ring of
   every geometry measured ~10 ms on a desktop CPU (subtask
   1586) — several times that on a phone, on the main thread,
   before the tap's state updates even start. With the index,
   a geometry whose bounds do not contain the point is rejected
   on four number comparisons and only the handful of candidates
   whose bounds overlap the point pay the ring walks.

   Geometries are immutable data (converted TopoJSON from
   boundary-data.ts, or a ledger row's stored geometry), so
   caching derived bounds against the object is safe; the
   WeakMap lets a replaced geometry take its index with it.
   Bounds tests are inclusive on every edge, so a point sitting
   exactly on a bounds edge still reaches the ring test — the
   containment result is identical to the uncached ring walk,
   only faster. */

import type { GeoJsonGeometry } from "./geojson";

export type LngLatBounds = [[number, number], [number, number]];

type PolygonIndex = {
  /* Bounds of the part's outer ring: a point outside it cannot
     be inside the part, so the ring walks are skipped. Holes
     never extend a part beyond its outer ring, so they need no
     bounds of their own. */
  bounds: LngLatBounds;
  outer: number[][];
  holes: number[][][];
};

type GeometryIndex = {
  /* The same bounds geometryBounds reports: every position of
     every ring walked, null when the geometry carries no finite
     position at all. */
  bounds: LngLatBounds | null;
  polygons: PolygonIndex[];
};

const indexCache = new WeakMap<GeoJsonGeometry, GeometryIndex>();

function buildIndex(geometry: GeoJsonGeometry): GeometryIndex {
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
  const bounds: LngLatBounds | null = Number.isFinite(minLng)
    ? [
        [minLng, minLat],
        [maxLng, maxLat],
      ]
    : null;

  const polygons: PolygonIndex[] = [];
  const parts: number[][][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const part of parts) {
    const [outer, ...holes] = part;
    if (!outer) continue;
    let pMinLng = Infinity;
    let pMinLat = Infinity;
    let pMaxLng = -Infinity;
    let pMaxLat = -Infinity;
    for (const pos of outer) {
      const lng = pos[0];
      const lat = pos[1];
      if (lng === undefined || lat === undefined) continue;
      if (lng < pMinLng) pMinLng = lng;
      if (lat < pMinLat) pMinLat = lat;
      if (lng > pMaxLng) pMaxLng = lng;
      if (lat > pMaxLat) pMaxLat = lat;
    }
    if (!Number.isFinite(pMinLng)) continue;
    polygons.push({
      bounds: [
        [pMinLng, pMinLat],
        [pMaxLng, pMaxLat],
      ],
      outer,
      holes,
    });
  }
  return { bounds, polygons };
}

function indexFor(geometry: GeoJsonGeometry): GeometryIndex {
  let index = indexCache.get(geometry);
  if (!index) {
    index = buildIndex(geometry);
    indexCache.set(geometry, index);
  }
  return index;
}

function boundsContain(bounds: LngLatBounds, lng: number, lat: number): boolean {
  return (
    lng >= bounds[0][0] &&
    lng <= bounds[1][0] &&
    lat >= bounds[0][1] &&
    lat <= bounds[1][1]
  );
}

/* Bounding box of a GeoJSON geometry as [[minLng, minLat],
   [maxLng, maxLat]] — the shape MapLibre's fitBounds takes.
   Walks every ring of a Polygon / MultiPolygon (cached after
   the first walk; see the header). A fresh tuple is returned
   each call so a caller may hold or hand it on freely. */
export function geometryBounds(geometry: GeoJsonGeometry): LngLatBounds | null {
  const { bounds } = indexFor(geometry);
  if (!bounds) return null;
  return [
    [bounds[0][0], bounds[0][1]],
    [bounds[1][0], bounds[1][1]],
  ];
}

/* Ray-casting point-in-ring test over [lng, lat] coordinate pairs. */
export function ringContainsPoint(
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

/* Whether a Polygon / MultiPolygon geometry contains the point:
   inside an outer ring and outside every hole of that polygon.
   Parts whose bounds miss the point are skipped without a ring
   walk; the result matches walking every part in order. */
export function geometryContainsPoint(
  geometry: GeoJsonGeometry,
  lng: number,
  lat: number,
): boolean {
  const index = indexFor(geometry);
  if (index.bounds && !boundsContain(index.bounds, lng, lat)) return false;
  for (const polygon of index.polygons) {
    if (!boundsContain(polygon.bounds, lng, lat)) continue;
    if (!ringContainsPoint(polygon.outer, lng, lat)) continue;
    if (polygon.holes.some((hole) => ringContainsPoint(hole, lng, lat))) {
      continue;
    }
    return true;
  }
  return false;
}
