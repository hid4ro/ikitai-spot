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
  recordedSectionFitsService,
  serviceById,
  serviceIsLoop,
  serviceOrderedStations,
  stationRefById,
  usableRiddenService,
  type FullPathSnapshot,
  type RiddenServiceLink,
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

/* Distance from a point to a MultiLineString geometry in metres:
   the nearest point-to-segment distance over every piece, on the
   same local projection nearestOnSegment uses — so a point beside
   the middle of a long straight counts as near, not only a point
   beside a vertex. Null when the geometry carries no segment at
   all (no points, or only lone points). */
export function distanceToLineGeometryM(
  point: LngLat,
  geometry: GeoJsonLineGeometry,
): number | null {
  let best: number | null = null;
  for (const segment of geometry.coordinates) {
    for (let i = 0; i < segment.length - 1; i++) {
      const near = nearestOnSegment(
        point,
        segment[i]! as LngLat,
        segment[i + 1]! as LngLat,
      );
      if (best === null || near.distanceM < best) best = near.distanceM;
    }
  }
  return best;
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

/* A station-throat gap is a dead end a short hop from another
   node while the graph's own way round is far longer (subtask
   1613): 150 m is enough for the real gap (the 京王線 新宿
   throat is ~90 m) and the join must save over a kilometre, so
   a terminus joined to the next node along its own chain — where
   the hop and the detour are the same stretch — never qualifies. */
export const GRAPH_THROAT_MAX_M = 150;
export const GRAPH_THROAT_SAVE_KM = 1;

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

/* Dijkstra over an edge list (no adjacency map yet — the throat
   healing in buildLineGraph runs before adj is built). Returns
   the shortest node-to-node distance, or null when unjoined. */
function detourKm(
  edges: readonly GraphEdge[],
  from: number,
  to: number,
): number | null {
  const adj = new Map<number, { to: number; wKm: number }[]>();
  for (const edge of edges) {
    const ab = adj.get(edge.a) ?? [];
    ab.push({ to: edge.b, wKm: edge.lengthKm });
    adj.set(edge.a, ab);
    const ba = adj.get(edge.b) ?? [];
    ba.push({ to: edge.a, wKm: edge.lengthKm });
    adj.set(edge.b, ba);
  }
  const dist = new Map<number, number>();
  const done = new Set<number>();
  dist.set(from, 0);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!done.has(node) && d < best) {
        best = d;
        u = node;
      }
    }
    if (u === -1 || u === to) break;
    done.add(u);
    for (const hop of adj.get(u) ?? []) {
      const nd = dist.get(u)! + hop.wKm;
      if (nd < (dist.get(hop.to) ?? Infinity)) dist.set(hop.to, nd);
    }
  }
  const d = dist.get(to);
  return d === undefined ? null : d;
}

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
  /* Second healing pass — station-throat gaps (subtask 1613).
     N02 can draw one station throat as two chains that meet at
     the far end but leave a gap at the station end, inside ONE
     component — the 京王線 新宿 throat: the 新線 chain ends ~90 m
     from the 本線 chain's 新宿 node, so the component healing
     above never joins them, and a 新宿→初台 route detours ~5 km
     round the far end instead of taking the throat. A dead-end
     node whose nearest other node is a short straight hop away,
     while the graph's own way round is over a kilometre longer,
     is such a gap: bridge it. The detour test is what keeps this
     from joining a line's terminus to the next node along its own
     chain (there the hop and the detour are the same stretch, so
     nothing is saved) — only a genuine missing connection saves
     real distance. Bridges are marked bridge: true, like the
     component joins above. Shortest hop first, one at a time, so
     each new bridge is judged on the graph it actually joins. */
  for (;;) {
    const degree = new Map<number, number>();
    for (const edge of edges) {
      degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
      degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
    }
    let best: { u: number; v: number; dM: number } | null = null;
    for (let u = 0; u < nodes.length; u++) {
      if (degree.get(u) !== 1) continue;
      let nearest: { v: number; dM: number } | null = null;
      for (let v = 0; v < nodes.length; v++) {
        if (v === u) continue;
        const dM = haversineKm(nodes[u]!, nodes[v]!) * 1000;
        if (
          dM > 0 &&
          dM <= GRAPH_THROAT_MAX_M &&
          (!nearest || dM < nearest.dM)
        ) {
          nearest = { v, dM };
        }
      }
      if (!nearest) continue;
      const detour = detourKm(edges, u, nearest.v);
      if (detour == null) continue;
      if (detour - nearest.dM / 1000 <= GRAPH_THROAT_SAVE_KM) continue;
      if (!best || nearest.dM < best.dM) {
        best = { u, v: nearest.v, dM: nearest.dM };
      }
    }
    if (!best) break;
    edges.push({
      id: edges.length,
      a: best.u,
      b: best.v,
      pts: [nodes[best.u]!, nodes[best.v]!],
      lengthKm: best.dM / 1000,
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
/* A via list cut from a stored snapshot is only trusted when
   every entry is a well-formed station ref; a malformed one is
   dropped (the plain shortest route stands in) rather than
   crashing the path. */
function isStationRefList(value: unknown): value is StationRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { name?: unknown }).name === "string" &&
        Number.isFinite((entry as { lng?: unknown }).lng) &&
        Number.isFinite((entry as { lat?: unknown }).lat),
    )
  );
}

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
        ...(isStationRefList(s.via) ? { via: s.via } : {}),
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
    /* A segment with via runs leg by leg through the named
       stations (subtask 1613): one formal-line key can carry two
       branches between the same endpoints, and the graph's
       shortest path alone would always pick the same branch. */
    const stops = [segment.from, ...(segment.via ?? []), segment.to];
    const sectionLegs: PathLeg[] = [];
    let sectionMaxProjM = 0;
    let joined = true;
    for (let i = 0; i < stops.length - 1; i++) {
      const section = graphSectionLegs(
        graph,
        [stops[i]!.lng, stops[i]!.lat],
        [stops[i + 1]!.lng, stops[i + 1]!.lat],
      );
      if (!section) {
        joined = false;
        break;
      }
      sectionLegs.push(...section.legs);
      sectionMaxProjM = Math.max(sectionMaxProjM, section.maxProjM);
    }
    if (!joined) {
      missing.push(
        `${segment.formalLineKey}: ${segment.from.name}〜${segment.to.name} does not join`,
      );
      approximate = true;
      continue;
    }
    if (sectionMaxProjM > APPROXIMATE_PROJECTION_M) approximate = true;
    maxProjM = Math.max(maxProjM, sectionMaxProjM);
    legs.push(...sectionLegs);
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
  /* A direction-less loop section has no recorded way round:
     resolve it the same way coveredBlockIds does — the shorter
     way by station steps — so the drawing and the block
     picker's check column agree (review round 2, medium). The
     old code took the [min, max] arc-kilometre range, which at
     the seam station （品川, projected at either end of the
     path) flips to the long way round: 大崎→田端 drew via
     渋谷・新宿 while the picker marked the 東京 side, and
     品川→新宿 drew via 東京 while the picker marked b1・b2.
     Endpoints the master does not list keep the old behaviour
     (a migrated section like 大崎→目黒, whose far end is no
     ordered station). */
  let resolvedDirection = direction ?? null;
  if (isLoop && !resolvedDirection) {
    const ordered = serviceOrderedStations(path.serviceId);
    const n = ordered.length - 1;
    const indexOf = (station: StationRef): number => {
      const idx = ordered.findIndex((s) => s.id === station.id);
      if (idx < 0) return -1;
      return idx === ordered.length - 1 ? 0 : idx;
    };
    const fromIdx = indexOf(from);
    const toIdx = indexOf(to);
    if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx && n > 0) {
      const forward = (((toIdx - fromIdx) % n) + n) % n;
      const backward = (((fromIdx - toIdx) % n) + n) % n;
      resolvedDirection = forward <= backward ? "outer" : "inner";
    }
  }
  /* Arc positions of both stations on the oriented path. */
  const oriented =
    isLoop && resolvedDirection === "inner"
      ? reverseServicePath(path)
      : path;
  const fromArc = projectOnServicePath(oriented, [from.lng, from.lat]);
  const toArc = projectOnServicePath(oriented, [to.lng, to.lat]);
  if (!fromArc || !toArc) return null;
  /* Snap to the path ends: a station's recorded point sits off
     the track, so its nearest point on the path can land a few
     hundred metres past the path's own start (or short of its
     end) — without the snap, blocks that tile a service would
     leave slivers uncovered at the ends and never complete it.
     The snap reaches the documented maximum station offset
     (APPROXIMATE_PROJECTION_M, 300 m): the old 0.1 km snap left
     0.12–0.17 km slivers on three services (stage 2 review,
     H-2), so selecting every block never completed them. */
  const END_SNAP_KM = 0.3;
  let fromKm = fromArc.arcKm;
  let toKm = toArc.arcKm;
  if (fromKm < END_SNAP_KM) fromKm = 0;
  if (fromKm > oriented.totalKm - END_SNAP_KM) fromKm = oriented.totalKm;
  if (toKm < END_SNAP_KM) toKm = 0;
  if (toKm > oriented.totalKm - END_SNAP_KM) toKm = oriented.totalKm;
  let startKm = fromKm;
  let endKm = toKm;
  if (isLoop && resolvedDirection) {
    /* Running order on the oriented path; wrap past the seam. */
    if (endKm <= startKm) endKm += oriented.totalKm;
  } else if (endKm < startKm) {
    /* A section is undirected off a loop: take it in running
       order. The same branch covers a loop section whose
       endpoints the master does not list (no step count to
       resolve a direction from). */
    [startKm, endKm] = [endKm, startKm];
  }
  if (endKm - startKm < 1e-9) return null;
  const legs = sliceServicePath(oriented, startKm, endKm);
  if (legs.length === 0) return null;
  if (isLoop && resolvedDirection === "inner") {
    /* The legs above were sliced off the REVERSED path, so
       their fromT/toT run in the reversed frame (t = 0 at the
       edge's far end). Coverage merges ranges per graph edge
       (EdgeCoverage), so a reversed leg's range must be mapped
       back to the edge's own frame — otherwise a stretch the
       inner clip shares with an outer clip counts twice: the
       same edge span arrives as [0, 0.5] from one side and
       [0.5, 1] from the other, and the union keeps both
       (review round 1, medium: 新宿→大崎 inner + 大崎→目黒
       counted 8.686 km for an 8.578 km stretch). The coords
       stay as sliced — a polyline paints the same backwards —
       only the t frame is canonicalised. */
    for (const leg of legs) {
      const fromT = 1 - leg.toT;
      const toT = 1 - leg.fromT;
      leg.fromT = fromT;
      leg.toT = toT;
    }
  }
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

