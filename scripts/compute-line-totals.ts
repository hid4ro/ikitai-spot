/**
 * Offline script: compute the total length of every N02 formal line
 * and write the results to client/src/line-totals.ts.
 *
 * A formal line's total is the graph diameter (the longest
 * end-to-end ride along its shape) of its largest connected
 * component, after the same <=500 m bridging the section code
 * uses. That matches the line's published length — a plain edge
 * sum overcounts by 50–70 km on trunk lines (sidings, yard
 * tracks and parallel strands the N02 shape draws), while the
 * diameter lands within a few kilometres of the timetable length
 * (Tohoku 539 vs 535, Tokaido JR-East 108 vs 105, Kagoshima 231
 * vs 232, Sanyo 526 vs 528). A pure loop has no ends, so its
 * diameter would halve it: for a component with no dead ends
 * (Osaka Loop Line, Disney Resort Line) the total is the edge
 * sum instead. Stray fragments (e.g. the Tohoku Line has a
 * component 315 km away) are excluded by taking only the
 * largest component. The diameter is the longer of the bridged
 * and the raw (unbridged) graphs: bridges join pieces the source
 * left apart, but can also shortcut across parallel strands
 * (the Chikuhi Line collapses from 42.4 to 25.7 km that way).
 *
 * Run: bun scripts/compute-line-totals.ts
 * Output: client/src/line-totals.ts (generated — do not edit by hand)
 */
import { writeFileSync } from "node:fs";
import { RIDDEN_LINE_GEOMETRIES } from "../client/src/assets/visited-lines";
import { buildLineGraph } from "../client/src/line-geometry";
import { SERVICE_MASTER } from "../shared/service-master";

/* Diameter (the longest end-to-end ride) of the largest
   connected component of `edges`, in km — the line total the
   header describes. The largest component is picked by total
   edge length, so stray fragments (a piece of the Tohoku Line
   315 km from the rest) never count. A component with no dead
   ends is a pure loop (Osaka Loop Line, Disney Resort Line):
   its diameter would halve it, so the total is the edge sum
   instead. Otherwise the diameter is the longest shortest path
   between any two of the component's nodes (Dijkstra from every
   node — a few hundred nodes at most per line, and this script
   runs offline). */
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
  /* Largest component by total edge length. */
  const byRoot = new Map<number, { lengthKm: number; nodes: Set<number> }>();
  for (const edge of edges) {
    const root = find(edge.a);
    let group = byRoot.get(root);
    if (!group) {
      group = { lengthKm: 0, nodes: new Set<number>() };
      byRoot.set(root, group);
    }
    group.lengthKm += edge.lengthKm;
    group.nodes.add(edge.a);
    group.nodes.add(edge.b);
  }
  let largest: { lengthKm: number; nodes: Set<number> } | null = null;
  for (const group of byRoot.values()) {
    if (!largest || group.lengthKm > largest.lengthKm) largest = group;
  }
  if (!largest) return 0;
  const nodes = [...largest.nodes];
  const nodeSet = new Set(nodes);
  /* Adjacency within the largest component, and each node's
     degree there. */
  const adj = new Map<number, { to: number; wKm: number }[]>();
  const degree = new Map<number, number>();
  for (const edge of edges) {
    if (!nodeSet.has(edge.a) || !nodeSet.has(edge.b)) continue;
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
  if (!hasDeadEnd) return largest.lengthKm;
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

const geometries = RIDDEN_LINE_GEOMETRIES as never;

/** Total length of one formal line, in km (see the header). */
function lineTotalKm(key: string): number {
  const entry = (RIDDEN_LINE_GEOMETRIES as Record<string, { geometry: never }>)[key];
  if (!entry) return 0;
  const graph = buildLineGraph(key, entry.geometry as never);
  /* The bridged graph joins pieces the source left apart, but its
     bridges can also shortcut across parallel strands (the
     Chikuhi Line's diameter collapses from 42.4 to 25.7 that
     way), so take the longer of the bridged and the raw
     diameters. */
  const bridged = componentTotal(graph.edges, graph.nodes.length);
  const raw = componentTotal(
    graph.edges.filter((e) => !e.bridge),
    graph.nodes.length,
  );
  return Math.max(bridged, raw);
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
 * Every length is the graph diameter (longest end-to-end ride) of
 * that formal line's N02 shape, except pure loops, whose total is
 * the edge sum. Lengths are approximate: they come from the map
 * shape, not from timetable kilometres. Regenerate after the N02
 * asset changes.
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
