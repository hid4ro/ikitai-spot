/* Operator ↔ ridden-line linkage for the 路線 side of the
   市区町村・路線 tab: the 事業者別（路線） bars jump to the ridden-
   lines ledger, and a ledger row tap flies the map to its line.
   The pure decisions behind that linkage live here (dependency-
   light, the asset maps are passed in) so they can be regression-
   tested directly against the real asset — see line-focus.test.ts.

   Resolution goes through line-resolution.ts's resolveRiddenLineKey
   (the master-backed rules): a ledger name that resolves to no asset
   line belongs to no operator, so it is never a bar-jump target.
   Multi-line services (JR埼京線) belong to their service's operator
   via the master, so they ARE jump targets — but a row tap on one
   can only highlight the row until stage 2 paints the ridden
   section, since no single track stands for the whole service. */

import type { GeoJsonLineGeometry } from "./geojson";
import { distanceToLineGeometryM } from "./line-geometry";
import { resolveRiddenLineKey } from "./line-resolution";
import {
  assetKeysForService,
  resolveRiddenService,
  type RiddenServiceLink,
} from "../../shared/service-master";

type LineGeometryMap = Readonly<
  Record<string, { operator: string; geometry: GeoJsonLineGeometry }>
>;

/* The operator of the row's resolved asset line or service. A
   multi-line service still has an operator in the master. Rows
   with disputed links are held for review and have no jump target. */
export function operatorOfLine(
  line: string | RiddenServiceLink,
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
  serviceId?: string | null,
): string | null {
  const row = typeof line === "string" ? { name: line, serviceId } : line;
  const { service, needsReview } = resolveRiddenService(row);
  if (needsReview) return null;
  const key = resolveRiddenLineKey(row, geometries, keyByName);
  return key ? (geometries[key]?.operator ?? null) : (service?.operator ?? null);
}

/* The FIRST ledger row of each operator, in ledger order — the
   row a 事業者別 bar tap scrolls to. Rows that resolve to no
   operator (unknown names) are skipped, exactly as
   countRiddenByOperator skips them. Several rows can share one
   asset line (JR総武快速線 and JR総武本線 are both 「総武線」);
   the earlier row in the ledger wins, later ones never replace it. */
export function firstLineByOperator<
  Row extends RiddenServiceLink & { id: number },
>(
  rows: readonly Row[],
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
): ReadonlyMap<string, Row> {
  const first = new Map<string, Row>();
  for (const row of rows) {
    const operator = operatorOfLine(row, geometries, keyByName);
    if (!operator) continue;
    if (!first.has(operator)) first.set(operator, row);
  }
  return first;
}

/* The group label for rows that resolve to no operator (unknown
   names, and rows whose service link is held for review): the
   路線 list groups by operator like the municipality ledger
   groups by prefecture, and these rows still need a group to
   live in — they are never dropped from the list. */
export const UNKNOWN_OPERATOR_GROUP = "事業者不明";

/* Ledger rows grouped by operator, in the order each operator
   first appears in the ledger (the municipality ledger's groups
   follow the server-ordered prefecture list; the lines ledger
   has no such list, so first appearance is the stable order).
   Rows keep ledger order inside their group. Every row lands in
   exactly one group — a row with no operator goes to
   UNKNOWN_OPERATOR_GROUP instead of vanishing. */
export function groupLinesByOperator<
  Row extends RiddenServiceLink & { id: number },
>(
  rows: readonly Row[],
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
): { operator: string; rows: Row[] }[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const operator = operatorOfLine(row, geometries, keyByName) ?? UNKNOWN_OPERATOR_GROUP;
    const group = groups.get(operator);
    if (group) {
      group.push(row);
    } else {
      groups.set(operator, [row]);
    }
  }
  return [...groups.entries()].map(([operator, groupRows]) => ({
    operator,
    rows: groupRows,
  }));
}

/* The recorded line nearest a location (subtask 1483): the
   路線 tab's default framing fits this line's whole extent.
   A row counts when it resolves to a geometry — a service row
   through its asset keys (a multi-line service's whole extent
   is the union of the formal lines it runs on), a plain row
   through its resolved formal-line key. Rows held for review,
   and rows with no geometry at all, never count. The distance
   is to the line's FULL geometry, so a line counts as near
   wherever its track runs, not only where it was ridden. Ties
   keep the earlier ledger row. Null when no row can be
   placed. */
export type NearestRiddenLine<Row> = {
  row: Row;
  /* The line's whole extent — the bounds the default framing
     fits, so the full line is in view. */
  bounds: [[number, number], [number, number]];
  distanceM: number;
};
export function nearestRiddenLine<
  Row extends RiddenServiceLink & { id: number },
>(
  location: { lat: number; lng: number },
  rows: readonly Row[],
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
): NearestRiddenLine<Row> | null {
  const point: [number, number] = [location.lng, location.lat];
  let best: NearestRiddenLine<Row> | null = null;
  for (const row of rows) {
    const { service, needsReview } = resolveRiddenService(row);
    if (needsReview) continue;
    const keys = service
      ? assetKeysForService(service.id)
      : [resolveRiddenLineKey(row, geometries, keyByName)];
    let distanceM: number | null = null;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const key of keys) {
      if (!key) continue;
      const geometry = geometries[key]?.geometry;
      if (!geometry) continue;
      const d = distanceToLineGeometryM(point, geometry);
      if (d !== null && (distanceM === null || d < distanceM)) {
        distanceM = d;
      }
      const b = lineGeometryBounds(geometry);
      if (!b) continue;
      if (b[0][0] < minLng) minLng = b[0][0];
      if (b[0][1] < minLat) minLat = b[0][1];
      if (b[1][0] > maxLng) maxLng = b[1][0];
      if (b[1][1] > maxLat) maxLat = b[1][1];
    }
    if (distanceM === null || !Number.isFinite(minLng)) continue;
    if (!best || distanceM < best.distanceM) {
      best = {
        row,
        bounds: [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        distanceM,
      };
    }
  }
  return best;
}

/* Bounding box of a line geometry as [[minLng, minLat],
   [maxLng, maxLat]] — the shape MapLibre's fitBounds takes, the
   same contract as App.tsx's geometryBounds for municipality
   polygons. A line geometry is a MultiLineString: a list of
   segments, each a list of [lng, lat] points. Null when the
   geometry carries no points at all. */
export function lineGeometryBounds(
  geometry: GeoJsonLineGeometry,
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const segment of geometry.coordinates) {
    for (const point of segment) {
      const [lng, lat] = point as [number, number];
      if (typeof lng !== "number" || typeof lat !== "number") continue;
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
