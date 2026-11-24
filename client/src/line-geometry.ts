/* Stage-2 line geometry (subtask 1421): paint only the ridden
   section of a line, and measure it in kilometres from the map
   shape.
 *
 * The bundled line asset (visited-lines.ts) is a MultiLineString
 * per N02 formal line — a bag of short pieces, in no order, split
 * at junctions and station throats. Summing the pieces would
 * double-count parallel strands and spurs (the 中央線 pieces sum
 * to 274 km for a 211 km line), so this module treats each formal
 * line as a GRAPH: nodes are the pieces' shared endpoints, edges
 * are the pieces. A section between two stations is the SHORTEST
 * PATH through that graph — the spine of the line, never a spur —
 * which is why the measured lengths land within a few percent of
 * the railway kilometres (東京→高尾 51.8 km against 53.1, 東京→千葉
 * 39.0 against 39.2, 新宿→京王八王子 37.6 against 37.9; see
 * line-geometry.test.ts).
 *
 * Distances are therefore approximate by construction (地図形状から
 * の概算距離, per the meeting): the shape wanders a little from
 * the track, a station's recorded point can sit up to ~300 m off
 * it, and a stretch with no shape at all （東京〜神田 on 中央線)
 * contributes nothing and is flagged approximate. What the
 * numbers never do is disagree with the map: the painted length
 * of a section IS its counted length, because both come from the
 * same covered edges (see coverEdges / computeLineCoverage).
 *
 * Sections are stored as station pairs (never as a share of the
 * shape), and resolved here at draw time: a station projects onto
 * its nearest edge, and the section is the graph path between the
 * two projections. A service's path is its segments' paths
 * concatenated in running order; on a loop service the path is
 * oriented in the service's running direction, so a section with
 * a direction (inner/outer) clips the right side of the loop.
 *
 * Kept dependency-light (the asset maps are passed in) so the
 * rules can be regression-tested directly against the real asset
 * — see line-geometry.test.ts. Graphs are built lazily and
 * cached per formal-line key; building one is O(pieces) and a
 * shortest path is O(nodes²) with at most a few hundred nodes. */

import {
  SERVICE_MASTER,
  blocksForService,
  serviceBoundaryStations,
  serviceById,
  serviceIsLoop,
  type FullPathSnapshot,
  type ServiceMasterEntry,
  type StationRef,
} from "../../shared/service-master";
import type { GeoJsonLineGeometry } from "./geojson";

export type LngLat = [number, number];

/* A formal line's geometry as the asset carries it. */
export type LineGeometryEntry = {
  name: string;
  operator: string;
  color: string;
  geometry: GeoJsonLineGeometry;
};

export type LineGeometryMap = Readonly<
  Record<string, LineGeometryEntry>
>;

