/**
 * Offline script: compute the total length of every N02 formal line
 * and write the results to client/src/line-totals.ts.
 *
 * A formal line's total is the sum, over its connected
 * components, of each component's total — the graph diameter
 * (the longest end-to-end ride along its shape) for a component
 * with dead ends, the edge sum for a pure loop — after the same
 * <=500 m bridging the section code uses. That matches the
 * line's published length: a plain edge sum overcounts by
 * 50–70 km on trunk lines (sidings, yard tracks and parallel
 * strands the N02 shape draws), while the diameter lands within
 * a few kilometres of the timetable length (Tohoku 539 vs 535,
 * Tokaido JR-East 108 vs 105, Kagoshima 279 vs 282, Sanyo 526
 * vs 528). A pure loop has no ends, so its diameter would halve
 * it: for a component with no dead ends (Osaka Loop Line,
 * Disney Resort Line) the total is the edge sum instead. The
 * components are summed,
 * not just the largest one (stage 2 review, M-1): the separated
 * pieces are genuine parts of the same formal line — the
 * Chikuhi Line's two pieces add to 68.1 km against a published
 * 68.3, the Kagoshima Line's to 279.1 against 281.9, the
 * Shinetsu Line's to 175.0 against 181.6. The old
 * largest-only rule dropped the second half of those lines.
 * Only the bridged graph is summed: its <=500 m bridges join
 * pieces the source left apart (a 12 m split on the Sanyo Line,
 * 67 m and 317 m spurs on the Tohoku Line), so summing the raw
 * graph's components would count those spurs twice. The
 * network total rises by about 168 km (26,735.5 → 26,903.9).
 *
 * Run: bun scripts/compute-line-totals.ts
 * Output: client/src/line-totals.ts (generated — do not edit by hand)
 */
import { writeFileSync } from "node:fs";
import { RIDDEN_LINE_GEOMETRIES } from "../client/src/assets/visited-lines";
import { buildLineGraph } from "../client/src/line-geometry";
import { SERVICE_MASTER } from "../shared/service-master";

/* The total of one connected component of `edges`, in km: the
   graph diameter (the longest end-to-end ride) when the component
   has dead ends, the edge sum when it is a pure loop (Osaka Loop
   Line, Disney Resort Line — a diameter would halve it). The
   diameter is the longest shortest path between any two of the
   component's nodes (Dijkstra from every node — a few hundred
   nodes at most per line, and this script runs offline). */
function componentValue(
  edges: readonly { a: number; b: number; lengthKm: number }[],
  nodes: readonly number[],
): number {
  const nodeSet = new Set(nodes);
  /* Adjacency within the component, and each node's degree
     there. */
  const adj = new Map<number, { to: number; wKm: number }[]>();
  const degree = new Map<number, number>();
  let edgeSum = 0;
  for (const edge of edges) {
    if (!nodeSet.has(edge.a) || !nodeSet.has(edge.b)) continue;
    edgeSum += edge.lengthKm;
    const link = (u: number, v: number) => {
      const list = adj.get(u) ?? [];
      list.push({ to: v, wKm: edge.lengthKm });
      adj.set(u, list);
      degree.set(u, (degree.get(u) ?? 0) + 1);
    };
    link(edge.a, edge.b);
    link(edge.b, edge.a);
  }
  /* No dead ends (every node degree >= 2): a pure loop — the
     total is the edge sum, not the diameter. */
  const hasDeadEnd = nodes.some((node) => (degree.get(node) ?? 0) < 2);
  if (!hasDeadEnd) return edgeSum;
  /* Diameter: the longest shortest path between any two nodes.
     Dijkstra from every node (O(nodes^2) selection, same shape
     as the section code's shortest path). */
  let diameter = 0;
  for (const start of nodes) {
    const dist = new Map<number, number>([[start, 0]]);
    const done = new Set<number>();
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (const node of nodes) {
        if (done.has(node)) continue;
        const d = dist.get(node) ?? Infinity;
        if (d < best) {
          best = d;
          u = node;
        }
      }
      if (u === -1) break;
      done.add(u);
      for (const hop of adj.get(u) ?? []) {
        const nd = best + hop.wKm;
        if (nd < (dist.get(hop.to) ?? Infinity)) dist.set(hop.to, nd);
      }
    }
    for (const d of dist.values()) diameter = Math.max(diameter, d);
  }
  return diameter;
}

/* Sum of every connected component's total (see the header) —
   the line total the header describes. The components are found
   by union-find over the node ids; a component's nodes are the
   nodes its edges touch. */
