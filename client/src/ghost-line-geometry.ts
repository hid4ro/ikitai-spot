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
 * roughly half of the points (63,355 → 29,872 at 60 m, after
 * the junction pinning and crossing reverts below).
 *
 * Two kinds of vertices are PINNED — DP never drops them
 * (subtask 1457, Codex review round 1):
 *  - Junctions: a point where the shape branches (three or more
 *    piece-ends meeting, or a piece ending on another piece's
 *    interior vertex). An unpinned junction can slide off the
 *    simplified through-run, and the branch reads as detached —
 *    on 東北線 by ~100 m at the old 100 m tolerance.
 *  - Contact points the caller names (protectedPoints): where
 *    the ghost remainder meets a solid-painted leg. Both sides
 *    come from the same sliceEdge fractions, so the shared point
 *    is bit-identical; pinning it keeps the ghost glued to the
 *    paint — unpinned, a shared point on 山手線 slid 17.5 m.
 *
 * And a simplified segment may never draw a crossing the original
 * shape does not have: DP chords can cut across a neighbouring
 * strand (鹿児島線 gained three self-crossings that way). After
 * simplification, any chord that properly crosses an original
 * segment, or another chord whose original span it does not
 * cross, is replaced by the original points of its span.
 *
 * Guarantee: every vertex of the original shape sits within
 * GHOST_SIMPLIFY_TOLERANCE_M of the coarse shape; run endpoints,
 * junctions and caller-protected points are kept exactly; and
 * the coarse shape has no proper crossings the original lacks.
 *
 * Caching: the static per-key cache (getGhostLineGeometry) fits
 * the whole-line ghost of a line with no rides. The 路線 tab's
 * remainder depends on the coverage, so it goes through
 * simplifyGhostRemainder instead — a per-key memo keyed by the
 * remainder's fingerprint (edge spans + protected points), so a
 * coverage change re-simplifies only the lines whose remainder
 * actually changed. Tests: ghost-line-geometry.test.ts.
 *
 * Merge note (subtask 1456 + 1457 integration): the ghost is no
 * longer the whole unpainted line — 1456 subtracts the painted
 * ranges edge by edge first (ghostLineLegs), so App.tsx feeds
 * simplifyGhostRemainder the per-key REMAINDER. Chaining still
 * applies: remainder pieces share endpoints with their
 * neighbours, and slice endpoints are kept exactly, so the
 * painted/ghost boundary keeps full precision. */

import type { GeoJsonLineGeometry } from "./geojson";

export type LngLat = [number, number];

/* The tolerance is the spec's 60 m (subtask 1457, review round
   1: the first cut shipped 100 m by mistake). At latitude 35°,
   60 m is ~1 px at zoom 10 and ~31 px at zoom 15, against a
   1.6 px ghost line — the deviation stays sub-pixel where the
   路線 tab is read zoomed out, and the pinned junctions and
   contacts keep branches and paint boundaries exact where the
   reader zooms in. Measured on the bundled asset: 63,355 →
 * 26,237 points under DP alone (41% kept), 29,872 (47%) with
 * junction pinning and the crossing reverts on top. */
export const GHOST_SIMPLIFY_TOLERANCE_M = 60;

/* The identity of a point for junction / protection matching:
   the raw coordinate pair. Points that must match (a painted
   leg's end and the ghost leg sliced at the same fraction of
   the same edge) are produced by the same interpolation, so
   they are bit-identical and the string form is exact. */
export function ghostPointKey(p: readonly number[]): string {
  return `${p[0]},${p[1]}`;
}

const pointKey = ghostPointKey;

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

/* Douglas–Peucker as kept indices into `pts`, over the index
   range [start, end]: the range's endpoints always, plus every
   vertex the recursion splits on. Iterative, with an explicit
   stack. */
