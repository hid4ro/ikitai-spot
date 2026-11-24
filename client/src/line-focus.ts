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
import { resolveRiddenLineKey } from "./line-resolution";
import {
  serviceById,
  serviceByLedgerName,
} from "../../shared/service-master";

type LineGeometryMap = Readonly<
  Record<string, { operator: string; geometry: GeoJsonLineGeometry }>
>;

/* The operator a ledger line name belongs to, via the service
   master (multi-line services included) or, for names the master
   does not know, via its resolved asset line; null when the name
   resolves to nothing. The row's saved service_id answers first
   when given (review finding 5) — a recorded alias must not
   re-resolve to a different service than the row was saved with. */
export function operatorOfLine(
  ledgerName: string,
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
  serviceId?: string | null,
): string | null {
  const key = resolveRiddenLineKey(ledgerName, geometries, keyByName, serviceId);
  if (!key) {
    // No single asset line: a multi-line service still has an
    // operator in the master (JR埼京線 → 東日本旅客鉄道).
    const service = serviceId
      ? serviceById(serviceId) ?? serviceByLedgerName(ledgerName)
      : serviceByLedgerName(ledgerName);
    return service?.operator ?? null;
  }
  return geometries[key]?.operator ?? null;
}

/* The FIRST ledger row of each operator, in ledger order — the
   row a 事業者別 bar tap scrolls to. Rows that resolve to no
   operator (unknown names) are skipped, exactly as
   countRiddenByOperator skips them. Several rows can share one
   asset line (JR総武快速線 and JR総武本線 are both 「総武線」);
   the earlier row in the ledger wins, later ones never replace it. */
export function firstLineByOperator<
  Row extends { id: number; name: string; serviceId?: string | null },
>(
  rows: readonly Row[],
  geometries: LineGeometryMap,
  keyByName: ReadonlyMap<string, string>,
): ReadonlyMap<string, Row> {
  const first = new Map<string, Row>();
  for (const row of rows) {
    const operator = operatorOfLine(row.name, geometries, keyByName, row.serviceId ?? null);
    if (!operator) continue;
    if (!first.has(operator)) first.set(operator, row);
  }
  return first;
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