function componentTotal(
  edges: readonly { a: number; b: number; lengthKm: number }[],
  nodeCount: number,
): number {
  if (edges.length === 0 || nodeCount === 0) return 0;
  /* Union-find over the node ids: which component each edge
     belongs to. */
  const parent = new Array<number>(nodeCount).fill(0).map((_, i) => i);
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
  const byRoot = new Map<number, number[]>();
  for (const edge of edges) {
    const root = find(edge.a);
    let nodes = byRoot.get(root);
    if (!nodes) {
      nodes = [];
      byRoot.set(root, nodes);
    }
    if (!nodes.includes(edge.a)) nodes.push(edge.a);
    if (!nodes.includes(edge.b)) nodes.push(edge.b);
  }
  let total = 0;
  for (const nodes of byRoot.values()) total += componentValue(edges, nodes);
  return total;
}

const geometries = RIDDEN_LINE_GEOMETRIES as never;

/** Total length of one formal line, in km (see the header). */
function lineTotalKm(key: string): number {
  const entry = (RIDDEN_LINE_GEOMETRIES as Record<string, { geometry: never }>)[key];
  if (!entry) return 0;
  const graph = buildLineGraph(key, entry.geometry as never);
  /* Only the bridged graph is summed: its bridges join pieces
     the source left apart, and summing the raw graph's
     components would count the near spurs the bridges merge
     twice (Tohoku, Sanyo). The old max(bridged, raw) guard
     against bridge shortcuts is dropped — the one cited case
     (Chikuhi collapsing 42.4 → 25.7) does not occur in the
     current data: Chikuhi has no bridges at all. */
  return componentTotal(graph.edges, graph.nodes.length);
}

const lineTotals: Record<string, number> = {};
const operatorTotals: Record<string, number> = {};
let networkTotal = 0;
for (const key of Object.keys(RIDDEN_LINE_GEOMETRIES)) {
  const total = lineTotalKm(key);
  lineTotals[key] = Math.round(total * 10) / 10;
  networkTotal += total;
  const operator = key.split("|")[1] ?? "不明";
  operatorTotals[operator] = (operatorTotals[operator] ?? 0) + total;
}
for (const operator of Object.keys(operatorTotals)) {
  operatorTotals[operator] = Math.round(operatorTotals[operator] * 10) / 10;
}
networkTotal = Math.round(networkTotal * 10) / 10;

/* Sanity check: the formal lines the master uses, against their
   published lengths. The Yamanote key is known short — its N02
   shape is only the western arc (Shinagawa–Tabata); the loop is
   completed via the Tohoku and Tokaido keys, so the network total
   is unaffected. */
console.log("formal lines:", Object.keys(lineTotals).length);
console.log("network total km:", networkTotal);
const masterKeys = new Set<string>();
for (const entry of SERVICE_MASTER) {
  for (const segment of entry.segments) masterKeys.add(segment.formalLineKey);
}
for (const key of [...masterKeys].sort()) {
  console.log(`  ${key}: ${lineTotals[key]} km`);
}
console.log("operators:", Object.keys(operatorTotals).length);
for (const [operator, total] of Object.entries(operatorTotals).sort(
  (a, b) => b[1] - a[1],
)) {
  console.log(`  ${operator}: ${total} km`);
}

const generated = `/**
 * Generated by scripts/compute-line-totals.ts — do not edit by hand.
 *
 * Every length is the sum, over the line's connected
 * components, of each component's total (graph diameter, except
 * pure loops, whose total is the edge sum). Lengths are
 * approximate: they come from the map shape, not from timetable
 * kilometres. Regenerate after the N02 asset changes.
 *
 * Generated: ${new Date().toISOString().slice(0, 10)}
 * Formal lines: ${Object.keys(lineTotals).length}
 */

/** Total paintable length of every formal line, in km. */
export const LINE_TOTAL_KM: Readonly<Record<string, number>> = ${JSON.stringify(lineTotals, null, 2)};

/** Total paintable length per operator, in km. */
export const OPERATOR_TOTAL_KM: Readonly<Record<string, number>> = ${JSON.stringify(operatorTotals, null, 2)};

/** Total paintable length of all ${Object.keys(lineTotals).length} formal lines, in km. */
export const JAPAN_LINE_TOTAL_KM = ${networkTotal};
`;
writeFileSync("client/src/line-totals.ts", generated);
console.log("wrote client/src/line-totals.ts");
