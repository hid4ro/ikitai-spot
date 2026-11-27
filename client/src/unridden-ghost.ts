/* The 路線 tab's unridden-lines ghost: coverage in, features out
   (subtask 1457). This module is the PURE half of the ghost —
   the wire shape the coverage crosses to the worker in, the
   fingerprint that ties a result to the ledger it was computed
   from, and the computation itself. It runs inside the Web
   Worker (unridden-ghost-worker.ts); the main thread only
   serializes, fingerprints, and (in the no-Worker fallback)
   calls the same computation, so the two paths can never drift
   apart. Tests: unridden-ghost.test.ts.

   Why a worker at all (review round 3): the computation is the
   map's heaviest (all 597 formal lines; ~300 ms cold on the
   reviewer's machine). Deferred with setTimeout(0) it still ran
   on the main thread and could precede the first paint of the
   路線 tab. In the worker it costs the UI thread nothing beyond
   posting the painted legs and cloning the finished features
   back. */

import {
  ghostLegsForKey,
  ghostLineLegs,
  subtractLegSpans,
  type LineCoverage,
  type LineGeometryMap,
  type PathLeg,
} from "./line-geometry";
import {
  ghostPointKey,
  simplifyGhostRemainder,
} from "./ghost-line-geometry";
import type { GeoJsonLineGeometry } from "./geojson";
import type { UnriddenLineFeature } from "./map-variant";

/* One service's painted legs, flattened for the trip across
   postMessage: plain data only (no Map, no class instances),
   so the wire survives structured clone unchanged. Only the
   painted legs travel — a handful of sections — never the
   597-line asset, which the worker bundles for itself. */
export type GhostCoverageWire = {
  services: {
    serviceId: string;
    unknown: boolean;
    legs: {
      key: string;
      edge: string;
      fromT: number;
      toT: number;
      coords: [number, number][];
      lengthKm: number;
    }[];
  }[];
};

/* The painted-leg half of a LineCoverage, as the wire. The
   ghost reads nothing else from the coverage: the subtraction
   (ghostLineLegs) and the contact points both derive from
   perServiceLegs alone. */
export function serializeGhostCoverage(
  coverage: LineCoverage,
): GhostCoverageWire {
  const services: GhostCoverageWire["services"] = [];
  for (const [serviceId, painted] of coverage.perServiceLegs) {
    services.push({
      serviceId,
      unknown: painted.unknown,
      legs: painted.legs.map((leg) => ({
        key: leg.key,
        edge: leg.edge,
        fromT: leg.fromT,
        toT: leg.toT,
        coords: leg.coords.map(
          (p) => [p[0], p[1]] as [number, number],
        ),
        lengthKm: leg.lengthKm,
      })),
    });
  }
  return { services };
}

/* A result's identity: which ledger (coverage) it belongs to.
   The ghost's output is a function of exactly the painted spans
   of the KNOWN services — key, edge and [fromT, toT] per leg:
   the subtraction merges those spans, and the contact points
   are the spans' sliced endpoints, which the same triple
   determines bit for bit. An unknown ride's legs subtract
   nothing and pin nothing, so they are left out — an unknown
   service appearing or vanishing cannot change the ghost, and
   must not change the key either, or results would be dropped
   as stale when nothing they draw on moved. Service grouping
   is likewise invisible to the output (both consumers union
   across services), so the spans are sorted into one canonical
   list. Two coverages with the same key produce the same
   features; two with different keys may not share a result. */
export function ghostCoverageKey(wire: GhostCoverageWire): string {
  const spans = new Set<string>();
  for (const service of wire.services) {
    if (service.unknown) continue;
    for (const leg of service.legs) {
      spans.add(`${leg.key}\u0000${leg.edge}\u0000${leg.fromT}\u0000${leg.toT}`);
    }
  }
  return [...spans].sort().join("\u0001");
}