/* ------------------------------------------------------------------ */
/* Distances                                                          */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) *
      Math.cos((b[1] * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function polylineLengthKm(points: readonly LngLat[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += haversineKm(points[i]!, points[i + 1]!);
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* The graph of one formal line                                       */
/* ------------------------------------------------------------------ */

export type GraphEdge = {
  id: number;
  /* Node ids of the piece's ends (node id = index into nodes). */
  a: number;
  b: number;
  pts: LngLat[];
  lengthKm: number;
  /* True for a synthetic straight join between two components
     whose ends the source data leaves apart (≤ 500 m). A bridge
     is part of the spine: it is painted as a straight segment and
     counted at its straight length. */
  bridge: boolean;
};

export type LineGraph = {
  key: string;
  nodes: LngLat[];
  edges: GraphEdge[];
  adj: ReadonlyMap<number, readonly { to: number; wKm: number; edge: number }[]>;
};

/* Bridges join components the source data leaves apart; 500 m is
   enough for the real gaps (武蔵野線's components sit 439 m
   apart) and far too short to invent a connection anywhere else. */
export const GRAPH_BRIDGE_MAX_M = 500;

/* The projection of a station point onto the graph: the nearest
   point on any edge, as a fraction along that edge by arc length.
   distanceM is how far the recorded station point sits from the
   shape — a section whose endpoint projects far is approximate
   (the shape is missing there, e.g. 東京 on 中央線). */
export type ProjectedPoint = {
  edge: number;
  t: number;
  point: LngLat;
  distanceM: number;
};

const nodeKey = (p: LngLat): string => `${p[0]},${p[1]}`;

export function buildLineGraph(
  key: string,
  geometry: GeoJsonLineGeometry,
): LineGraph {
  const nodeIds = new Map<string, number>();
  const nodes: LngLat[] = [];
  const nodeId = (p: LngLat): number => {
    const k = nodeKey(p);
    let id = nodeIds.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodeIds.set(k, id);
      nodes.push([p[0], p[1]]);
    }
    return id;
  };
  const edges: GraphEdge[] = [];
  for (const piece of geometry.coordinates) {
    if (piece.length < 2) continue;
    const pts = piece.map((p) => [p[0], p[1]] as LngLat);
    edges.push({
      id: edges.length,
      a: nodeId(pts[0]!),
      b: nodeId(pts[pts.length - 1]!),
      pts,
      lengthKm: polylineLengthKm(pts),
      bridge: false,
    });
  }
  /* Union-find over the exact endpoints: the components the
     source data actually connects. */
  const parent = new Array<number>(nodes.length)
    .fill(0)
    .map((_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== x) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (const edge of edges) {
    const ra = find(edge.a);
    const rb = find(edge.b);
    if (ra !== rb) parent[ra] = rb;
  }
  /* Heal the gaps between components with the shortest straight
     joins first (Kruskal-style), so a bridge never shortcuts
     inside a component — it only reconnects what the source
     data left apart. */
  const pairs: { i: number; j: number; dM: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (find(i) === find(j)) continue;
      const dM = haversineKm(nodes[i]!, nodes[j]!) * 1000;
      if (dM > 0 && dM <= GRAPH_BRIDGE_MAX_M) pairs.push({ i, j, dM });
    }
  }
  pairs.sort((a, b) => a.dM - b.dM);
  for (const pair of pairs) {
    const ra = find(pair.i);
    const rb = find(pair.j);
    if (ra === rb) continue;
    parent[ra] = rb;
    edges.push({
      id: edges.length,
      a: pair.i,
      b: pair.j,
      pts: [nodes[pair.i]!, nodes[pair.j]!],
      lengthKm: pair.dM / 1000,
      bridge: true,
    });
  }
  const adj = new Map<number, { to: number; wKm: number; edge: number }[]>();
  const link = (u: number, v: number, wKm: number, edge: number) => {
    const list = adj.get(u) ?? [];
    list.push({ to: v, wKm, edge });
    adj.set(u, list);
  };
  for (const edge of edges) {
    link(edge.a, edge.b, edge.lengthKm, edge.id);
    link(edge.b, edge.a, edge.lengthKm, edge.id);
  }
  return { key, nodes, edges, adj };
}

const graphCache = new Map<string, LineGraph>();

/* The cached graph for a formal-line key, built on first use.
   Returns null when the asset has no geometry for the key. */
export function getLineGraph(
  key: string,
  geometries: LineGeometryMap,
): LineGraph | null {
  const cached = graphCache.get(key);
  if (cached) return cached;
  const entry = geometries[key];
  if (!entry) return null;
  const graph = buildLineGraph(key, entry.geometry);
  graphCache.set(key, graph);
  return graph;
}

/* Test-only: drop the cache (the tests build graphs from synthetic
   geometries under the same keys). */
export function clearLineGraphCache(): void {
  graphCache.clear();
}

/* Nearest point on a segment, in equirectangular metres around the
   segment — good to a few metres over a station's projection. */
function nearestOnSegment(
  p: LngLat,
  a: LngLat,
  b: LngLat,
): { t: number; distanceM: number } {
  const kx = 111320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const ky = 110540;
  const ax = (p[0] - a[0]) * kx;
  const ay = (p[1] - a[1]) * ky;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * ky;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (ax * bx + ay * by) / len2;
  t = Math.max(0, Math.min(1, t));
  return { t, distanceM: Math.hypot(ax - t * bx, ay - t * by) };
}

export function projectOnGraph(
  graph: LineGraph,
  coord: LngLat,
): ProjectedPoint | null {
  let best: ProjectedPoint | null = null;
  for (const edge of graph.edges) {
    let accKm = 0;
    for (let i = 0; i < edge.pts.length - 1; i++) {
      const a = edge.pts[i]!;
      const b = edge.pts[i + 1]!;
      const segKm = haversineKm(a, b);
      const near = nearestOnSegment(coord, a, b);
      if (!best || near.distanceM < best.distanceM) {
        const point: LngLat = [
          a[0] + (b[0] - a[0]) * near.t,
          a[1] + (b[1] - a[1]) * near.t,
        ];
        best = {
          edge: edge.id,
          t:
            edge.lengthKm === 0
              ? 0
              : (accKm + near.t * segKm) / edge.lengthKm,
          point,
          distanceM: near.distanceM,
        };
      }
      accKm += segKm;
    }
  }
  return best;
}

/* Dijkstra over the graph (O(nodes²) selection — at most a few
   hundred nodes per line). Returns the node path and, for each
   hop, the edge taken. */
function shortestPath(
  graph: LineGraph,
  fromNode: number,
  toNode: number,
): { nodes: number[]; edges: number[]; lengthKm: number } | null {
  const n = graph.nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const prevEdge = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[fromNode] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u === -1 || u === toNode) break;
    done[u] = true;
    for (const hop of graph.adj.get(u) ?? []) {
      const nd = dist[u]! + hop.wKm;
      if (nd < dist[hop.to]!) {
        dist[hop.to] = nd;
        prev[hop.to] = u;
        prevEdge[hop.to] = hop.edge;
      }
    }
  }
  if (!Number.isFinite(dist[toNode]!)) return null;
  const nodes: number[] = [];
  const edges: number[] = [];
  let cur = toNode;
  while (cur !== -1) {
    nodes.unshift(cur);
    if (prevEdge[cur] !== -1) edges.unshift(prevEdge[cur]!);
    cur = prev[cur]!;
  }
  return { nodes, edges, lengthKm: dist[toNode]! };
}

/* ------------------------------------------------------------------ */
/* Legs: the unit of a path, a ride, and a coverage record            */
/* ------------------------------------------------------------------ */

/* One covered stretch of one formal line: a span of one graph edge
   (or a synthetic bridge between two nodes), with the polyline to
   paint. `key` is what the coverage unions on; `edge` is the graph
   edge id, or `bridge:<a-node>,<b-node>` for a synthetic join. */
export type PathLeg = {
  key: string;
  edge: string;
  fromT: number;
  toT: number;
  coords: LngLat[];
  lengthKm: number;
};

/* The shortest path between two station points on one formal
   line, as legs. The leads from each station to its projection
   are NOT counted or painted: the shape is the record, and a
   station whose point sits far from it (東京 on 中央線, 1.1 km)
   is what makes the result approximate. Returns null when the
   two projections cannot be joined (disconnected components with
   no bridge in reach). */
export function graphSectionLegs(
  graph: LineGraph,
  fromCoord: LngLat,
  toCoord: LngLat,
): { legs: PathLeg[]; lengthKm: number; maxProjM: number } | null {
  const from = projectOnGraph(graph, fromCoord);
  const to = projectOnGraph(graph, toCoord);
  if (!from || !to) return null;
  const maxProjM = Math.max(from.distanceM, to.distanceM);
  if (from.edge === to.edge) {
    const edge = graph.edges[from.edge]!;
    const legs = sliceEdge(
      graph.key,
      edge,
      Math.min(from.t, to.t),
      Math.max(from.t, to.t),
    );
    return {
      legs,
      lengthKm: legs.reduce((sum, leg) => sum + leg.lengthKm, 0),
      maxProjM,
    };
  }
  const edgeA = graph.edges[from.edge]!;
  const edgeB = graph.edges[to.edge]!;
  /* Four ways to enter/exit the two partial edges; the shortest
     combination wins. */
  let best: {
    legs: PathLeg[];
    lengthKm: number;
  } | null = null;
  const entries: { node: number; leadKm: number; t: number }[] = [
    { node: edgeA.a, leadKm: from.t * edgeA.lengthKm, t: from.t },
    { node: edgeA.b, leadKm: (1 - from.t) * edgeA.lengthKm, t: from.t },
  ];
  const exits: { node: number; leadKm: number; t: number }[] = [
    { node: edgeB.a, leadKm: to.t * edgeB.lengthKm, t: to.t },
    { node: edgeB.b, leadKm: (1 - to.t) * edgeB.lengthKm, t: to.t },
  ];
  for (const entry of entries) {
    for (const exit of exits) {
      const path =
        entry.node === exit.node
          ? { nodes: [entry.node], edges: [], lengthKm: 0 }
          : shortestPath(graph, entry.node, exit.node);
      if (!path) continue;
      const totalKm = entry.leadKm + path.lengthKm + exit.leadKm;
      if (best && totalKm >= best.lengthKm) continue;
      const legs: PathLeg[] = [];
      /* The partial first edge, from the projection to the entry
         node (or the whole edge when the entry node is its far
         end — the slice handles both directions). */
      const first = sliceEdge(
        graph.key,
        edgeA,
        entry.node === edgeA.a ? from.t : from.t,
        entry.node === edgeA.a ? 0 : 1,
      );
      legs.push(...first);
      for (const edgeId of path.edges) {
        const edge = graph.edges[edgeId]!;
        legs.push(...sliceEdge(graph.key, edge, 0, 1));
      }
      const last = sliceEdge(
        graph.key,
        edgeB,
        exit.node === edgeB.a ? 0 : to.t,
        exit.node === edgeB.a ? to.t : 1,
      );
      legs.push(...last);
      best = { legs, lengthKm: totalKm };
    }
  }
  if (!best) return null;
  return { legs: best.legs, lengthKm: best.lengthKm, maxProjM };
}

/* A span of one graph edge as legs: the sub-polyline between two
   fractions along the edge, interpolated at the ends. A bridge
   edge (two points) slices to a straight sub-segment. */
function sliceEdge(
  key: string,
  edge: GraphEdge,
  fromT: number,
  toT: number,
): PathLeg[] {
  const lo = Math.min(fromT, toT);
  const hi = Math.max(fromT, toT);
  if (hi - lo < 1e-9) return [];
  const coords = slicePolyline(edge.pts, edge.lengthKm, lo, hi);
  if (coords.length < 2) return [];
  return [
    {
      key,
      edge: edge.bridge ? `bridge:${edge.a},${edge.b}` : `edge:${edge.id}`,
      fromT: lo,
      toT: hi,
      coords,
      lengthKm: polylineLengthKm(coords),
    },
  ];
}

/* The sub-polyline of `pts` between two fractions of its arc
   length, with interpolated endpoints. */
export function slicePolyline(
  pts: readonly LngLat[],
  totalKm: number,
  fromT: number,
  toT: number,
): LngLat[] {
  if (pts.length < 2 || totalKm <= 0) return [];
  const fromKm = fromT * totalKm;
  const toKm = toT * totalKm;
  const pointAt = (targetKm: number): LngLat => {
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const seg = haversineKm(a, b);
      if (acc + seg >= targetKm || i === pts.length - 2) {
        const t = seg === 0 ? 0 : (targetKm - acc) / seg;
        return [
          a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, t)),
          a[1] + (b[1] - a[1]) * Math.max(0, Math.min(1, t)),
        ];
      }
      acc += seg;
    }
    return pts[pts.length - 1]!;
  };
  const out: LngLat[] = [pointAt(fromKm)];
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = haversineKm(a, b);
    const start = acc;
    const end = acc + seg;
    if (end > fromKm && start < toKm) {
      if (end <= toKm) out.push(b);
    }
    acc = end;
  }
  out.push(pointAt(toKm));
  /* Drop consecutive duplicates (a vertex exactly on a cut). */
  return out.filter(
    (p, i) => i === 0 || p[0] !== out[i - 1]![0] || p[1] !== out[i - 1]![1],
  );
}