/* The color a service's legs paint in when the service master
   unifies them (ServiceMasterEntry.paintColorKey): the asset
   color of the service's representative formal line, or null
   when the service has no unification — the caller then falls
   back to each leg's own formal-line color. A paintColorKey
   that names no asset entry also yields null, so a master typo
   degrades to the per-leg colors instead of painting nothing. */
export function servicePaintColor(
  serviceId: string,
  geometries: LineGeometryMap,
): string | null {
  const key = serviceById(serviceId)?.paintColorKey;
  if (!key) return null;
  return geometries[key]?.color ?? null;
}

/* The color ONE leg paints with in a feature the map builds —
   the single decision behind the normal overlay, the focus
   highlight and the remainder focus (subtask 1680, review
   round 1, finding 3: the decision lives here so the tests
   verify the colors the features actually carry, not just
   the resolver). A paint-unified service's representative
   color wins; otherwise the leg's own formal-line color.
   Null when neither exists — the normal overlay skips such
   a leg, the focus layers substitute their signal color. */
export function legPaintColor(
  serviceId: string | null,
  legKey: string,
  geometries: LineGeometryMap,
): string | null {
  const unified = serviceId ? servicePaintColor(serviceId, geometries) : null;
  return unified ?? geometries[legKey]?.color ?? null;
}

