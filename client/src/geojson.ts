// Minimal GeoJSON geometry types shared by the client (bundled boundary
// asset + map overlay construction). Coordinates are [lng, lat] pairs,
// GeoJSON order — the map runtime takes overlay data in GeoJSON form.
export type GeoJsonGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

/* Railway line geometry from the bundled lines asset (visited-lines.ts):
   every line is a MultiLineString in [lng, lat] coordinate order. */
export type GeoJsonLineGeometry = {
  type: "MultiLineString";
  coordinates: number[][][];
};