/* ------------------------------------------------------------------ */
/* Service paths                                                       */
/* ------------------------------------------------------------------ */

/* A projection further than this from the shape means the shape is
   missing around that station (not that the station is misplaced):
   the section is approximate. 300 m covers every real station
   point in the master (worst is 新宿's 300 m spread); 東京 on
   中央線 projects 1.1 km because the shape starts at 神田. */
export const APPROXIMATE_PROJECTION_M = 300;

export type ServicePath = {
  serviceId: string;
  legs: PathLeg[];
  totalKm: number;
  approximate: boolean;
  /* Segments whose shape is missing or unjoinable (formal-line
     key + why), so the total is a lower bound. */
  missing: string[];
  maxProjM: number;
};

/* A service's whole path: its segments' shortest paths, in
   running order. `snapshot` (a full ride's stored path) overrides
   the current master, so a past full ride reproduces the range it
   was recorded at. */
export function buildServicePath(
  service: ServiceMasterEntry,
  geometries: LineGeometryMap,
  snapshot?: FullPathSnapshot | null,
): ServicePath {
  const legs: PathLeg[] = [];
  const missing: string[] = [];
  let approximate = false;
  let maxProjM = 0;
  const segments = snapshot
    ? snapshot.segments.map((s) => ({
        formalLineKey: s.formalLineKey,
        from: s.from,
        to: s.to,
        approximate: s.approximate,
      }))
    : service.segments;
  for (const segment of segments) {
    if (segment.approximate) approximate = true;
    const graph = getLineGraph(segment.formalLineKey, geometries);
    if (!graph) {
      missing.push(
        `${segment.formalLineKey}: no geometry in the asset`,
      );
      approximate = true;
      continue;
    }
    const section = graphSectionLegs(
      graph,
      [segment.from.lng, segment.from.lat],
      [segment.to.lng, segment.to.lat],
    );
    if (!section) {
      missing.push(
        `${segment.formalLineKey}: ${segment.from.name}〜${segment.to.name} does not join`,
      );
      approximate = true;
      continue;
    }
    if (section.maxProjM > APPROXIMATE_PROJECTION_M) approximate = true;
    maxProjM = Math.max(maxProjM, section.maxProjM);
    legs.push(...section.legs);
  }
  return {
    serviceId: service.id,
    legs,
    totalKm: legs.reduce((sum, leg) => sum + leg.lengthKm, 0),
    approximate,
    missing,
    maxProjM,
  };
}