/* The features the map builds from legs — the normal overlay,
   the focus highlight and the remainder focus each have one
   builder here, shared verbatim between App.tsx and the
   tests (subtask 1680, review round 2, finding 3: the fix2
   tests rebuilt the features inside the test, so a call site
   dropping legPaintColor would still have passed; building
   through these, the colors the map's setData receives are
   the colors the tests assert). The signal orange is the
   focus layers' fallback for a leg with no color at all —
   the pre-2026-11-25 paint. */
export const FOCUS_FALLBACK_COLOR = "#ea580c";

export type PaintedLegFeature = {
  type: "Feature";
  properties: {
    key: string;
    serviceId: string;
    color: string;
    unknown: boolean;
  };
  geometry: {
    type: "LineString";
    coordinates: readonly [number, number][];
  };
};

/* One painted leg's normal-overlay feature, or null when the
   leg has no color at all — the overlay skips such a leg. */
export function paintedLegFeature(
  serviceId: string,
  leg: PathLeg,
  unknown: boolean,
  geometries: LineGeometryMap,
): PaintedLegFeature | null {
  const color = legPaintColor(serviceId, leg.key, geometries);
  if (color === null) return null;
  return {
    type: "Feature",
    properties: { key: leg.key, serviceId, color, unknown },
    geometry: { type: "LineString", coordinates: leg.coords },
  };
}

