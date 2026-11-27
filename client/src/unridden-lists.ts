/* The temporary-display lists (subtask 1623): the formal lines
   not ridden yet and the municipalities not visited yet, shown
   in their own sections apart from the ledgers — the ledgers
   stay the record of what was ridden / visited, and these
   sections are the way in to previewing the rest. Both are
   pure derivations from data the component already holds, so
   the lists and the map can never disagree about what counts
   as unridden / unvisited:

   - a formal line is unridden when NO ledger row paints any
     of its track (perServiceLegs): an unknown ride paints its
     whole path, so it counts as ridden even though its
     distance is unknown, and a partial ride's key stays out
     even though most of the line is still unridden — its
     remainder already shows at midway strength from its own
     ledger row, so it needs no second entry here;
   - a municipality is unvisited when its 「都道府県|市区町村」
     key is in the boundary data loaded so far and NOT in the
     ledger — the same rule the map's unvisited-areas layer
     uses (buildUnvisitedAreaFeatures in App.tsx), including
     its defensive skip of a non-Tokyo 区 name.

   The lists only ever show what is loaded: the line section
   waits for the ridden-lines ledger (an empty coverage would
   list all 597 lines), and the municipality section grows as
   prefecture files land. Neither list records anything — a
   tap only previews, temporarily. */

import type { GeoJsonGeometry } from "./geojson";
import type { LineCoverage, LineGeometryMap } from "./line-geometry";
import { LINE_TOTAL_KM } from "./line-totals";

/* ---------------- unridden formal lines ---------------- */

export type UnriddenFormalLine = {
  /* The formal-line key: "路線名|運営会社". */
  key: string;
  name: string;
  operator: string;
  color: string;
  /* The line's whole paintable length (line-totals.ts); null
     when the totals table has no entry for the key. */
  totalKm: number | null;
};

/* Every formal line in the asset with no painted leg in the
   coverage — the whole unridden network, not just the master
   services (the master holds only the lines around the
   reader's rides; the ghost behind the 路線 tab covers all
   597 formal lines, and this section is its list). A key with
   no graph still lists: every asset key yields ghost legs
   (verified 2026-11-28: 597/597 keys have legs, totals and
   colors), so a listed line can always be painted. */
export function unriddenFormalLines(
  coverage: LineCoverage,
  geometries: LineGeometryMap,
): UnriddenFormalLine[] {
  const paintedKeys = new Set<string>();
  for (const painted of coverage.perServiceLegs.values()) {
    for (const leg of painted.legs) paintedKeys.add(leg.key);
  }
  const out: UnriddenFormalLine[] = [];
  for (const key of Object.keys(geometries)) {
    if (paintedKeys.has(key)) continue;
    const entry = geometries[key]!;
    out.push({
      key,
      name: entry.name,
      operator: entry.operator,
      color: entry.color,
      totalKm: LINE_TOTAL_KM[key] ?? null,
    });
  }
  return out;
}

export type UnriddenLineGroup = {
  operator: string;
  lines: UnriddenFormalLine[];
};

/* Grouped by operator, the same shape as the ridden list's
   operator groups: bigger operators first (count desc, then
   operator name), rows by line name (numeric collation, so
   1号線 sorts before 10号線). */
export function groupUnriddenLinesByOperator(
  lines: readonly UnriddenFormalLine[],
): UnriddenLineGroup[] {
  const byOperator = new Map<string, UnriddenFormalLine[]>();
  for (const line of lines) {
    const list = byOperator.get(line.operator) ?? [];
    list.push(line);
    byOperator.set(line.operator, list);
  }
  const groups = [...byOperator.entries()].map(([operator, rows]) => ({
    operator,
    lines: [...rows].sort((a, b) =>
      a.name.localeCompare(b.name, "ja", { numeric: true }),
    ),
  }));
  groups.sort(
    (a, b) =>
      b.lines.length - a.lines.length ||
      a.operator.localeCompare(b.operator, "ja"),
  );
  return groups;
}

/* ---------------- unvisited municipalities ---------------- */

export type UnvisitedMunicipality = {
  prefecture: string;
  name: string;
  geometry: GeoJsonGeometry;
};

/* Every municipality in the boundary data loaded so far whose
   key is not in the visited ledger. `geometryByKey` is the
   boundary store's live map (getBoundaryGeometryByKey) — the
   caller re-derives when its version bumps, so prefectures
   that land in the background join the list. */
export function unvisitedMunicipalities(
  visitedKeys: ReadonlySet<string>,
  geometryByKey: ReadonlyMap<string, GeoJsonGeometry>,
): UnvisitedMunicipality[] {
  const out: UnvisitedMunicipality[] = [];
  for (const [key, geometry] of geometryByKey) {
    if (!geometry || visitedKeys.has(key)) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const prefecture = key.slice(0, sep);
    const name = key.slice(sep + 1);
    /* Same defensive skip as the map's unvisited-areas layer:
       a 区 name counts only as a Tokyo special ward. The
       asset's only 区 entries are the 23 wards, so this
       normally skips nothing. */
    if (name.endsWith("区") && prefecture !== "東京都") continue;
    out.push({ prefecture, name, geometry });
  }
  return out;
}

export type UnvisitedPrefectureGroup = {
  prefecture: string;
  /* The prefecture's whole municipality count from the
     boundary manifest (null until the manifest lands). */
  total: number | null;
  rows: UnvisitedMunicipality[];
};

/* Grouped by prefecture, the same shape as the visited
   ledger's prefecture groups: prefectures in manifest order
   (north to south), any prefecture missing from that order
   appended in first-appearance order, rows by municipality
   name. */
export function groupUnvisitedByPrefecture(
  rows: readonly UnvisitedMunicipality[],
  prefectureOrder: readonly string[],
  totals?: ReadonlyMap<string, number>,
): UnvisitedPrefectureGroup[] {
  const byPrefecture = new Map<string, UnvisitedMunicipality[]>();
  for (const row of rows) {
    const list = byPrefecture.get(row.prefecture) ?? [];
    list.push(row);
    byPrefecture.set(row.prefecture, list);
  }
  const order = new Map<string, number>();
  prefectureOrder.forEach((name, i) => {
    if (!order.has(name)) order.set(name, i);
  });
  let next = order.size;
  for (const prefecture of byPrefecture.keys()) {
    if (!order.has(prefecture)) order.set(prefecture, next++);
  }
  const groups = [...byPrefecture.entries()].map(([prefecture, list]) => ({
    prefecture,
    total: totals?.get(prefecture) ?? null,
    rows: [...list].sort((a, b) => a.name.localeCompare(b.name, "ja")),
  }));
  groups.sort(
    (a, b) => (order.get(a.prefecture) ?? 0) - (order.get(b.prefecture) ?? 0),
  );
  return groups;
}
