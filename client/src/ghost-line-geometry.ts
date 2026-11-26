/* Coarse geometry for the unridden-lines ghost only (subtask 1457,
   plan A).
 *
 * The 路線 tab's ghost draws every formal line no service has fully
 * painted, as one thin faint layer. At full precision that is
 * 63,355 coordinates over 597 lines, pushed into MapLibre on every
 * coverage change — the map's heaviest single payload. The ridden
 * legs keep full precision (they are the record: painted length IS
 * counted length); only the ghost gets the coarse shape, so a
 * deviation here can never move a distance or a painted section.
 *
 * Why chaining, not plain Douglas–Peucker per piece: the asset is
 * already simplified (visited-lines.ts: "日本全国で簡略化済み") —
 * the median segment is 463 m, and DP at 50 m removes 5 points out
 * of 63,355. Half the points (30,220) sit in 2-point pieces that
 * per-piece DP cannot touch at all. Joining the pieces by their
 * shared endpoints into continuous runs first, then running DP
 * over each run, keeps the same deviation bound while cutting
 * roughly two thirds of the points (63,355 → ~20,900 at 100 m).
 *
 * Guarantee: every vertex of the original shape sits within
 * GHOST_SIMPLIFY_TOLERANCE_M of the coarse shape, and every
 * chain endpoint is kept exactly — so pieces still meet at the
 * same junctions, up to the tolerance. A junction a chain passes
 * through can shift by at most the tolerance where a branch
 * leaves it; at 0.25 opacity and 1.6 px width that reads as the
 * same faint line.
 *
 * The result is cached per formal-line key (the asset is static),
 * so the ghost's useMemo pays the simplification once per line.
 * Tests: ghost-line-geometry.test.ts.
 *
 * Merge note (subtask 1456 + 1457 integration): the ghost is no
 * longer the whole unpainted line — 1456 subtracts the painted
 * ranges edge by edge first (ghostLineLegs), so App.tsx feeds
 * simplifyGhostGeometry the per-key REMAINDER, which depends on
 * the coverage and cannot use the static per-key cache above.
 * The simplification still runs inside the ghost's useMemo, so
 * it re-runs only when the coverage changes. Chaining still
 * applies: remainder pieces share endpoints with their
 * neighbours, and slice endpoints are kept exactly, so the
 * painted/ghost boundary keeps full precision. */

import type { GeoJsonLineGeometry } from "./geojson";

export type LngLat = [number, number];

/* Modest on purpose: the ghost is a faint underlay, but where it
   runs under a precisely drawn ridden leg it must not read as a
   second, offset line. 100 m is sub-pixel at the region zooms the
   路線 tab is read at (zoom 10 ≈ 125 m/px) and a small fraction
   of a segment at closer zooms; the mean deviation over the real
   asset is ~7 m. Measured on the bundled asset: 63,355 →
 * ~20,900 points (33% kept). 200 m would keep ~80% of the
 * original's points away (50,497) but doubles the worst offset;
 * 50 m keeps 100% — the asset is already that coarse. */
export const GHOST_SIMPLIFY_TOLERANCE_M = 100;

const pointKey = (p: readonly number[]): string => `${p[0]},${p[1]}`;

/* Perpendicular distance from p to segment a–b, in
   equirectangular metres around the segment — the same
   approximation line-geometry.ts uses for projections, good to a
   few metres over these distances. */
function perpendicularDistanceM(
  p: readonly number[],
  a: readonly number[],
  b: readonly number[],
): number {
  const kx = 111320 * Math.cos((((a[1]! + b[1]!) / 2) * Math.PI) / 180);
  const ky = 110540;
  const ax = (p[0]! - a[0]!) * kx;
  const ay = (p[1]! - a[1]!) * ky;
  const bx = (b[0]! - a[0]!) * kx;
  const by = (b[1]! - a[1]!) * ky;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(ax, ay);
  let t = (ax * bx + ay * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax - t * bx, ay - t * by);
}

/* Douglas–Peucker over one polyline. Endpoints are always kept;
   a polyline of 2 or fewer points comes back unchanged. The
   returned points are the original point objects, in order. */