/* Whether features the worker delivered may still be written
   to the map against `coverage` — the coverage-key discipline
   the worker's apply path keeps (applyUnriddenLineGhostLatest
   in map-variant.ts), extended to the focus paths (subtask
   1680, review round 2, finding 2). Those paths rewrite the
   ghost's source from the latest result the caller holds;
   while the worker recomputes after a ledger change, that
   result still belongs to the OLD coverage, and combining it
   with the new one — trimming it against the new coverage's
   spans, or restoring it whole on a focus clear — would write
   back a ghost the current ledger never produced. The
   features themselves carry no key, so the caller passes the
   key of the result they came from (null before the first
   result lands: nothing may be written). */
export function ghostFeaturesMatchCoverage(
  featuresCoverageKey: string | null,
  coverage: LineCoverage,
): boolean {
  return (
    featuresCoverageKey !== null &&
    featuresCoverageKey ===
      ghostCoverageKey(serializeGhostCoverage(coverage))
  );
}

/* The computation itself, moved out of App.tsx (where it ran
   first in a useMemo, then in a setTimeout): every formal
   line's unridden remainder — the drawing shape minus the
   solid-painted ranges, edge by edge (see ghostLineLegs) —
   coarsened by the ghost simplification, one feature per key
   in its own color. The painted legs' endpoints ride along as
   protected points, so the points where ghost meets paint are
   pinned exactly. `asset` is the bundled line geometries
   (RIDDEN_LINE_GEOMETRIES in production, a fixture in tests):
   each entry carries the line's color and, cast as the
   geometry map, its shape. */
export function computeUnriddenGhostFeatures(
  wire: GhostCoverageWire,
  asset: Readonly<Record<string, { color: string }>>,
): UnriddenLineFeature[] {
  const perServiceLegs = new Map<
    string,
    { legs: readonly PathLeg[]; unknown: boolean }
  >();
  for (const service of wire.services) {
    perServiceLegs.set(service.serviceId, {
      unknown: service.unknown,
      legs: service.legs,
    });
  }
  /* ghostLineLegs reads perServiceLegs alone (see the wire
     comment above); the rest of a LineCoverage never reaches
     it, so the partial shape is the whole input. */
  const coverage = { perServiceLegs } as unknown as LineCoverage;
  const contactsByKey = new Map<string, Set<string>>();
  for (const [, painted] of perServiceLegs) {
    if (painted.unknown) continue;
    for (const leg of painted.legs) {
      let set = contactsByKey.get(leg.key);
      if (!set) {
        set = new Set<string>();
        contactsByKey.set(leg.key, set);
      }
      for (const end of [
        leg.coords[0]!,
        leg.coords[leg.coords.length - 1]!,
      ]) {
        set.add(ghostPointKey(end));
      }
    }
  }
  const features: UnriddenLineFeature[] = [];
  for (const [key, legs] of ghostLineLegs(
    coverage,
    asset as unknown as LineGeometryMap,
  )) {
    const entry = asset[key];
    if (!entry || legs.length === 0) continue;
    features.push({
      type: "Feature",
      properties: { key, color: entry.color },
      geometry: simplifyGhostRemainder(key, legs, contactsByKey.get(key)),
    });
  }
  return features;
}

/* How close a ghost leg must lie to the focused remainder
   to count as the same stretch of track: a formal line's
   drawing shape carries parallel strands for the same
   corridor (up/down tracks, the 京浜東北線 alignment inside
   東北線's shape), tens of metres apart — well inside the
   distance the two translucent paints blend at reading
   zooms, and the same order as the ghost simplification's
   own 60 m tolerance. */
const GHOST_TRIM_CORRIDOR_M = 100;

/* Point-to-segment distance in metres (equirectangular
   approximation — ample at corridor scale). */