/* The normal overlay's whole feature list — one feature per
   painted leg of every service in the coverage, legs with no
   color at all skipped. This is the exact array the component
   hands to the visited-lines source as its data (subtask
   1680, review round 3, finding 2: the loop lived inside the
   component's useMemo, so no test could see the colors the
   source actually receives; building the list here puts the
   normal path under the same assertion as the focus paths —
   see line-map-paint.test.ts). */
export function paintedLineFeatures(
  perServiceLegs: LineCoverage["perServiceLegs"],
  geometries: LineGeometryMap,
): PaintedLegFeature[] {
  const features: PaintedLegFeature[] = [];
  for (const [serviceId, painted] of perServiceLegs) {
    for (const leg of painted.legs) {
      const feature = paintedLegFeature(
        serviceId,
        leg,
        painted.unknown,
        geometries,
      );
      if (feature) features.push(feature);
    }
  }
  return features;
}

export type FocusLegFeature = {
  type: "Feature";
  properties: { key: string; color: string };
  geometry: {
    type: "LineString";
    coordinates: readonly [number, number][];
  };
};

/* One remainder leg's focus feature: the leg's key and the
   color legPaintColor decides, with the signal fallback. */
export function remainderLegFeature(
  serviceId: string | null,
  leg: { key: string; coords: readonly [number, number][] },
  geometries: LineGeometryMap,
): FocusLegFeature {
  return {
    type: "Feature",
    properties: {
      key: leg.key,
      color:
        legPaintColor(serviceId, leg.key, geometries) ??
        FOCUS_FALLBACK_COLOR,
    },
    geometry: { type: "LineString", coordinates: leg.coords },
  };
}

export type FocusSectionFeature = {
  type: "Feature";
  properties: { key: string; serviceId: string; color: string };
  geometry: {
    type: "LineString";
    coordinates: readonly [number, number][];
  };
};

/* One painted leg's focus-highlight feature: the leg's own
   color decision (the serviceId rides along so a tap on the
   highlight resolves to the same service), with the signal
   fallback. */