export function simplifyPolyline(
  pts: readonly (readonly number[])[],
  toleranceM: number,
): LngLat[] {
  if (pts.length <= 2) return pts.map((p) => [p[0]!, p[1]!] as LngLat);
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  /* Iterative DP: split at the farthest point while it lies
     farther than the tolerance from the chord. */
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let farthest = -1;
    let farthestM = 0;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceM(pts[i]!, pts[start]!, pts[end]!);
      if (d > farthestM) {
        farthestM = d;
        farthest = i;
      }
    }
    if (farthestM > toleranceM && farthest >= 0) {
      keep[farthest] = true;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  const out: LngLat[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push([pts[i]![0]!, pts[i]![1]!] as LngLat);
  }
  return out;
}

/* Join a line's pieces into continuous runs by their shared
   endpoints, then simplify each run. Every piece is used exactly
   once, so the coarse shape covers the same network — only
   interior vertices within the tolerance go away. A run stops at
   a junction it cannot continue through (the branch starts its
   own run there), at a dead end, or when it closes a loop. */
export function simplifyGhostGeometry(
  geometry: GeoJsonLineGeometry,
  toleranceM: number = GHOST_SIMPLIFY_TOLERANCE_M,
): GeoJsonLineGeometry {
  const pieces = geometry.coordinates.filter((p) => p.length >= 2);
  if (pieces.length === 0) {
    return { type: "MultiLineString", coordinates: [] };
  }
  /* Index pieces by each end so a run can find its continuation. */
  const byEnd = new Map<string, number[]>();
  pieces.forEach((piece, i) => {
    for (const end of [piece[0]!, piece[piece.length - 1]!]) {
      const list = byEnd.get(pointKey(end)) ?? [];
      list.push(i);
      byEnd.set(pointKey(end), list);
    }
  });
  const used = new Array<boolean>(pieces.length).fill(false);
  /* The next unused piece touching `at`, oriented away from it
     (its points after `at`), or null when the run ends here. */
  const takeContinuation = (
    at: readonly number[],
    exclude: number,
  ): LngLat[] | null => {
    for (const j of byEnd.get(pointKey(at)) ?? []) {
      if (j === exclude || used[j]) continue;
      used[j] = true;
      const piece = pieces[j]!;
      if (pointKey(piece[0]!) === pointKey(at)) {
        return piece.slice(1).map((p) => [p[0], p[1]] as LngLat);
      }
      return piece
        .slice(0, -1)
        .reverse()
        .map((p) => [p[0], p[1]] as LngLat);
    }
    return null;
  };
  const coordinates: number[][][] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let run: LngLat[] = pieces[i]!.map((p) => [p[0], p[1]] as LngLat);
    for (;;) {
      const next = takeContinuation(run[run.length - 1]!, i);
      if (!next) break;
      run.push(...next);
    }
    for (;;) {
      const prev = takeContinuation(run[0]!, i);
      if (!prev) break;
      /* `prev` runs away from the run's start, so reverse it to
         prepend in running order. */
      run = [...prev.reverse(), ...run];
    }
    /* A continuation can land on the run's own start point (a
       closed loop); drop the doubled point so the run stays a
       clean polyline. */
    const deduped = run.filter(
      (p, idx) =>
        idx === 0 ||
        p[0] !== run[idx - 1]![0] ||
        p[1] !== run[idx - 1]![1],
    );
    const simplified = simplifyPolyline(deduped, toleranceM);
    if (simplified.length >= 2) coordinates.push(simplified);
  }
  return { type: "MultiLineString", coordinates };
}

const ghostCache = new Map<string, GeoJsonLineGeometry>();

/* The coarse ghost geometry for one formal-line key, cached —
   the asset never changes at runtime, so the simplification
   runs once per line however often the ghost re-renders. */
export function getGhostLineGeometry(
  key: string,
  geometry: GeoJsonLineGeometry,
): GeoJsonLineGeometry {
  const cached = ghostCache.get(key);
  if (cached) return cached;
  const coarse = simplifyGhostGeometry(geometry);
  ghostCache.set(key, coarse);
  return coarse;
}

/* Test-only: drop the cache (the tests build coarse geometries
   from synthetic shapes under the same keys). */
export function clearGhostLineGeometryCache(): void {
  ghostCache.clear();
}

/* Number of coordinates in a line geometry, for the tests'
   reduction assertions. */
export function countGeometryPoints(geometry: GeoJsonLineGeometry): number {
  let total = 0;
  for (const piece of geometry.coordinates) total += piece.length;
  return total;
}