function pointToSegmentM(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_540;
  const abx = (b[0] - a[0]) * kx;
  const aby = (b[1] - a[1]) * ky;
  const apx = (p[0] - a[0]) * kx;
  const apy = (p[1] - a[1]) * ky;
  const len2 = abx * abx + aby * aby;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  return Math.hypot(apx - t * abx, apy - t * aby);
}

function pointToLegsM(
  p: readonly [number, number],
  legs: readonly PathLeg[],
): number {
  let best = Infinity;
  for (const leg of legs) {
    for (let i = 0; i + 1 < leg.coords.length; i++) {
      best = Math.min(
        best,
        pointToSegmentM(p, leg.coords[i]!, leg.coords[i + 1]!),
      );
    }
    if (leg.coords.length === 1) {
      best = Math.min(best, pointToSegmentM(p, leg.coords[0]!, leg.coords[0]!));
    }
  }
  return best;
}

/* Distance from a point to a segment, in a local metre
   frame (both already projected). */
function segmentDistanceM(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const len2 = abx * abx + aby * aby;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
  return Math.hypot(apx - t * abx, apy - t * aby);
}

/* Collects the roots of a·t² + b·t + c = r² that fall inside
   [lo, hi] ∩ [0, 1] (with a hair of tolerance, clamped). */
function corridorRoots(
  roots: number[],
  a: number,
  b: number,
  c: number,
  lo: number,
  hi: number,
  r: number,
): void {
  const L = Math.max(0, lo);
  const H = Math.min(1, hi);
  if (L > H) return;
  const EPS = 1e-9;
  const C = c - r * r;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return;
    const t = -C / b;
    if (t >= L - EPS && t <= H + EPS) {
      roots.push(Math.min(1, Math.max(0, t)));
    }
    return;
  }
  const disc = b * b - 4 * a * C;
  if (disc < 0) return;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t >= L - EPS && t <= H + EPS) {
      roots.push(Math.min(1, Math.max(0, t)));
    }
  }
}

/* The inside interval(s) of ONE (ghost segment, cut segment)
   pair, both in the ghost segment's local metre frame with
   the ghost segment starting at the origin: the t ranges of
   P(t) = t·D whose distance to the cut segment A→B is at most
   r. The distance to a segment is convex in t, so the inside
   set is a single interval; it is recovered exactly by
   solving the distance quadratics of the three closest-point
   regions (clamped to A, the interior projection, clamped to
   B — the region boundaries are where the projection's
   parameter crosses 0 and 1) and classifying the elementary
   spans between the roots by their midpoints. */