export function focusSectionFeature(
  serviceId: string,
  leg: { key: string; coords: readonly [number, number][] },
  geometries: LineGeometryMap,
): FocusSectionFeature {
  return {
    type: "Feature",
    properties: {
      key: leg.key,
      serviceId,
      color:
        legPaintColor(serviceId, leg.key, geometries) ??
        FOCUS_FALLBACK_COLOR,
    },
    geometry: { type: "LineString", coordinates: leg.coords },
  };
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
     flagged unknown so the map paints it as a thin solid line
     instead of a ridden section. The painted length IS the
     counted length for every service except an unknown one,
     whose legs are paint-only and count nothing (see
     computeLineCoverage). */
  perServiceLegs: ReadonlyMap<
    string,
    { legs: readonly PathLeg[]; unknown: boolean }
  >;
  /* Per service: the path minus ITS OWN painted legs — the
     stretches the service itself has not ridden yet (subtask
     1635) — with every OTHER service's painted spans cut out
     as well (subtask 1648): the focused line's midway paint
     reads this, and a stretch already painted solid as some
     other service's ride must not resurface at midway
     strength under this service's focus. The focused line's
     midway paint reads this, not the ghost's per-key
     remainder: a branch service that only touches a slice of
     a formal line (むさしの号 on 東北線) must not paint the
     whole line's remainder. A full ride leaves nothing; an
     unknown ride's legs are its whole path, so it leaves
     nothing too. */
  perServiceUnriddenLegs: ReadonlyMap<string, readonly PathLeg[]>;
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

type RecordedSection = {
  fromStationId: string;
  toStationId: string;
  direction: "inner" | "outer" | null;
  blockId?: string | null;
  recordedServiceId?: string | null;
};

type RecordedRiddenLine = RiddenServiceLink & {
  recordedServiceId?: string | null;
  rideState: "unknown" | "partial" | "full";
  fromStationId: string | null;
  toStationId: string | null;
  pathSnapshot: string | null;
  sections?: readonly RecordedSection[];
};

/* The intervals attributable to this link, using the same route
   evidence as link confirmation. Both the map and the block picker
   use these intervals. */
export function riddenLineIntervals(
  row: RecordedRiddenLine,
  serviceId: string,
): RideInterval[] {
  const intervals: RideInterval[] = [];
  const addInterval = (section: RecordedSection) => {
    if (!recordedSectionFitsService(serviceId, section)) return;
    const from = stationRefById(section.fromStationId);
    const to = stationRefById(section.toStationId);
    const { direction } = section;
    if (from && to) intervals.push({ serviceId, from, to, direction });
  };
  if (row.rideState === "partial" && row.fromStationId && row.toStationId) {
    addInterval({
      fromStationId: row.fromStationId,
      toStationId: row.toStationId,
      direction: null,
      recordedServiceId: row.recordedServiceId,
    });
  }
  for (const section of row.sections ?? []) {
    addInterval(section);
  }
  return intervals;
}

/* Build paths and distances from saved rides. A full ride's snapshot
   or recorded service, when available, must fit the current link.
   Partial rides contribute only their attributable intervals. Paths
   with no intervals are painted thin and count zero kilometres. */
export function computeRiddenLineCoverage(
  rows: readonly RecordedRiddenLine[],
  geometries: LineGeometryMap,
  totalLines: number,
): LineCoverage {
  const intervals = new Map<string, RideInterval[]>();
  const fullServiceIds = new Set<string>();
  const servicePaths = new Map<string, ServicePath>();
  /* Contributions per service, in row order: the first
     contributing row's fitting snapshot builds the path (the
     pre-hold behaviour), full flags and intervals accumulate. */
  const contributions = new Map<
    string,
    {
      service: ServiceMasterEntry;
      snapshot: FullPathSnapshot | null;
      full: boolean;
      intervals: RideInterval[];
    }
  >();
  for (const row of rows) {
    const service = usableRiddenService(row);
    if (!service) continue;
    const snapshot = parseFullPathSnapshot(row.pathSnapshot);
    const snapshotFits =
      snapshot == null || snapshot.pathId === service.pathId;
    const fullRideFits = snapshot
      ? snapshotFits
      : row.recordedServiceId == null || row.recordedServiceId === service.id;
    if (row.rideState === "full" && !fullRideFits) {
      /* Held: a full ride recorded on another service. */
      continue;
    }
    let contribution = contributions.get(service.id);
    if (!contribution) {
      contribution = {
        service,
        snapshot: snapshotFits ? snapshot : null,
        full: false,
        intervals: [],
      };
      contributions.set(service.id, contribution);
    }
    if (row.rideState === "full") {
      contribution.full = true;
    } else if (row.rideState === "partial") {
      contribution.intervals.push(...riddenLineIntervals(row, service.id));
    }
  }
  for (const [serviceId, contribution] of contributions) {
    servicePaths.set(
      serviceId,
      buildServicePath(contribution.service, geometries, contribution.snapshot),
    );
    if (contribution.full) fullServiceIds.add(serviceId);
    if (contribution.intervals.length > 0) {
      intervals.set(serviceId, contribution.intervals);
    }
  }
  return computeLineCoverage(
    intervals,
    fullServiceIds,
    servicePaths,
    geometries,
    totalLines,
  );
}

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
  const perServiceUnriddenLegs = new Map<string, readonly PathLeg[]>();
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
       path too — flagged unknown, so the map draws it thin
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
    /* The service's own unridden remainder (subtask 1635):
       the path with exactly these painted spans cut out — the
       same path object the clips above were sliced from, so
       the edge frames agree by construction. */
    perServiceUnriddenLegs.set(serviceId, serviceUnriddenLegs(path, legs));
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
  /* Second pass over the remainders (subtask 1648, Codex
     review of subtask 1635, finding 2): the midway paint must
     not draw over a stretch ANOTHER service has ridden either.
     The per-service remainder above cuts only the service's
     own painted spans, so むさしの号's unridden 府中本町→北府中
     kept its midway paint even when a full 武蔵野線 ride had
     already painted that exact stretch solid. Cut every
     service's remainder by the union of all services' painted
     spans, on the same (key, edge, [fromT, toT]) frame — a
     service's own spans are already absent from its remainder,
     so including them in the cuts changes nothing for it.
     Unknown rides' legs stay out of the cuts, the ghost's own
     discipline (paintedSpansByKeyEdge): an unknown ride paints
     thin, the unridden look, so a remainder running under it
     is no double paint. */
  const allPaintedLegs: PathLeg[] = [];
  for (const painted of perServiceLegs.values()) {
    if (painted.unknown) continue;
    allPaintedLegs.push(...painted.legs);
  }
  if (allPaintedLegs.length > 0) {
    for (const [serviceId, remainder] of perServiceUnriddenLegs) {
      if (remainder.length === 0) continue;
      perServiceUnriddenLegs.set(
        serviceId,
        subtractLegSpans(remainder, allPaintedLegs),
      );
    }
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
    perServiceUnriddenLegs,
    perKeyKm,
    perOperatorKm,
    networkRiddenKm,
    completeServiceIds,
    unpreparedLines: Math.max(0, totalLines - masterKeys.size),
  };
}