/* The arc length of a service path (its legs in running order). */
export function servicePathCoords(path: ServicePath): LngLat[][] {
  /* One continuous run per formal-line key change keeps the
     MultiLineString honest about where the shape switches lines. */
  const runs: LngLat[][] = [];
  for (const leg of path.legs) {
    const last = runs[runs.length - 1];
    const first = leg.coords[0]!;
    if (
      last &&
      last[last.length - 1]![0] === first[0] &&
      last[last.length - 1]![1] === first[1]
    ) {
      last.push(...leg.coords.slice(1));
    } else {
      runs.push([...leg.coords]);
    }
  }
  return runs;
}

/* Clips a service path between two stations. The stations
   project onto the path's legs; the clip is the legs between
   their arc positions, in the service's running order — except
   on a loop service, where `direction` picks the side: "inner"
   walks the path backwards (the same loop, opposite way), and a
   clip that crosses the path's seam wraps round. Without a
   direction on a loop, the shorter way round is taken (the
   service's own blocks always carry one, so this is only a
   fallback for hand-entered sections). */
export function clipServicePath(
  path: ServicePath,
  from: StationRef,
  to: StationRef,
  direction?: "inner" | "outer" | null,
): { legs: PathLeg[]; lengthKm: number; approximate: boolean } | null {
  const isLoop = serviceIsLoop(path.serviceId);
  /* Arc positions of both stations on the oriented path. */
  const oriented =
    isLoop && direction === "inner" ? reverseServicePath(path) : path;
  const fromArc = projectOnServicePath(oriented, [from.lng, from.lat]);
  const toArc = projectOnServicePath(oriented, [to.lng, to.lat]);
  if (!fromArc || !toArc) return null;
  /* Snap to the path ends: a station's recorded point sits off
     the track, so its nearest point on the path can land a few
     dozen metres past the path's own start (or short of its
     end) — without the snap, blocks that tile a service would
     leave slivers uncovered at the ends and never complete it. */
  let fromKm = fromArc.arcKm;
  let toKm = toArc.arcKm;
  if (fromKm < 0.1) fromKm = 0;
  if (fromKm > oriented.totalKm - 0.1) fromKm = oriented.totalKm;
  if (toKm < 0.1) toKm = 0;
  if (toKm > oriented.totalKm - 0.1) toKm = oriented.totalKm;
  let startKm = fromKm;
  let endKm = toKm;
  if (isLoop && direction) {
    /* Running order on the oriented path; wrap past the seam. */
    if (endKm <= startKm) endKm += oriented.totalKm;
  } else if (endKm < startKm) {
    /* A section is undirected off a loop: take it in running
       order. */
    [startKm, endKm] = [endKm, startKm];
  }
  if (endKm - startKm < 1e-9) return null;
  const legs = sliceServicePath(oriented, startKm, endKm);
  if (legs.length === 0) return null;
  return {
    legs,
    lengthKm: legs.reduce((sum, leg) => sum + leg.lengthKm, 0),
    approximate:
      path.approximate ||
      fromArc.distanceM > APPROXIMATE_PROJECTION_M ||
      toArc.distanceM > APPROXIMATE_PROJECTION_M,
  };
}