function pairCorridorIntervals(
  d: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
  r: number,
): [number, number][] {
  /* W = P − A, with P at the origin. */
  const wx = -a[0];
  const wy = -a[1];
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const gamma = ux * ux + uy * uy;
  const d2 = d[0] * d[0] + d[1] * d[1];
  const wd = wx * d[0] + wy * d[1];
  const ww = wx * wx + wy * wy;
  const roots: number[] = [];
  if (gamma === 0) {
    /* A degenerate cut segment is a point: one region. */
    corridorRoots(roots, d2, 2 * wd, ww, -Infinity, Infinity, r);
  } else {
    const alpha = wx * ux + wy * uy;
    const beta = d[0] * ux + d[1] * uy;
    /* The interior region's quadratic: dist² minus the
       projection's share along U. */
    const ia = d2 - (beta * beta) / gamma;
    const ib = 2 * wd - (2 * alpha * beta) / gamma;
    const ic = ww - (alpha * alpha) / gamma;
    /* The clamped-to-B region's quadratic, with W1 = W − U. */
    const w1x = wx - ux;
    const w1y = wy - uy;
    const b1 = 2 * (w1x * d[0] + w1y * d[1]);
    const c1 = w1x * w1x + w1y * w1y;
    if (beta === 0) {
      /* The projection's parameter is constant along the
         ghost segment: a single region applies throughout. */
      const s = alpha / gamma;
      if (s < 0) {
        corridorRoots(roots, d2, 2 * wd, ww, -Infinity, Infinity, r);
      } else if (s > 1) {
        corridorRoots(roots, d2, b1, c1, -Infinity, Infinity, r);
      } else {
        corridorRoots(roots, ia, ib, ic, -Infinity, Infinity, r);
      }
    } else {
      const tA = -alpha / beta; /* projection parameter = 0 */
      const tB = (gamma - alpha) / beta; /* = 1 */
      corridorRoots(
        roots,
        ia,
        ib,
        ic,
        Math.min(tA, tB),
        Math.max(tA, tB),
        r,
      );
      if (beta > 0) {
        corridorRoots(roots, d2, 2 * wd, ww, -Infinity, tA, r);
        corridorRoots(roots, d2, b1, c1, tB, Infinity, r);
      } else {
        corridorRoots(roots, d2, 2 * wd, ww, tA, Infinity, r);
        corridorRoots(roots, d2, b1, c1, -Infinity, tB, r);
      }
    }
  }
  const bounds = [0, ...roots, 1].sort((x, y) => x - y);
  const inside: [number, number][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const lo = bounds[i]!;
    const hi = bounds[i + 1]!;
    if (hi - lo < 1e-12) continue;
    const mid = (lo + hi) / 2;
    if (segmentDistanceM([mid * d[0], mid * d[1]], a, b) > r) continue;
    const last = inside[inside.length - 1];
    if (last && lo - last[1] < 1e-9) last[1] = hi;
    else inside.push([lo, hi]);
  }
  return inside;
}

/* The parts of one ghost segment (p → q, lng/lat) lying
   OUTSIDE the cuts' corridor, as [t0, t1] parameter pairs:
   the union of every cut segment's inside interval,
   complemented within [0, 1]. The whole segment is examined,
   not just its endpoints — a segment whose ends both clear
   the corridor can still run inside it mid-way (a parallel
   strand a few tens of metres off the remainder, kilometres
   long), and the first cut, which classified vertices only,
   kept such a segment whole (subtask 1680, review round 2,
   finding 1). */
function segmentOutsidePieces(
  p: readonly [number, number],
  q: readonly [number, number],
  cuts: readonly PathLeg[],
  cutSegs: readonly [
    readonly [number, number],
    readonly [number, number],
  ][],
): [number, number][] {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110_540;
  const d: [number, number] = [(q[0] - p[0]) * kx, (q[1] - p[1]) * ky];
  if (d[0] === 0 && d[1] === 0) {
    return pointToLegsM(p, cuts) > GHOST_TRIM_CORRIDOR_M ? [[0, 1]] : [];
  }
  const gx0 = Math.min(0, d[0]);
  const gx1 = Math.max(0, d[0]);
  const gy0 = Math.min(0, d[1]);
  const gy1 = Math.max(0, d[1]);
  const inside: [number, number][] = [];
  for (const [aRaw, bRaw] of cutSegs) {
    const a: [number, number] = [
      (aRaw[0] - p[0]) * kx,
      (aRaw[1] - p[1]) * ky,
    ];
    const b: [number, number] = [
      (bRaw[0] - p[0]) * kx,
      (bRaw[1] - p[1]) * ky,
    ];
    /* Bounding-box reject: boxes farther apart than the
       corridor radius cannot interact. */
    const gapX = Math.max(
      Math.min(a[0], b[0]) - gx1,
      gx0 - Math.max(a[0], b[0]),
      0,
    );
    const gapY = Math.max(
      Math.min(a[1], b[1]) - gy1,
      gy0 - Math.max(a[1], b[1]),
      0,
    );
    if (Math.hypot(gapX, gapY) > GHOST_TRIM_CORRIDOR_M) continue;
    for (const interval of pairCorridorIntervals(
      d,
      a,
      b,
      GHOST_TRIM_CORRIDOR_M,
    )) {
      inside.push(interval);
    }
  }
  if (inside.length === 0) return [[0, 1]];
  inside.sort((x, y) => x[0] - y[0]);
  const pieces: [number, number][] = [];
  let cursor = 0;
  for (const [lo, hi] of inside) {
    if (lo > cursor) pieces.push([cursor, Math.min(lo, 1)]);
    cursor = Math.max(cursor, hi);
    if (cursor >= 1) break;
  }
  if (cursor < 1) pieces.push([cursor, 1]);
  return pieces;
}