/* The 路線 tab's ghost, edge by edge (subtask 1456, review round
   1): for each formal line, the drawing shape minus the
   solid-painted ranges — so a partially ridden line keeps
   exactly its unridden stretches as ghost, and a line leaves
   the ghost only when nothing unridden is left on it. No
   threshold: any unpainted stretch, however short, stays as a
   thin line (the user's rule: 乗った区間＝実線、乗ってない区
   間＝薄い線、破線なし）.
 *
 * The subtraction runs on graph edges, the same basis the
   painted legs are measured on: a painted leg names its edge
   and its [fromT, toT] span, so the remainder of an edge is
   the complement of the merged painted spans on it. Bridges
   are not part of the asset shape, so they never appear in the
   ghost — a painted bridge leg draws over the gap, as before.
   Unknown rides paint thin (the unridden look) and count
   nothing, so their legs are not subtracted either: the ghost
   stays under the unknown paint, as before.
 *
 * A line with no painted leg at all keeps its whole shape, and
   a fully ridden service still leaves its line's off-spine
   pieces (parallel strands and spurs the shortest path never
   takes — e.g. a small remainder on 赤羽線 after a full 埼京線
   ride): the ghost is the remainder of the SHAPE, not of the
   service, so the map and the painted distance can only agree
   by construction. */
/* Painted spans per (formal-line key, graph edge), merged
   across services — two services on one key (総武線) or two
   blocks of one service count once. Unknown rides paint thin
   and count nothing, so their legs never enter the spans. */
function paintedSpansByKeyEdge(
  coverage: LineCoverage,
): Map<string, [number, number][]> {
  const covered = new Map<string, [number, number][]>();
  for (const [, painted] of coverage.perServiceLegs) {
    if (painted.unknown) continue;
    for (const leg of painted.legs) {
      const composite = `${leg.key}\u0000${leg.edge}`;
      const list = covered.get(composite) ?? [];
      list.push([leg.fromT, leg.toT]);
      covered.set(composite, list);
    }
  }
  return covered;
}

/* One formal line's ghost legs against a prebuilt span map:
   the line's shape minus the painted spans, edge by edge. */
function ghostLegsFromSpans(
  covered: ReadonlyMap<string, [number, number][]>,
  key: string,
  graph: LineGraph,
): PathLeg[] {
  const legs: PathLeg[] = [];
  for (const edge of graph.edges) {
    if (edge.bridge) continue;
    const ranges = mergeRanges(
      covered.get(`${key}\u0000edge:${edge.id}`) ?? [],
    );
    let cursor = 0;
    for (const [a, b] of ranges) {
      if (a > cursor + 1e-9) legs.push(...sliceEdge(key, edge, cursor, a));
      cursor = Math.max(cursor, b);
    }
    if (cursor < 1 - 1e-9) legs.push(...sliceEdge(key, edge, cursor, 1));
  }
  return legs;
}

/* One formal line's ghost legs (the per-key half of
   ghostLineLegs): the focused line's ghost trim (subtask
   1680, review round 1) recomputes just the keys a remainder
   touches, on the main thread, instead of the whole network. */
export function ghostLegsForKey(
  coverage: LineCoverage,
  geometries: LineGeometryMap,
  key: string,
): readonly PathLeg[] {
  const graph = getLineGraph(key, geometries);
  if (!graph) return [];
  return ghostLegsFromSpans(paintedSpansByKeyEdge(coverage), key, graph);
}

export function ghostLineLegs(
  coverage: LineCoverage,
  geometries: LineGeometryMap,
): ReadonlyMap<string, readonly PathLeg[]> {
  const covered = paintedSpansByKeyEdge(coverage);
  const out = new Map<string, PathLeg[]>();
  for (const key of Object.keys(geometries)) {
    const graph = getLineGraph(key, geometries);
    if (!graph) continue;
    const legs = ghostLegsFromSpans(covered, key, graph);
    if (legs.length > 0) out.set(key, legs);
  }
  return out;
}

