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

/* Cuts a simplified ghost geometry's runs at the focused
   remainder's corridor: the parts of each run lying within
   GHOST_TRIM_CORRIDOR_M of the remainder's polyline are
   removed, splitting runs at the crossing points (linear in
   the endpoint distances — ample at this scale). Applied to
   the simplification's OUTPUT, never written back into its
   cache: the cached geometry stays the canonical remainder. */
function cutGeometryByCorridor(
  geometry: GeoJsonLineGeometry,
  cuts: readonly PathLeg[],
): GeoJsonLineGeometry {
  const coordinates: [number, number][][] = [];
  for (const run of geometry.coordinates) {
    let current: [number, number][] = [];
    const flush = () => {
      if (current.length >= 2) coordinates.push(current);
      current = [];
    };
    let prev: [number, number] | null = null;
    let prevDist = Infinity;
    for (const raw of run) {
      const point: [number, number] = [raw[0]!, raw[1]!];
      const dist = pointToLegsM(point, cuts);
      if (prev !== null && (prevDist <= GHOST_TRIM_CORRIDOR_M) !== (dist <= GHOST_TRIM_CORRIDOR_M)) {
        /* The segment crosses the corridor boundary: end the
           current sub-run at the crossing (or start a new one
           there). */
        const span = prevDist - dist;
        const t =
          span === 0
            ? 0
            : Math.max(
                0,
                Math.min(1, (prevDist - GHOST_TRIM_CORRIDOR_M) / span),
              );
        const crossing: [number, number] = [
          prev[0] + (point[0] - prev[0]) * t,
          prev[1] + (point[1] - prev[1]) * t,
        ];
        if (prevDist > GHOST_TRIM_CORRIDOR_M) {
          current.push(crossing);
          flush();
        } else {
          current = [crossing];
        }
      }
      if (dist > GHOST_TRIM_CORRIDOR_M) {
        current.push(point);
      } else {
        flush();
      }
      prev = point;
      prevDist = dist;
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
