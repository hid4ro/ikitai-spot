// Schema for 行きたいスポット通知.
//
// `spots` is the user's own registry of saved places (imported from a
// Google Takeout / Google Maps export, or added by hand). Coordinates are
// nullable: a spot without coordinates still appears in the list and the
// dashboard, it just cannot join proximity checks.
// `settings` is a single-row table (id = 1) holding the alert radius.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const spots = sqliteTable("spots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  note: text("note"),
  url: text("url"),
  address: text("address"),
  // The Google Maps list this spot belongs to (行ってみたい / お気に入り /
  // any custom name). Every spot belongs to exactly one list; empty values
  // are normalized to DEFAULT_LIST by the actions and backfilled by
  // migration 0003.
  category: text("category").notNull().default("行ってみたい"),
  // Free-form tags from the Takeout "Tags" column (or entered by hand),
  // stored as a JSON-encoded array of strings, e.g. '["🦝 ぽこピー"]'.
  // Existing rows are backfilled to '[]' by migration 0005; tags never
  // feed the proximity callout, which quotes the memo only.
  tags: text("tags").notNull().default("[]"),
  lat: real("lat"),
  lng: real("lng"),
  visited: integer("visited").notNull().default(0),
  visitedAt: integer("visited_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Municipalities (市区町村) the user has passed through and received a
// location-trivia delivery for — the ledger behind the 市区町村・路線.
// One row per municipality (unique on prefecture + name); visitedOn is the
// FIRST delivery date (YYYY-MM-DD), area is the neighborhood note from the
// delivery. lat/lng are the municipality's representative point (city
// office area, resolved via Nominatim), used only to place the map marker.
// geometry is the municipality's real boundary as a simplified GeoJSON
// geometry object (JSON text, Polygon / MultiPolygon), when the recording
// side supplied one; the map fills the actual shape from it and falls back
// to the bundled boundary asset / a circle at the representative point
// when it is absent.
// context is the trip context of that first visit — what the trip was
// for, what it was on the way back from (e.g. 「面接の行き」「実習の帰り」) —
// free text recorded by the chat-side job or by hand; null when the
// recording side did not say (rows recorded before the field existed
// stay null and are never backfilled with guesses).
export const visitedMunicipalities = sqliteTable("visited_municipalities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  prefecture: text("prefecture").notNull(),
  area: text("area"),
  context: text("context"),
  visitedOn: text("visited_on").notNull(),
  lat: real("lat"),
  lng: real("lng"),
  geometry: text("geometry"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Railway lines the user has ridden and received a line-trivia delivery
// for — the companion collection to the visited-municipality ledger,
// shown alongside the 市区町村・路線. One row per line (unique on name);
// firstRiddenOn is the FIRST delivery date (YYYY-MM-DD), note is the
// delivery note from the chat-side log (seen_lines.md). context is the
// trip context of that first ride (what the trip was for / on the way
// back from), same free-text field as the municipality ledger's.
// Stage 1 (subtask 1420) adds the service-master linkage: serviceId is
// the service-master entry (shared/service-master.ts), rideState is
// 'unknown' | 'partial' | 'full', and from/to are the ridden section
// as N02 station group codes (N02_005g) with names. unknown means the
// record pins down no section; partial means from/to are the section
// actually ridden; full means the whole service. masterVersion is the
// master version the ride was recorded at.
// Stage 2 (subtask 1421) adds pathSnapshot: the JSON of the
// FullPathSnapshot the full ride was cut at (path id + master version
// + the segment list as it stood then), so a past full ride keeps
// reproducing its range. Null for partial / unknown rides, and for
// full rides recorded before stage 2. Extra sections (block picks)
// live in riddenLineSections, not here: the primary section above
// stays the one the ride was first recorded with.
export const riddenLines = sqliteTable("ridden_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  firstRiddenOn: text("first_ridden_on").notNull(),
  note: text("note"),
  context: text("context"),
  serviceId: text("service_id"),
  rideState: text("ride_state").notNull().default("unknown"),
  fromStationId: text("from_station_id"),
  fromStationName: text("from_station_name"),
  toStationId: text("to_station_id"),
  toStationName: text("to_station_name"),
  masterVersion: text("master_version"),
  pathSnapshot: text("path_snapshot"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Added sections of a ridden line (stage 2, subtask 1421): one row
// per extra section a block pick (or a hand-entered section between
// two boundary stations) adds to the ledger row. The station pair is
// the saved record; the geometry and the distance are derived at
// draw time. direction is 'inner' | 'outer' on a loop service, null
// elsewhere. blockId names the master block the section covers, when
// the section is exactly one block — the client uses it to mark the
// block covered. Rows are deleted with their ledger row (the delete
// action removes them explicitly).
export const riddenLineSections = sqliteTable("ridden_line_sections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  riddenLineId: integer("ridden_line_id").notNull(),
  fromStationId: text("from_station_id").notNull(),
  fromStationName: text("from_station_name"),
  toStationId: text("to_station_id").notNull(),
  toStationName: text("to_station_name"),
  direction: text("direction"),
  blockId: text("block_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  radiusM: integer("radius_m").notNull().default(500),
  // Proximity callout in the main chat: when a nearby spot has a memo, the
  // chat quotes the memo back with this teasing template. {メモ} and
  // {スポット名} are replaced at callout time. Enabled by default.
  memoTeaseEnabled: integer("memo_tease_enabled").notNull().default(1),
  memoTeaseTemplate: text("memo_tease_template")
    .notNull()
    .default("「{メモ}」って書いてあったけど、こんなの気になっちゃってるの〜？ざぁこ♡"),
  // The Pixel's latest known position, written by the external
  // location-check job (updateDeviceLocation) roughly once a minute.
  // The in-app browser cannot geolocate, so the spot list's distance
  // sort and the maps' current-location marker can fall back to this
  // stored position while it is fresh (30 minutes). All three stay
  // null until the job's first write.
  deviceLat: real("device_lat"),
  deviceLng: real("device_lng"),
  deviceLocAt: integer("device_loc_at", { mode: "timestamp_ms" }),
});