/* Legs minus cut spans, on the shared (key, edge, [fromT, toT])
   frame: each leg keeps the parts of its own span the cuts do
   not cover. The cuts name their spans in the same edge frame
   the legs were sliced from, so the subtraction is exact. */
export function subtractLegSpans(
  legs: readonly PathLeg[],
  cuts: readonly {
    key: string;
    edge: string;
    fromT: number;
    toT: number;
  }[],
): PathLeg[] {
  const covered = new Map<string, [number, number][]>();
  for (const cut of cuts) {
    const composite = `${cut.key}\u0000${cut.edge}`;
    const list = covered.get(composite) ?? [];
    list.push([cut.fromT, cut.toT]);
    covered.set(composite, list);
  }
  const out: PathLeg[] = [];
  for (const leg of legs) {
    const ranges = mergeRanges(
      covered.get(`${leg.key}\u0000${leg.edge}`) ?? [],
    );
    let cursor = leg.fromT;
    for (const [a, b] of ranges) {
      if (a > cursor + 1e-9) out.push(...sliceLegSpan(leg, cursor, a));
      cursor = Math.max(cursor, b);
    }
    if (cursor < leg.toT - 1e-9) {
      out.push(...sliceLegSpan(leg, cursor, leg.toT));
    }
  }
  return out;
}

/* One service's own unridden remainder (subtask 1635): the
   service path minus ITS OWN painted legs, edge by edge — the
   same subtraction basis as ghostLineLegs, but scoped to one
   service instead of one formal line's whole asset shape. The
   focused line's midway paint (subtask 1589) used to reuse the
   ghost's per-key remainder, so a branch service that only
   touches a slice of a formal line (むさしの号 on 東北線,
   与野〜大宮) painted the whole line's remainder at midway
   strength — the full Tokyo→Aomori shape, which the reader
   caught on the real device (item 244). The remainder is the
   service's path with its ridden spans cut out: a full ride
   leaves nothing, an unknown ride's legs are its whole path so
   it leaves nothing too (the focus vetoes unknown rows
   regardless), and a partial ride leaves exactly the stretches
   it has not ridden yet. Painted legs share the path legs'
   edge frame — clips are sliced off the same path object
   (sliceServicePath), with the loop inner-clip canonicalised
   back to it — so the spans subtract exactly. */
export function serviceUnriddenLegs(
  path: ServicePath,
  paintedLegs: readonly PathLeg[],
): PathLeg[] {
  return subtractLegSpans(path.legs, paintedLegs);
}

/* The sub-polyline of one path leg between two fractions along
   its graph edge — the same slicing sliceServicePath applies
   when it clips a path (the fractions are in the leg's own
   edge frame, so they map onto the leg's coords by their
   position inside the leg's [fromT, toT] span). */
function sliceLegSpan(leg: PathLeg, fromT: number, toT: number): PathLeg[] {
  const span = leg.toT - leg.fromT;
  if (span <= 1e-9 || toT - fromT < 1e-9) return [];
  const coords = slicePolyline(
    leg.coords,
    leg.lengthKm,
    (fromT - leg.fromT) / span,
    (toT - leg.fromT) / span,
  );
  if (coords.length < 2) return [];
  return [
    {
      ...leg,
      fromT,
      toT,
      coords,
      lengthKm: polylineLengthKm(coords),
    },
  ];
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
   block picker's toggle state. A block counts when the intervals
   run over it end to end — a primary section that only clips a
   block （府中→聖蹟桜ヶ丘 inside 京王線 b3) marks nothing, which
   is honest: the block is not fully ridden. Coverage is judged
   on the directed edges between consecutive ordered stations
   (boundaries interleaved with the stations listed on each
   block), not on the set of stations passed: on a loop, the long
   way round 新宿→渋谷 outer passes both ends of yamanote/b2
   （渋谷〜新宿) without ever running it, so a station set would
   wrongly mark all six blocks (review round 2, medium) — the
   block's single edge （渋谷→新宿) is what the section never
   traverses. The edges are unioned over ALL intervals, so two
   sections that jointly cover a block mark it （京成高砂→東松戸
   plus 東松戸→印旛日本医大 cover hokuso/b1 together, review
   round 2, low). An endpoint the ordered stations do not know
   （聖蹟桜ヶ丘, known only from a migrated ride) still skips
   the interval. On a plain service the interval runs from the
   lower index to the higher one (stored sections are in ride
   order, not running order); on a loop the direction says which
   way round, and without one the shorter way by station steps
   is taken (the same fallback clipServicePath uses, so the
   check column and the drawing agree — review round 2,
   medium). */
