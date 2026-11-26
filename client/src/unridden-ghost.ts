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
  ghostLineLegs,
  type LineCoverage,
  type LineGeometryMap,
  type PathLeg,
} from "./line-geometry";
import {
  ghostPointKey,
  simplifyGhostRemainder,
} from "./ghost-line-geometry";
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