function reverseServicePath(path: ServicePath): ServicePath {
  const legs = [...path.legs].reverse().map((leg) => ({
    ...leg,
    coords: [...leg.coords].reverse(),
    fromT: 1 - leg.toT,
    toT: 1 - leg.fromT,
  }));
  return { ...path, legs };
}

function projectOnServicePath(
  path: ServicePath,
  coord: LngLat,
): { arcKm: number; distanceM: number } | null {
  let best: { arcKm: number; distanceM: number } | null = null;
  let accKm = 0;
  for (const leg of path.legs) {
    for (let i = 0; i < leg.coords.length - 1; i++) {
      const a = leg.coords[i]!;
      const b = leg.coords[i + 1]!;
      const segKm = haversineKm(a, b);
      const near = nearestOnSegment(coord, a, b);
      if (!best || near.distanceM < best.distanceM) {
        best = { arcKm: accKm + near.t * segKm, distanceM: near.distanceM };
      }
      accKm += segKm;
    }
  }
  return best;
}

/* The legs of `path` between two arc positions (startKm..endKm,
   endKm may exceed totalKm on a loop — the slice wraps once). */
function sliceServicePath(
  path: ServicePath,
  startKm: number,
  endKm: number,
): PathLeg[] {
  const total = path.totalKm;
  if (total <= 0) return [];
  /* Unwrap the range into [0, total) pieces. */
  const ranges: [number, number][] = [];
  let s = startKm;
  let e = endKm;
  while (e - s > 1e-9) {
    const chunkEnd = Math.min(e, Math.floor(s / total + 1) * total);
    ranges.push([s % total, chunkEnd % total || total]);
    s = chunkEnd;
  }
  const out: PathLeg[] = [];
  for (const [rs, re] of ranges) {
    let accKm = 0;
    for (const leg of path.legs) {
      const legStart = accKm;
      const legEnd = accKm + leg.lengthKm;
      accKm = legEnd;
      if (legEnd <= rs || legStart >= re) continue;
      const fromT =
        leg.lengthKm === 0
          ? 0
          : leg.fromT +
            ((Math.max(rs, legStart) - legStart) / leg.lengthKm) *
              (leg.toT - leg.fromT);
      const toT =
        leg.lengthKm === 0
          ? 1
          : leg.fromT +
            ((Math.min(re, legEnd) - legStart) / leg.lengthKm) *
              (leg.toT - leg.fromT);
      const coords = slicePolyline(
        leg.coords,
        leg.lengthKm,
        (fromT - leg.fromT) / (leg.toT - leg.fromT || 1),
        (toT - leg.fromT) / (leg.toT - leg.fromT || 1),
      );
      if (coords.length < 2) continue;
      out.push({
        ...leg,
        fromT,
        toT,
        coords,
        lengthKm: polylineLengthKm(coords),
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Coverage: what the map paints, what the graphs count               */
/* ------------------------------------------------------------------ */

/* One recorded ride interval: a station pair on a service (a
   block, a hand-entered section, or one segment of a stored full
   path). The client builds these from a ledger row: its primary
   section + its added sections, or its full-path snapshot. */
export type RideInterval = {
  serviceId: string;
  from: StationRef;
  to: StationRef;
  direction?: "inner" | "outer" | null;
};

/* Merges leg coverage per formal-line key: edge id → covered
   [t0, t1] ranges, so overlapping rides on the same line (two
   services on 総武線, or two blocks of one service) count once.
   A bridge leg counts at its straight length. */
export class EdgeCoverage {
  private ranges = new Map<string, [number, number][]>();

  addLeg(leg: PathLeg): void {
    /* The composite key joins on a separator that cannot appear
       in a formal-line key (which itself contains "|"). */
    const key = `${leg.key}\u0000${leg.edge}`;
    const list = this.ranges.get(key) ?? [];
    list.push([leg.fromT, leg.toT]);
    this.ranges.set(key, list);
  }

  addLegs(legs: readonly PathLeg[]): void {
    for (const leg of legs) this.addLeg(leg);
  }

  /* Covered kilometres on one formal-line key, from the merged
     ranges. Needs the graph to know each edge's full length. */
  kilometresOn(key: string, geometries: LineGeometryMap): number {
    let total = 0;
    for (const [composite, ranges] of this.ranges) {
      const [lineKey, edgeId] = composite.split("\u0000");
      if (lineKey !== key) continue;
      const merged = mergeRanges(ranges);
      const edgeKm = this.edgeLengthKm(key, edgeId!, geometries);
      for (const [a, b] of merged) total += (b - a) * edgeKm;
    }
    return total;
  }

  /* Covered kilometres over all keys. */
  totalKilometres(geometries: LineGeometryMap): number {
    const keys = new Set<string>();
    for (const composite of this.ranges.keys()) {
      keys.add(composite.split("\u0000")[0]!);
    }
    let total = 0;
    for (const key of keys) total += this.kilometresOn(key, geometries);
    return total;
  }

  private edgeLengthKm(
    key: string,
    edgeId: string,
    geometries: LineGeometryMap,
  ): number {
    const graph = getLineGraph(key, geometries);
    if (!graph) return 0;
    if (edgeId.startsWith("edge:")) {
      const edge = graph.edges[Number(edgeId.slice(5))];
      return edge?.lengthKm ?? 0;
    }
    /* bridge:<a-node>,<b-node> — straight by construction. */
    const [, nodes] = edgeId.split(":");
    const [a, b] = (nodes ?? "").split(",").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return haversineKm(graph.nodes[a!]!, graph.nodes[b!]!);
  }
}

function mergeRanges(
  ranges: readonly [number, number][],
): [number, number][] {
  const sorted = [...ranges]
    .map(([a, b]): [number, number] => [Math.min(a, b), Math.max(a, b)])
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1e-9) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

export type ServiceCoverage = {
  serviceId: string;
  displayName: string;
  operator: string;
  riddenKm: number;
  totalKm: number;
  /* A full ride, or sections covering the whole service. */
  complete: boolean;
  approximate: boolean;
  missing: string[];
};

export type LineCoverage = {
  /* Per service: only the distance ridden AS that service (a
     section recorded under 埼京線 never credits 宇都宮線). */
  perService: ReadonlyMap<string, ServiceCoverage>;
  /* The legs the map paints, per service: the clipped sections
     of a partial ride, the whole path of a full ride — and, for
     an unknown ride (no section on record), the whole path too,
     flagged unknown so the map paints it as a thin dashed line
     instead of a ridden section. The painted length IS the
     counted length for every service except an unknown one,
     whose legs are paint-only and count nothing (see
     computeLineCoverage). */
  perServiceLegs: ReadonlyMap<
    string,
    { legs: readonly PathLeg[]; unknown: boolean }
  >;
  /* Deduped ridden distance per formal-line key (what the map
     paints on that key), and per operator (the parent bar: the
     formal-line-based total, matching the painted total). */
  perKeyKm: ReadonlyMap<string, number>;
  perOperatorKm: ReadonlyMap<string, number>;
  /* Whole-network ridden distance (deduped across services). */
  networkRiddenKm: number;
  /* Services ridden end to end. */
  completeServiceIds: readonly string[];
  /* N02 lines the master does not cover yet (for the 未整備n線
     note): the denominator counts them, so the rate stays
     comparable as the master grows. */
  unpreparedLines: number;
};

/* Coverage from ledger rows' ride intervals. `intervals` groups
   intervals by service id; `fullServiceIds` are services with an
   explicit full ride (their whole path counts, from the stored
   snapshot when given). `servicePaths` are the prebuilt paths
   (buildServicePath per service, once). */
export function computeLineCoverage(
  intervals: ReadonlyMap<string, readonly RideInterval[]>,
  fullServiceIds: ReadonlySet<string>,
  servicePaths: ReadonlyMap<string, ServicePath>,
  geometries: LineGeometryMap,
  totalLines: number,
): LineCoverage {
  const perService = new Map<string, ServiceCoverage>();
  const perServiceLegs = new Map<
    string,
    { legs: readonly PathLeg[]; unknown: boolean }
  >();
  const perKeyCoverage = new Map<string, EdgeCoverage>();
  const completeServiceIds: string[] = [];
  const coverFor = (key: string): EdgeCoverage => {
    let cover = perKeyCoverage.get(key);
    if (!cover) {
      cover = new EdgeCoverage();
      perKeyCoverage.set(key, cover);
    }
    return cover;
  };
  for (const [serviceId, path] of servicePaths) {
    const service = serviceById(serviceId);
    if (!service) continue;
    const isFull = fullServiceIds.has(serviceId);
    let approximate = path.approximate;
    const serviceIntervals = intervals.get(serviceId) ?? [];
    /* The legs this service paints: the whole path for a full
       ride, the clipped sections for a partial one. An unknown
       ride has no section to clip to, so it paints its whole
       path too — flagged unknown, so the map draws it dashed
       and it counts nothing (below: unknown legs never reach
       either coverage). */
    const legs: PathLeg[] = [];
    if (isFull) {
      legs.push(...path.legs);
    } else {
      for (const interval of serviceIntervals) {
        const clip = clipServicePath(
          path,
          interval.from,
          interval.to,
          interval.direction ?? null,
        );
        if (!clip) continue;
        if (clip.approximate) approximate = true;
        legs.push(...clip.legs);
      }
    }
    const unknown = !isFull && serviceIntervals.length === 0;
    if (unknown) legs.push(...path.legs);
    perServiceLegs.set(serviceId, { legs, unknown });
    if (!unknown) {
      for (const leg of legs) coverFor(leg.key).addLeg(leg);
    }
    /* A service is complete when it is a full ride, or when its
       sections cover (nearly) its whole path. The per-service
       ridden distance is the union, not the sum: overlapping
       sections count once. */
    const serviceCover = new EdgeCoverage();
    if (!unknown) serviceCover.addLegs(legs);
    const unionKm = serviceCover.totalKilometres(geometries);
    const complete =
      isFull || (path.totalKm > 0 && unionKm >= path.totalKm * 0.999);
    if (complete) completeServiceIds.push(serviceId);
    perService.set(serviceId, {
      serviceId,
      displayName: service.displayName,
      operator: service.operator,
      riddenKm: Math.min(unionKm, path.totalKm),
      totalKm: path.totalKm,
      complete,
      approximate,
      missing: path.missing,
    });
  }
  const perKeyKm = new Map<string, number>();
  const perOperatorKm = new Map<string, number>();
  let networkRiddenKm = 0;
  for (const [key, cover] of perKeyCoverage) {
    const km = cover.kilometresOn(key, geometries);
    perKeyKm.set(key, km);
    networkRiddenKm += km;
    const operator = geometries[key]?.operator;
    if (operator) {
      perOperatorKm.set(operator, (perOperatorKm.get(operator) ?? 0) + km);
    }
  }
  /* N02 lines the master does not cover yet (for the 未整備n線
     note): the denominator counts them, so the rate stays
     comparable as the master grows. Counted from the master
     itself, not from the paths handed in — a partial input must
     not change the note. */
  const masterKeys = new Set<string>();
  for (const entry of SERVICE_MASTER) {
    for (const segment of entry.segments) {
      masterKeys.add(segment.formalLineKey);
    }
  }
  return {
    perService,
    perServiceLegs,
    perKeyKm,
    perOperatorKm,
    networkRiddenKm,
    completeServiceIds,
    unpreparedLines: Math.max(0, totalLines - masterKeys.size),
  };
}

/* The snapshot a full ride stores, parsed back — null when the
   row has no snapshot (a full ride recorded before stage 2, or a
   row whose snapshot fails to parse: the current master stands
   in, and the row is still a full ride). */
export function parseFullPathSnapshot(
  raw: string | null,
): FullPathSnapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { pathId?: unknown }).pathId !== "string" ||
      typeof (parsed as { masterVersion?: unknown }).masterVersion !==
        "string" ||
      !Array.isArray((parsed as { segments?: unknown }).segments)
    ) {
      return null;
    }
    /* A snapshot cut at an older master version is still the
       range that was ridden; keep it (do not fall back to the
       current master, which may have extended the service). */
    return parsed as FullPathSnapshot;
  } catch {
    return null;
  }
}

/* The blocks of a service the given intervals cover WHOLE: the
   block picker's toggle state. A block counts when an interval
   runs over it end to end — a primary section that only clips a
   block （府中→聖蹟桜ヶ丘 inside 京王線 b3) marks nothing, which
   is honest: the block is not fully ridden. Intervals are
   located by their endpoints' boundary indices: on a plain
   service the interval runs from the lower index to the higher
   one (stored sections are in ride order, not running order);
   on a loop the direction says which way round, and without
   one the shorter way is taken (the same fallback
   clipServicePath uses). Intervals with an endpoint that is no
   boundary station are skipped. */
export function coveredBlockIds(
  serviceId: string,
  intervals: readonly RideInterval[],
): ReadonlySet<string> {
  const blocks = blocksForService(serviceId);
  const boundaries = serviceBoundaryStations(serviceId);
  const covered = new Set<string>();
  if (blocks.length === 0 || boundaries.length === 0) return covered;
  const isLoop = serviceIsLoop(serviceId);
  const blockCount = blocks.length;
  const indexOf = (station: StationRef): number =>
    boundaries.findIndex((s) => s.id === station.id);
  for (const interval of intervals) {
    const fromIdx = indexOf(interval.from);
    const toIdx = indexOf(interval.to);
    if (fromIdx < 0 || toIdx < 0) continue;
    if (!isLoop) {
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      for (let i = lo; i < hi && i < blockCount; i++) {
        covered.add(blocks[i]!.id);
      }
      continue;
    }
    /* A loop's boundaries close on the first station, so the
       block count is boundaries.length - 1 and indices wrap
       modulo it. */
    const n = blockCount;
    const forward = (((toIdx - fromIdx) % n) + n) % n;
    const backward = (((fromIdx - toIdx) % n) + n) % n;
    const direction =
      interval.direction ?? (forward <= backward ? "outer" : "inner");
    const steps = direction === "outer" ? forward : backward;
    if (steps === 0) continue;
    /* The first block of the walk: outward it is the block
       starting at fromIdx; inward it is the block ending at
       fromIdx (block i runs boundaries[i]→boundaries[i+1]). */
    let i =
      direction === "outer"
        ? fromIdx % n
        : (((fromIdx - 1) % n) + n) % n;
    for (let step = 0; step < steps; step++) {
      covered.add(blocks[i]!.id);
      i = direction === "outer" ? (i + 1) % n : (i - 1 + n) % n;
    }
  }
  return covered;
}

/* Bounding box of painted legs as [[minLng, minLat], [maxLng,
   maxLat]] — the shape MapLibre's fitBounds takes. Null when the
   legs carry no points at all. */
export function sectionBounds(
  legs: readonly PathLeg[],
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const leg of legs) {
    for (const [lng, lat] of leg.coords) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