export function coveredBlockIds(
  serviceId: string,
  intervals: readonly RideInterval[],
): ReadonlySet<string> {
  const blocks = blocksForService(serviceId);
  const ordered = serviceOrderedStations(serviceId);
  const covered = new Set<string>();
  if (blocks.length === 0 || ordered.length === 0) return covered;
  const isLoop = serviceIsLoop(serviceId);
  /* A loop's ordered stations close on the first station, so
     the distinct positions are ordered.length - 1; the closing
     entry is the same station as position 0. */
  const n = isLoop ? ordered.length - 1 : ordered.length;
  /* Where each block starts and ends in the ordered stations:
     block i runs from its from-boundary to its to-boundary,
     with the block's listed stations between them. Its edges
     are the steps blockStart..blockEnd-1, each numbered by its
     start position (modulo n on a loop, where the last block's
     final step returns to position 0). */
  const blockStart: number[] = [];
  const blockEnd: number[] = [];
  {
    let pos = 0;
    for (const block of blocks) {
      blockStart.push(pos);
      pos += 1 + (block.stations?.length ?? 0);
      blockEnd.push(pos);
    }
  }
  const indexOf = (station: StationRef): number => {
    const idx = ordered.findIndex((s) => s.id === station.id);
    if (idx < 0) return -1;
    return isLoop && idx === ordered.length - 1 ? 0 : idx;
  };
  /* The directed edges the intervals traverse, unioned over
     all of them. An outer walk from fromIdx covers the edges
     starting at fromIdx, fromIdx+1, ...; an inner walk covers
     the edges ending at fromIdx, fromIdx-1, ... */
  const traversed = new Set<number>();
  for (const interval of intervals) {
    const fromIdx = indexOf(interval.from);
    const toIdx = indexOf(interval.to);
    if (fromIdx < 0 || toIdx < 0) continue;
    if (!isLoop) {
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      for (let e = lo; e < hi; e++) traversed.add(e);
    } else {
      const forward = (((toIdx - fromIdx) % n) + n) % n;
      const backward = (((fromIdx - toIdx) % n) + n) % n;
      const direction =
        interval.direction ?? (forward <= backward ? "outer" : "inner");
      const steps = direction === "outer" ? forward : backward;
      for (let step = 0; step < steps; step++) {
        traversed.add(
          direction === "outer"
            ? (fromIdx + step) % n
            : (((fromIdx - 1 - step) % n) + n) % n,
        );
      }
    }
  }
  for (let i = 0; i < blocks.length; i++) {
    let whole = true;
    for (let e = blockStart[i]!; e < blockEnd[i]!; e++) {
      if (!traversed.has(((e % n) + n) % n)) {
        whole = false;
        break;
      }
    }
    if (whole) covered.add(blocks[i]!.id);
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

/* Bounding box of the WHOLE SERVICE a set of painted legs
   belongs to — the legs' own bounds unioned with the service's
   full path (subtask 1589, the reader's request of 2026-11-26:
   a line focus frames the whole line, unridden stretches
   included, not just the ridden section). The "whole line" a
   focus frames is the SERVICE's whole run: for a service that
   is one formal line end to end the two coincide, but a branch
   service runs on only a slice of its formal lines — むさしの号
   touches 東北線 for just 与野〜大宮, while the formal line's
   asset shape runs 東京〜青森. Unioning the asset shapes (the
   pre-1618 behaviour) framed that whole shape, so focusing
   むさしの号 zoomed the map out to all of Japan (subtask 1618,
   the reader's report of 2026-11-27). The path is rebuilt from
   the CURRENT master: a full ride recorded at an older master
   version keeps its snapshot path in the coverage, and those
   painted legs are unioned in here too, so the frame covers
   the recorded run as well. A service whose path cannot be
   built (a segment missing from the asset) contributes nothing
   beyond the painted legs. Null when neither the legs nor the
   path carry any point. */
export function wholeLineBounds(
  service: ServiceMasterEntry,
  legs: readonly PathLeg[],
  geometries: LineGeometryMap,
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const extend = (lng: number, lat: number) => {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  };
  for (const leg of legs) {
    for (const [lng, lat] of leg.coords) extend(lng, lat);
  }
  const path = buildServicePath(service, geometries);
  for (const leg of path.legs) {
    for (const [lng, lat] of leg.coords) extend(lng, lat);
  }
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}