function simplifyKeptIndices(
  pts: readonly (readonly number[])[],
  start: number,
  end: number,
  toleranceM: number,
): number[] {
  if (end - start < 2) {
    const out: number[] = [];
    for (let i = start; i <= end; i++) out.push(i);
    return out;
  }
  const keep = new Set<number>([start, end]);
  /* Split at the farthest point while it lies farther than the
     tolerance from the chord. */
  const stack: [number, number][] = [[start, end]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    let farthest = -1;
    let farthestM = 0;
    for (let i = s + 1; i < e; i++) {
      const d = perpendicularDistanceM(pts[i]!, pts[s]!, pts[e]!);
      if (d > farthestM) {
        farthestM = d;
        farthest = i;
      }
    }
    if (farthestM > toleranceM && farthest >= 0) {
      keep.add(farthest);
      stack.push([s, farthest], [farthest, e]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

/* Douglas–Peucker over one polyline. Endpoints are always kept;
   a polyline of 2 or fewer points comes back unchanged. The
   returned points are fresh copies, in order. */
export function simplifyPolyline(
  pts: readonly (readonly number[])[],
  toleranceM: number,
): LngLat[] {
  if (pts.length === 0) return [];
  return simplifyKeptIndices(pts, 0, pts.length - 1, toleranceM).map(
    (i) => [pts[i]![0]!, pts[i]![1]!] as LngLat,
  );
}

/* Join a line's pieces into continuous runs by their shared
   endpoints. Every piece is used exactly once, so the runs cover
   the same network as the pieces — chaining only reorders. A run
   stops at a junction it cannot continue through (the branch
   starts its own run there), at a dead end, or when it closes a
   loop. Consecutive duplicate points (a continuation landing on
   the run's own last point) are dropped. */
function chainPieces(
  pieces: readonly (readonly (readonly number[])[])[],
): LngLat[][] {
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
  const runs: LngLat[][] = [];
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
    runs.push(
      run.filter(
        (p, idx) =>
          idx === 0 ||
          p[0] !== run[idx - 1]![0] ||
          p[1] !== run[idx - 1]![1],
      ),
    );
  }
  return runs;
}

/* The points where the shape branches, as point keys. A point's
   degree counts 1 for every piece ending there and 2 for every
   piece passing through it as an interior vertex; degree ≥ 3
   means a branch leaves the through-route there (three ends
   meeting, or an end landing on another piece's interior). A
   plain chain joint (two ends, degree 2) is NOT a junction —
   pinning those would keep nearly every vertex and defeat the
   simplification. */
function junctionPointKeys(
  pieces: readonly (readonly (readonly number[])[])[],
): Set<string> {
  const degree = new Map<string, number>();
  for (const piece of pieces) {
    piece.forEach((p, i) => {
      const w = i === 0 || i === piece.length - 1 ? 1 : 2;
      const k = pointKey(p);
      degree.set(k, (degree.get(k) ?? 0) + w);
    });
  }
  const out = new Set<string>();
  for (const [k, d] of degree) if (d >= 3) out.add(k);
  return out;
}

/* Proper crossing of segments a–b and c–d: they meet at a point
   interior to both. Sharing an endpoint, touching at an
   endpoint, and collinear overlap are NOT proper crossings —
   the original shape is full of those at junctions, and they
   draw fine. Orientation signs are taken in lng/lat space,
   which is sign-consistent under the axis scaling involved. */
function segmentsProperlyCross(
  a: readonly number[],
  b: readonly number[],
  c: readonly number[],
  d: readonly number[],
): boolean {
  const orient = (
    p: readonly number[],
    q: readonly number[],
    r: readonly number[],
  ): number => {
    const v =
      (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/* One chained run under simplification: the original polyline
   and the indices DP kept. Segment s of the run joins
   orig[kept[s]] to orig[kept[s + 1]] and replaces the original
   span between those two indices. */
type RunWork = { orig: LngLat[]; kept: number[] };

/* Find the simplified segments that would draw a crossing the
   original shape does not have, as "run:segment" keys. Two
   passes (review round 1):
 *  1. A chord properly crossing ANY original segment is new —
     the original draws no segment between the chord's ends, so
     even a crossing with the chord's own span (a hairpin the
     chord cuts across) is invented by the simplification.
 *  2. Two chords properly crossing each other are new unless
     their original spans already cross (parallel strands the
     asset itself entwines). A chord already reverted in pass 1
     needs no pass-2 check: the other chord was tested against
     its span's segments in pass 1, so reverting the first chord
     to its span cannot leave a new crossing behind.
 * Reverted segments are replaced by their spans' original
 * points, which by construction cross nothing new. */
function findNewCrossingSegments(runs: readonly RunWork[]): Set<string> {
  type Seg = { a: LngLat; b: LngLat };
  const origSegs: Seg[] = [];
  for (const rw of runs) {
    for (let i = 0; i < rw.orig.length - 1; i++) {
      origSegs.push({ a: rw.orig[i]!, b: rw.orig[i + 1]! });
    }
  }
  const simpSegs: (Seg & { run: number; pos: number; from: number; to: number })[] =
    [];
  runs.forEach((rw, r) => {
    for (let s = 0; s < rw.kept.length - 1; s++) {
      simpSegs.push({
        a: rw.orig[rw.kept[s]!]!,
        b: rw.orig[rw.kept[s + 1]!]!,
        run: r,
        pos: s,
        from: rw.kept[s]!,
        to: rw.kept[s + 1]!,
      });
    }
  });
  /* A uniform grid over segment bounding boxes (~1.1 km cells),
     so candidate pairs come from shared cells only. */
  const CELL = 0.01;
  const buildGrid = (segs: readonly Seg[]): Map<string, number[]> => {
    const grid = new Map<string, number[]>();
    segs.forEach((s, id) => {
      const minX = Math.floor(Math.min(s.a[0], s.b[0]) / CELL);
      const maxX = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
      const minY = Math.floor(Math.min(s.a[1], s.b[1]) / CELL);
      const maxY = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const k = `${x},${y}`;
          const list = grid.get(k) ?? [];
          list.push(id);
          grid.set(k, list);
        }
      }
    });
    return grid;
  };
  const queryGrid = (grid: Map<string, number[]>, s: Seg): number[] => {
    const minX = Math.floor(Math.min(s.a[0], s.b[0]) / CELL);
    const maxX = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
    const minY = Math.floor(Math.min(s.a[1], s.b[1]) / CELL);
    const maxY = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
    if (minX === maxX && minY === maxY) {
      return grid.get(`${minX},${minY}`) ?? [];
    }
    const found = new Set<number>();
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (const id of grid.get(`${x},${y}`) ?? []) found.add(id);
      }
    }
    return [...found];
  };
  const reverted = new Set<string>();
  const origGrid = buildGrid(origSegs);
  for (const s of simpSegs) {
    for (const id of queryGrid(origGrid, s)) {
      const o = origSegs[id]!;
      if (segmentsProperlyCross(s.a, s.b, o.a, o.b)) {
        reverted.add(`${s.run}:${s.pos}`);
        break;
      }
    }
  }
  const spansCross = (
    a: (typeof simpSegs)[number],
    b: (typeof simpSegs)[number],
  ): boolean => {
    const ra = runs[a.run]!.orig;
    const rb = runs[b.run]!.orig;
    for (let i = a.from; i < a.to; i++) {
      for (let j = b.from; j < b.to; j++) {
        if (segmentsProperlyCross(ra[i]!, ra[i + 1]!, rb[j]!, rb[j + 1]!)) {
          return true;
        }
      }
    }
    return false;
  };
  const simpGrid = buildGrid(simpSegs);
  simpSegs.forEach((s, sId) => {
    if (reverted.has(`${s.run}:${s.pos}`)) return;
    for (const tId of queryGrid(simpGrid, s)) {
      if (tId <= sId) continue;
      const t = simpSegs[tId]!;
      if (reverted.has(`${t.run}:${t.pos}`)) continue;
      if (!segmentsProperlyCross(s.a, s.b, t.a, t.b)) continue;
      if (spansCross(s, t)) continue;
      reverted.add(`${s.run}:${s.pos}`);
      reverted.add(`${t.run}:${t.pos}`);
    }
  });
  return reverted;
}

/* Chain a line's pieces into runs, simplify each run with DP,
   and restore the original points wherever a simplified segment
   would invent a crossing. Junctions and the caller's
   protected points (point keys, see ghostPointKey) are pinned:
   a run is split there before DP, so they survive exactly. */
export function simplifyGhostGeometry(
  geometry: GeoJsonLineGeometry,
  toleranceM: number = GHOST_SIMPLIFY_TOLERANCE_M,
  protectedPoints?: ReadonlySet<string>,
): GeoJsonLineGeometry {
  const pieces = geometry.coordinates.filter((p) => p.length >= 2);
  if (pieces.length === 0) {
    return { type: "MultiLineString", coordinates: [] };
  }
  const pinned = junctionPointKeys(pieces);
  if (protectedPoints) {
    for (const k of protectedPoints) pinned.add(k);
  }
  const runs: RunWork[] = [];
  for (const orig of chainPieces(pieces)) {
    if (orig.length < 2) continue;
    /* Split the run at its pinned interior vertices and DP each
       span; the union of kept indices keeps every pinned vertex
       exactly. */
    const keptSet = new Set<number>();
    let spanStart = 0;
    const spans: [number, number][] = [];
    for (let i = 1; i < orig.length - 1; i++) {
      if (pinned.has(pointKey(orig[i]!))) {
        spans.push([spanStart, i]);
        spanStart = i;
      }
    }
    spans.push([spanStart, orig.length - 1]);
    for (const [s, e] of spans) {
      for (const k of simplifyKeptIndices(orig, s, e, toleranceM)) {
        keptSet.add(k);
      }
    }
    runs.push({ orig, kept: [...keptSet].sort((a, b) => a - b) });
  }
  const reverted = findNewCrossingSegments(runs);
  const coordinates: number[][][] = [];
  runs.forEach((rw, r) => {
    const out: LngLat[] = [rw.orig[rw.kept[0]!]!];
    for (let s = 0; s < rw.kept.length - 1; s++) {
      const from = rw.kept[s]!;
      const to = rw.kept[s + 1]!;
      if (reverted.has(`${r}:${s}`)) {
        for (let i = from + 1; i <= to; i++) out.push(rw.orig[i]!);
      } else {
        out.push(rw.orig[to]!);
      }
    }
    if (out.length >= 2) {
      coordinates.push(out.map((p) => [p[0], p[1]] as LngLat));
    }
  });
  return { type: "MultiLineString", coordinates };
}

const ghostCache = new Map<string, GeoJsonLineGeometry>();

/* The coarse ghost geometry for one formal-line key, cached —
   the asset never changes at runtime, so the simplification
   runs once per line however often the ghost re-renders. Fits
   the whole-line ghost (no subtraction); the 路線 tab's
   coverage-dependent remainder uses simplifyGhostRemainder. */
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

/* One remainder leg of a formal line, as ghostLineLegs produces
   it: the graph edge it slices and the span it covers. The span
   determines the leg's coordinates exactly (same asset, same
   slicing), so edge + span is a complete fingerprint of the
   remainder a key's ghost is drawn from. */
export type GhostRemainderLeg = {
  edge: string;
  fromT: number;
  toT: number;
  coords: readonly (readonly number[])[];
};

const remainderCache = new Map<
  string,
  { fingerprint: string; geometry: GeoJsonLineGeometry }
>();

/* The coarse geometry of one key's ghost REMAINDER (subtask
   1456's subtraction output), memoized per key (subtask 1457,
   review round 1): a coverage change re-simplifies only the
   lines whose remainder fingerprint changed — before, every
   coverage change re-ran the chaining and simplification for
   all 597 lines. `protectedPoints` are the key's contact points
   with the solid paint (painted legs' endpoints), pinned by
   simplifyGhostGeometry; they ride in the fingerprint because
   they shape the result. */
export function simplifyGhostRemainder(
  key: string,
  legs: readonly GhostRemainderLeg[],
  protectedPoints?: ReadonlySet<string>,
): GeoJsonLineGeometry {
  const fingerprint =
    legs.map((l) => `${l.edge}:${l.fromT}:${l.toT}`).join("|") +
    "#" +
    (protectedPoints ? [...protectedPoints].sort().join(",") : "");
  const hit = remainderCache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.geometry;
  const coarse = simplifyGhostGeometry(
    {
      type: "MultiLineString",
      coordinates: legs.map((leg) =>
        leg.coords.map((p) => [p[0]!, p[1]!] as LngLat),
      ),
    },
    GHOST_SIMPLIFY_TOLERANCE_M,
    protectedPoints,
  );
  remainderCache.set(key, { fingerprint, geometry: coarse });
  return coarse;
}

/* Test-only: drop the caches (the tests build coarse geometries
   from synthetic shapes under the same keys). */
export function clearGhostLineGeometryCache(): void {
  ghostCache.clear();
  remainderCache.clear();
}

/* Number of coordinates in a line geometry, for the tests'
   reduction assertions. */
export function countGeometryPoints(geometry: GeoJsonLineGeometry): number {
  let total = 0;
  for (const piece of geometry.coordinates) total += piece.length;
  return total;
}