/* Cuts a simplified ghost geometry's runs at the focused
   remainder's corridor: the parts of each run lying within
   GHOST_TRIM_CORRIDOR_M of the remainder's polyline are
   removed, splitting runs at the corridor's entry AND exit
   crossings (segmentOutsidePieces solves each segment's
   intersection with the corridor, so a segment is split
   mid-way too, not only where its endpoints straddle the
   boundary). Applied to the simplification's OUTPUT, never
   written back into its cache: the cached geometry stays
   the canonical remainder. Exported for the tests. */
export function cutGeometryByCorridor(
  geometry: GeoJsonLineGeometry,
  cuts: readonly PathLeg[],
): GeoJsonLineGeometry {
  const cutSegs: [
    readonly [number, number],
    readonly [number, number],
  ][] = [];
  for (const leg of cuts) {
    for (let i = 0; i + 1 < leg.coords.length; i++) {
      cutSegs.push([leg.coords[i]!, leg.coords[i + 1]!]);
    }
    if (leg.coords.length === 1) {
      cutSegs.push([leg.coords[0]!, leg.coords[0]!]);
    }
  }
  const coordinates: [number, number][][] = [];
  for (const run of geometry.coordinates) {
    let current: [number, number][] = [];
    const flush = () => {
      if (current.length >= 2) coordinates.push(current);
      current = [];
    };
    const pushPoint = (point: [number, number]) => {
      const last = current[current.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) {
        current.push(point);
      }
    };
    const at = (
      p: [number, number],
      q: [number, number],
      t: number,
    ): [number, number] =>
      t === 0
        ? p
        : t === 1
          ? q
          : [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    /* Whether the previous segment's last kept piece ended
       at its far vertex, so this segment's first piece
       continues the same sub-run instead of starting one. */
    let continues = false;
    for (let i = 0; i + 1 < run.length; i++) {
      const p: [number, number] = [run[i]![0]!, run[i]![1]!];
      const q: [number, number] = [run[i + 1]![0]!, run[i + 1]![1]!];
      const pieces = segmentOutsidePieces(p, q, cuts, cutSegs);
      if (pieces.length === 0) {
        flush();
        continues = false;
        continue;
      }
      for (const [t0, t1] of pieces) {
        if (!(t0 === 0 && continues)) flush();
        pushPoint(at(p, q, t0));
        pushPoint(at(p, q, t1));
        continues = t1 === 1;
        if (!continues) flush();
      }
    }
    flush();
  }
  return { type: "MultiLineString", coordinates };
}

/* The focused line's ghost trim (subtask 1680, review round
   1): while a line is focused, its own unridden remainder
   repaints at midway strength on the focus layer, and the
   ghost must not ALSO paint those stretches underneath — the
   two translucent paints stack and shift the remainder's hue
   (on 山手線's loop the 東北線 blue and 東海道線 orange ghosts
   bled into the unified green). The exclusion runs in two
   stages, both scoped to the remainder's formal-line keys:
   first the span-precise subtraction — graph edge +
   [fromT, toT], the frame both computations share — cuts
   the remainder's own strand out of the ghost; then the
   simplified geometry's runs are cut at the remainder's
   corridor (GHOST_TRIM_CORRIDOR_M), because a formal line's
   shape carries parallel strands for the same corridor
   that the edge frame cannot tell apart. A shared
   formal line keeps its ghost everywhere else （東北線 north
   of 田端， 東海道線 beyond 品川）: the old key-wide layer
   filter could not express that, and it keyed off the
   PAINTED legs' keys, which need not span the keys the
   remainder runs on at all (a west-side-only 山手線 ride
   paints only the 山手線 key, but its remainder runs on all
   three). Runs on the main thread over just the touched keys
   (ghostLegsForKey), at focus-tap pace; the canonical features
   stay untouched in the caller's state, and clearing the
   focus re-applies them as they are. */
export function trimUnriddenGhostFeatures(
  features: readonly UnriddenLineFeature[],
  coverage: LineCoverage,
  asset: Readonly<Record<string, { color: string }>>,
  remainderLegs: readonly PathLeg[],
): UnriddenLineFeature[] {
  if (remainderLegs.length === 0) return [...features];
  const cutsByKey = new Map<string, PathLeg[]>();
  for (const leg of remainderLegs) {
    const list = cutsByKey.get(leg.key) ?? [];
    list.push(leg);
    cutsByKey.set(leg.key, list);
  }
  /* Contact points for the touched keys: the painted legs'
     endpoints (the same pins the canonical computation uses,
     so the surviving geometry keeps its shape) plus the
     remainder legs' own endpoints — the trim's cut points
     must survive simplification exactly, or the ghost and
     the midway paint would drift apart at the boundary. */
  const contactsByKey = new Map<string, Set<string>>();
  const addContact = (key: string, point: readonly [number, number]) => {
    let set = contactsByKey.get(key);
    if (!set) {
      set = new Set<string>();
      contactsByKey.set(key, set);
    }
    set.add(ghostPointKey(point as [number, number]));
  };
  for (const [, painted] of coverage.perServiceLegs) {
    if (painted.unknown) continue;
    for (const leg of painted.legs) {
      if (!cutsByKey.has(leg.key)) continue;
      for (const end of [
        leg.coords[0]!,
        leg.coords[leg.coords.length - 1]!,
      ]) {
        addContact(leg.key, end);
      }
    }
  }
  for (const leg of remainderLegs) {
    for (const end of [
      leg.coords[0]!,
      leg.coords[leg.coords.length - 1]!,
    ]) {
      addContact(leg.key, end);
    }
  }
  const geometries = asset as unknown as LineGeometryMap;
  return features.flatMap((feature) => {
    const key = feature.properties.key;
    const cuts = cutsByKey.get(key);
    if (!cuts) return [feature];
    const entry = asset[key];
    if (!entry) return [];
    const trimmed = subtractLegSpans(
      ghostLegsForKey(coverage, geometries, key),
      cuts,
    );
    if (trimmed.length === 0) return [];
    /* The corridor stage runs on the simplified geometry:
       parallel strands of the same corridor that the edge
       frame cannot tell apart are cut out of its runs, while
       the runs' parts outside the corridor survive — a leg
       straddling the corridor's end is split, not dropped. */
    const geometry = cutGeometryByCorridor(
      simplifyGhostRemainder(key, trimmed, contactsByKey.get(key)),
      cuts,
    );
    if (geometry.coordinates.length === 0) return [];
    return [
      {
        type: "Feature" as const,
        properties: { key, color: entry.color },
        geometry,
      },
    ];
  });
}

/* The worker protocol. A request carries the wire and a
   sequence number the client hands out; the response echoes
   the sequence so a late answer to a superseded request is
   recognized and dropped, and carries the coverage key the
   client computed for the wire, so the apply path can check
   the result against the CURRENT ledger before it touches the
   map (review round 3, finding 1). */
export type GhostWorkerRequest = {
  type: "unridden-ghost-compute";
  seq: number;
  coverageKey: string;
  coverage: GhostCoverageWire;
};

export type GhostWorkerResponse = {
  type: "unridden-ghost-result";
  seq: number;
  coverageKey: string;
  features: UnriddenLineFeature[];
};
