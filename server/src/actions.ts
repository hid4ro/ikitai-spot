// Actions for 行きたいスポット通知.
//
// The spot registry is user-owned data: rows arrive from a Google Takeout /
// Google Maps export the user picks on their device (parsed client-side,
// stored here verbatim), or from manual entry. Nothing is seeded.

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  blockById,
  isExplicitlyUnlinked,
  isKnownMasterVersion,
  isN02StationId,
  isRiddenServiceLinkReviewable,
  recordedSectionFitsService,
  resolveRiddenService,
  serviceById,
  serviceFullPathSnapshot,
  sectionEndpointsKnownToService,
  SERVICE_MASTER_VERSION,
  SERVICE_MATCH_VERSION,
  stationRefById,
  usableRiddenService,
  validateSectionEndpoints,
  type RideState,
  type ServiceLinkSource,
} from "../../shared/service-master";
import * as schema from "./schema";

const rideStateSchema = z.enum(["unknown", "partial", "full"]);

/* One added section of a ridden line (stage 2, subtask 1421):
   a block pick, or a hand-entered section between two stations
   the service is known to serve (stage 3: a boundary station,
   or a station listed on one of its blocks). direction is
   'inner' | 'outer' on a loop service, null elsewhere; blockId
   names the master block the section covers, when it is exactly
   one block. */
const riddenSectionSchema = z.object({
  id: z.number(),
  fromStationId: z.string(),
  fromStationName: z.string().nullable(),
  toStationId: z.string(),
  toStationName: z.string().nullable(),
  direction: z.enum(["inner", "outer"]).nullable(),
  blockId: z.string().nullable(),
  recordedServiceId: z.string().nullable(),
});

/* The ridden-lines ride fields (stage 1, subtask 1420): which
   service the row belongs to, the ride state, and the ridden
   section as N02 station group codes with names. Callers may pass
   them explicitly; when they do not, the row links to its service
   and starts unknown (no section). The nine migrated rides are
   NOT consulted here: restoring a section belongs to the SQL
   migration (drizzle/0011), which identifies the legacy rows by
   name and first-ride date — a fresh registration of the same
   name must never inherit their section. */
const rideFieldsSchema = z.object({
  serviceId: z.string().max(100).nullable().optional(),
  rideState: rideStateSchema.nullable().optional(),
  fromStationId: z.string().max(20).nullable().optional(),
  fromStationName: z.string().max(100).nullable().optional(),
  toStationId: z.string().max(20).nullable().optional(),
  toStationName: z.string().max(100).nullable().optional(),
  masterVersion: z.string().max(50).nullable().optional(),
});

type RideFields = {
  serviceId: string | null;
  recordedServiceId: string | null;
  serviceLinkSource: ServiceLinkSource;
  serviceMatchVersion: string | null;
  rideState: RideState;
  fromStationId: string | null;
  fromStationName: string | null;
  toStationId: string | null;
  toStationName: string | null;
  masterVersion: string | null;
  /* Stage 2: the full ride's versioned path, as JSON — the
     snapshot the client paints from, so a later master change
     never rewrites a past full ride's range. Only full rides
     carry one; partial / unknown rides store null. */
  pathSnapshot: string | null;
};

/* Resolves the ride fields for a registration. State rules
   (Codex review 1, findings 1–2; review 2, high):
   - unknown: no section. Any supplied endpoints are dropped, never
     stored — an unrecorded section must stay unrecorded.
   - partial: both endpoint station IDs plus a known service (the
     route) are required; a partial with an empty endpoint is
     rejected, not stored. The endpoints must be N02 station group
     codes (six digits) and two different stations — "bad" is not a
     station, and a section from a station to itself is no section.
   - full: the service and a master version that reproduces its
     range are required — and the version must be one the master
     actually knows (the current version or the frozen migration
     version); a blank or made-up version ("bogus") is rejected,
     not stored. The supplied version is trimmed before both the
     check and the save, so a padded version (" 2026-11-24 ") is
     stored as the version it validated as, never with its spaces
     (review round 3, low) — and a whitespace-only version still
     rejects, because trimming it leaves an empty string.
   The current name match supplies the serviceId when omitted and
   validates an explicit ID. Automatic matches store their rule
   version separately from the ride's master version. When the
   caller passes no ride state, both endpoints present means
   partial, otherwise unknown.
   Exported for the regression tests (server/src/actions.test.ts):
   the save-time validation is exercised directly, without a DB. */
export function resolveRideFields(
  name: string,
  supplied: z.infer<typeof rideFieldsSchema>,
): RideFields {
  const { service } = resolveRiddenService({
    name,
    serviceId: supplied.serviceId,
  });
  if (supplied.serviceId != null && !service) {
    if (!serviceById(supplied.serviceId)) {
      throw new Error(
        `resolveRideFields: unknown serviceId "${supplied.serviceId}" for "${name}"`,
      );
    }
    throw new Error(
      `resolveRideFields: serviceId "${supplied.serviceId}" does not match "${name}"`,
    );
  }
  const link = {
    serviceId: service?.id ?? null,
    serviceLinkSource: supplied.serviceId != null ? "explicit" : "auto",
    serviceMatchVersion: supplied.serviceId != null ? null : SERVICE_MATCH_VERSION,
  } as const;
  const rideState =
    supplied.rideState ??
    (supplied.fromStationId?.trim() && supplied.toStationId?.trim()
      ? "partial"
      : "unknown");
  const masterVersion =
    supplied.masterVersion != null
      ? supplied.masterVersion.trim()
      : service
        ? SERVICE_MASTER_VERSION
        : null;
  if (rideState === "unknown") {
    return {
      ...link,
      recordedServiceId: null,
      rideState: "unknown",
      fromStationId: null,
      fromStationName: null,
      toStationId: null,
      toStationName: null,
      masterVersion,
      pathSnapshot: null,
    };
  }
  if (rideState === "partial") {
    if (!service) {
      throw new Error(
        `resolveRideFields: partial ride for "${name}" needs a known service`,
      );
    }
    if (!supplied.fromStationId?.trim() || !supplied.toStationId?.trim()) {
      throw new Error(
        `resolveRideFields: partial ride for "${name}" needs both endpoint station IDs`,
      );
    }
    const fromStationId = supplied.fromStationId.trim();
    const toStationId = supplied.toStationId.trim();
    if (!isN02StationId(fromStationId) || !isN02StationId(toStationId)) {
      throw new Error(
        `resolveRideFields: partial ride for "${name}" needs N02 station IDs (six-digit group codes)`,
      );
    }
    if (fromStationId === toStationId) {
      throw new Error(
        `resolveRideFields: partial ride for "${name}" needs two different stations`,
      );
    }
    return {
      ...link,
      recordedServiceId: service.id,
      rideState: "partial",
      fromStationId,
      fromStationName: supplied.fromStationName?.trim() || null,
      toStationId,
      toStationName: supplied.toStationName?.trim() || null,
      masterVersion,
      pathSnapshot: null,
    };
  }
  // full: the whole service, at a version that reproduces its range.
  if (!service) {
    throw new Error(
      `resolveRideFields: full ride for "${name}" needs a known service`,
    );
  }
  if (!masterVersion || !isKnownMasterVersion(masterVersion)) {
    throw new Error(
      `resolveRideFields: full ride for "${name}" needs a known master version (got ${JSON.stringify(masterVersion)})`,
    );
  }
  /* The snapshot is cut from the current master, so it is stored
     only when the ride was recorded at the current version. A
     full ride recorded at the frozen migration version keeps
     null: its range is the current master's range for that
     service in practice, and the client falls back to the
     current master when no snapshot is stored — a snapshot cut
     from the wrong version would be worse than none. */
  const snapshot =
    masterVersion === SERVICE_MASTER_VERSION
      ? serviceFullPathSnapshot(service.id)
      : null;
  return {
    ...link,
    recordedServiceId: service.id,
    rideState: "full",
    fromStationId: null,
    fromStationName: null,
    toStationId: null,
    toStationName: null,
    masterVersion,
    pathSnapshot: snapshot ? JSON.stringify(snapshot) : null,
  };
}

function riddenServiceBackfill(name: string) {
  const link = resolveRideFields(name, {});
  if (!link.serviceId) return undefined;
  return {
    serviceId: link.serviceId,
    serviceLinkSource: link.serviceLinkSource,
    serviceMatchVersion: link.serviceMatchVersion,
    masterVersion: sql`coalesce(${schema.riddenLines.masterVersion}, ${link.masterVersion})`,
  };
}

/* Whether an insert failed on a UNIQUE constraint, looking down
   the whole error chain: Drizzle wraps the driver's error, and
   the SQLite message ("UNIQUE constraint failed: …") sits on
   error.cause, not on the outer error's message — checking only
   the outer message let a racing duplicate add escape as an
   error instead of returning the winner's row (integrated
   review round 1, H-3 remainder). Exported for the regression
   tests. */
export function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (
      current instanceof Error &&
      current.message.includes("UNIQUE constraint failed")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* Check every recorded section before changing the link. A full ride uses
   its recorded path or service, while a partial ride uses the same section
   attribution as coverage. */
export function riddenLinkFitProblem(
  line: {
    serviceId: string | null;
    recordedServiceId: string | null;
    rideState: string | null;
    fromStationId: string | null;
    toStationId: string | null;
    pathSnapshot: string | null;
  },
  sections: readonly {
    fromStationId: string;
    toStationId: string;
    direction: string | null;
    blockId: string | null;
    recordedServiceId: string | null;
  }[],
  targetServiceId: string | null,
): string | null {
  if (targetServiceId == null) return null;
  const target = serviceById(targetServiceId);
  if (!target) return null;
  const state = normalizeRideState(line.rideState);
  if (state === "full") {
    let snapshotPathId: string | null = null;
    if (line.pathSnapshot) {
      try {
        const parsed = JSON.parse(line.pathSnapshot) as { pathId?: unknown } | null;
        if (typeof parsed?.pathId === "string") snapshotPathId = parsed.pathId;
      } catch {
        // Fall back to the recorded service when the snapshot cannot be read.
      }
    }
    const fits = snapshotPathId
      ? snapshotPathId === target.pathId
      : (line.recordedServiceId ?? line.serviceId) === target.id;
    return fits ? null : `the recorded full ride's path cannot be attributed to ${target.displayName}`;
  }
  const pairs = sections.map((section) => ({
    ...section,
    direction: normalizeSectionDirection(section.direction),
  }));
  if (state === "partial" && line.fromStationId && line.toStationId) {
    pairs.unshift({
      fromStationId: line.fromStationId,
      toStationId: line.toStationId,
      direction: null,
      blockId: null,
      recordedServiceId: line.recordedServiceId,
    });
  }
  for (const section of pairs) {
    if (recordedSectionFitsService(target.id, section)) continue;
    if (!sectionEndpointsKnownToService(target.id, section.fromStationId, section.toStationId)) {
      return `the recorded section's endpoints are not known stations of ${target.displayName}`;
    }
    if (section.blockId != null) {
      return `the recorded section's block ${section.blockId} does not fit ${target.displayName}`;
    }
    return `the recorded section's route cannot be determined for ${target.displayName} from its endpoints and direction`;
  }
  return null;
}

/* Defensive read-back: the column is NOT NULL DEFAULT 'unknown', but
   a stray value must never reach the client as a state it cannot show. */
function normalizeRideState(raw: string | null): RideState {
  if (raw === "partial" || raw === "full") return raw;
  return "unknown";
}

/* Defensive read-back for an added section's direction: the column
   is free text, but only 'inner' | 'outer' mean anything — a stray
   value reads as no direction, never as a state the client cannot
   show. */
function normalizeSectionDirection(
  raw: string | null,
): "inner" | "outer" | null {
  return raw === "inner" || raw === "outer" ? raw : null;
}

const spotSchema = z.object({
  id: z.number(),
  name: z.string(),
  note: z.string().nullable(),
  url: z.string().nullable(),
  address: z.string().nullable(),
  category: z.string(),
  tags: z.array(z.string()),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  visited: z.boolean(),
  visited_at: z.string().nullable(),
  created_at: z.string(),
});

type SpotRow = typeof schema.spots.$inferSelect;

// Tags are stored as a JSON-encoded array of strings. Parsing is defensive:
// anything that is not a JSON array of strings reads back as no tags.
function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.trim() !== "");
  } catch {
    return [];
  }
}

// Trims, drops empties, and dedupes an incoming tag list, keeping order.
function normalizeTags(tags: readonly string[] | null | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function encodeTags(tags: readonly string[] | null | undefined): string {
  return JSON.stringify(normalizeTags(tags));
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

const tagsInput = z.array(z.string().min(1).max(100)).max(50);

// Simplified GeoJSON geometry (Polygon / MultiPolygon) for a municipality's
// real boundary. Positions are [lng, lat]; caps keep a single geometry
// small enough to store as one text column (the ones in use are a few
// thousand points at most after simplification).
const geoPosition = z.array(z.number().min(-180).max(180)).min(2).max(2);
const geoRing = z.array(geoPosition).min(4).max(20000);
const geoPolygon = z.array(geoRing).min(1).max(100);
const geoJsonGeometrySchema = z.union([
  z.object({ type: z.literal("Polygon"), coordinates: geoPolygon }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(geoPolygon).min(1).max(500) }),
]);
type GeoJsonGeometry = z.infer<typeof geoJsonGeometrySchema>;

// Stored geometry is JSON text; anything unparsable or off-shape reads
// back as no geometry (the map then falls back to the bundled boundary
// asset or a circle at the representative point).
function parseGeometry(raw: string | null | undefined): GeoJsonGeometry | null {
  if (!raw) return null;
  try {
    const parsed = geoJsonGeometrySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeGeometry(geometry: GeoJsonGeometry | null | undefined): string | null {
  return geometry ? JSON.stringify(geometry) : null;
}

// Best-effort representative point for a municipality via OpenStreetMap
// Nominatim (the same source the `geocode` action uses). Used when a
// visited-municipality recording arrives without coordinates — the
// chat-side trivia job records name / prefecture / date only, and rows
// stored without a point used to lose their ledger number and their
// place on the map. Any failure (network, no hit) returns null and the
// row is stored exactly as before.
async function resolveMunicipalityPoint(
  prefecture: string,
  name: string,
): Promise<{ lat: number; lng: number } | null> {
  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=ja&q=" +
      encodeURIComponent(`${prefecture} ${name}`);
    const res = await fetch(url, {
      headers: { "User-Agent": "muse-want-to-go-spots/1.0" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    const first: unknown = data[0];
    if (typeof first !== "object" || first === null) return null;
    const rec = first as Record<string, unknown>;
    const lat = Number(rec.lat);
    const lng = Number(rec.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

// listSpots rows carry one extra, optional field: distance_km, present
// only when the caller asked for the distance sort with a valid origin
// (null for a spot without coordinates, which sorts last). The default
// sort never sets it, so its response shape is unchanged.
const listSpotSchema = spotSchema.extend({
  distance_km: z.number().nullable().optional(),
});

// Great-circle distance in kilometres between two WGS-84 points. Used
// only inside a single listSpots request — the origin is never stored.
function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toSpot(row: SpotRow): z.infer<typeof spotSchema> {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    url: row.url,
    address: row.address,
    category: row.category,
    tags: parseTags(row.tags),
    lat: row.lat,
    lng: row.lng,
    visited: row.visited === 1,
    visited_at: row.visitedAt ? row.visitedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

const okResponse = z.object({ ok: z.literal(true) });

// Every spot belongs to exactly one list (its Google Maps list name).
// Anything empty lands in the default list.
const DEFAULT_LIST = "行ってみたい";
function normalizeList(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : DEFAULT_LIST;
}

export const Actions = {
  getStats: defineAction({
    description:
      "Returns spot totals: all spots, visited count, remaining count, and how many have coordinates for proximity checks.",
    request: z.object({}),
    response: z.object({
      total: z.number(),
      visited: z.number(),
      remaining: z.number(),
      withCoords: z.number(),
      withMemo: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const totalRows = await db.select({ n: count() }).from(schema.spots);
      const visitedRows = await db
        .select({ n: count() })
        .from(schema.spots)
        .where(eq(schema.spots.visited, 1));
      const coordRows = await db
        .select({ n: count() })
        .from(schema.spots)
        .where(
          and(isNotNull(schema.spots.lat), isNotNull(schema.spots.lng)),
        );
      const memoRows = await db
        .select({ n: count() })
        .from(schema.spots)
        .where(
          and(isNotNull(schema.spots.note), sql`${schema.spots.note} <> ''`),
        );
      const total = totalRows[0]?.n ?? 0;
      const visited = visitedRows[0]?.n ?? 0;
      return {
        total,
        visited,
        remaining: total - visited,
        withCoords: coordRows[0]?.n ?? 0,
        withMemo: memoRows[0]?.n ?? 0,
      };
    },
  }),

  listSpotPoints: defineAction({
    description:
      "Returns every spot that has coordinates for the spot list's pinned map, with the detail fields that identify each plotted spot (id, name, list name, memo truncated to 200 chars, url, address, tags, visited).",
    request: z.object({}),
    response: z.object({
      points: z.array(
        z.object({
          id: z.number(),
          lat: z.number(),
          lng: z.number(),
          name: z.string(),
          category: z.string(),
          note: z.string().nullable(),
          url: z.string().nullable(),
          address: z.string().nullable(),
          tags: z.array(z.string()),
          visited: z.boolean(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.spots)
        .where(
          and(isNotNull(schema.spots.lat), isNotNull(schema.spots.lng)),
        );
      return {
        points: rows
          .filter(
            (r): r is SpotRow & { lat: number; lng: number } =>
              r.lat !== null && r.lng !== null,
          )
          .map((r) => ({
            id: r.id,
            lat: r.lat,
            lng: r.lng,
            name: r.name,
            // The map payload covers ~2,300 spots; cap the memo so the
            // response stays lean. The full memo remains available in
            // the spot list's detail (listSpots).
            note: r.note ? r.note.slice(0, 200) : null,
            url: r.url,
            address: r.address,
            category: r.category,
            tags: parseTags(r.tags),
            visited: r.visited === 1,
          })),
      };
    },
  }),

  listLists: defineAction({
    description:
      "Lists every spot list (Google Maps list name) with its total and visited counts, biggest first.",
    request: z.object({}),
    response: z.object({
      lists: z.array(
        z.object({
          name: z.string(),
          total: z.number(),
          visited: z.number(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({
          name: schema.spots.category,
          total: count(),
          visited: sql<number>`coalesce(sum(case when ${schema.spots.visited} = 1 then 1 else 0 end), 0)`,
        })
        .from(schema.spots)
        .groupBy(schema.spots.category)
        .orderBy(desc(count()));
      return {
        lists: rows.map((r) => ({
          name: r.name,
          total: r.total,
          visited: Number(r.visited),
        })),
      };
    },
  }),

  listTags: defineAction({
    description:
      "Lists every tag in use across all spots with the number of spots carrying it, most-used first.",
    request: z.object({}),
    response: z.object({
      tags: z.array(
        z.object({
          name: z.string(),
          total: z.number(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ tags: schema.spots.tags })
        .from(schema.spots);
      const counts = new Map<string, number>();
      for (const row of rows) {
        for (const tag of parseTags(row.tags)) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      const tags = [...counts.entries()]
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ja"));
      return { tags };
    },
  }),

  listSpots: defineAction({
    description:
      "Lists spots with search (name, memo, address, list, and tags), visited filter, optional list filter, optional tag filter, and an optional memo-only filter. Default sort: unvisited spots first, then alphabetical by name. With sort='distance' and a valid originLat/originLng, the same filtered set is ordered by Haversine distance from the origin (spots without coordinates last, name order breaks ties), each row carrying distance_km; the origin is used only for that request and never stored. A distance sort without a valid origin falls back to the default order.",
    request: z.object({
      query: z.string().default(""),
      filter: z.enum(["all", "unvisited", "visited"]).default("unvisited"),
      list: z.string().nullable().default(null),
      tag: z.string().nullable().default(null),
      memoOnly: z.boolean().default(false),
      limit: z.number().int().positive().max(200).default(100),
      offset: z.number().int().min(0).default(0),
      sort: z.enum(["default", "distance"]).default("default"),
      originLat: z.number().nullable().default(null),
      originLng: z.number().nullable().default(null),
    }),
    response: z.object({
      spots: z.array(listSpotSchema),
      total: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const conditions = [];
      if (args.filter === "unvisited") {
        conditions.push(eq(schema.spots.visited, 0));
      } else if (args.filter === "visited") {
        conditions.push(eq(schema.spots.visited, 1));
      }
      if (args.list) {
        conditions.push(eq(schema.spots.category, args.list));
      }
      if (args.tag) {
        // Tags live in a JSON array column; match the exact JSON string
        // form of the tag so a partial tag name never matches.
        conditions.push(
          like(schema.spots.tags, `%${JSON.stringify(args.tag)}%`),
        );
      }
      if (args.memoOnly) {
        conditions.push(
          and(isNotNull(schema.spots.note), sql`${schema.spots.note} <> ''`),
        );
      }
      const q = args.query.trim();
      if (q) {
        const pattern = `%${q}%`;
        conditions.push(
          or(
            like(schema.spots.name, pattern),
            like(schema.spots.note, pattern),
            like(schema.spots.address, pattern),
            like(schema.spots.category, pattern),
            like(schema.spots.tags, pattern),
          ),
        );
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const totalRows = await db
        .select({ n: count() })
        .from(schema.spots)
        .where(where);
      const total = totalRows[0]?.n ?? 0;
      /* Distance sort needs a usable origin. A missing or out-of-range
         one is not an error — the caller gets the default order, so a
         broken geolocation hand-off can never break the list. */
      const origin =
        args.sort === "distance" &&
        args.originLat !== null &&
        args.originLng !== null &&
        Number.isFinite(args.originLat) &&
        Number.isFinite(args.originLng) &&
        Math.abs(args.originLat) <= 90 &&
        Math.abs(args.originLng) <= 180
          ? { lat: args.originLat, lng: args.originLng }
          : null;
      if (!origin) {
        const rows = await db
          .select()
          .from(schema.spots)
          .where(where)
          .orderBy(asc(schema.spots.visited), asc(schema.spots.name))
          .limit(args.limit)
          .offset(args.offset);
        return { spots: rows.map(toSpot), total };
      }
      /* Distance order is computed over the WHOLE filtered set before
         paging — sorting only the current page would scramble the
         order across pages. Spots without coordinates have no
         distance and go last; name order breaks every tie so the
         result is stable. */
      const allRows = await db.select().from(schema.spots).where(where);
      const byName = (a: SpotRow, b: SpotRow) =>
        a.name.localeCompare(b.name, "ja") || a.id - b.id;
      const decorated = allRows.map((row) => ({
        row,
        distanceKm:
          row.lat !== null && row.lng !== null
            ? haversineKm(origin.lat, origin.lng, row.lat, row.lng)
            : null,
      }));
      decorated.sort((a, b) => {
        if (a.distanceKm === null && b.distanceKm === null) {
          return byName(a.row, b.row);
        }
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
        return byName(a.row, b.row);
      });
      const pageRows = decorated.slice(args.offset, args.offset + args.limit);
      return {
        spots: pageRows.map(({ row, distanceKm }) => ({
          ...toSpot(row),
          distance_km: distanceKm,
        })),
        total,
      };
    },
  }),

  getSpot: defineAction({
    description:
      "Returns one spot by id (null when it does not exist). The spot list's pinned map plots only the lean point payload, so a tap on a plotted spot resolves its full row through here before the detail opens — the detail's edit form must never be seeded from the point payload, whose memo is truncated.",
    request: z.object({ id: z.number().int() }),
    response: z.object({ spot: spotSchema.nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.spots)
        .where(eq(schema.spots.id, args.id));
      const row = rows[0];
      return { spot: row ? toSpot(row) : null };
    },
  }),

  listWatchSpots: defineAction({
    description:
      "Returns every unvisited spot that has coordinates, for the client's live proximity watch.",
    request: z.object({}),
    response: z.object({ spots: z.array(spotSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.spots)
        .where(
          and(
            eq(schema.spots.visited, 0),
            isNotNull(schema.spots.lat),
            isNotNull(schema.spots.lng),
          ),
        )
        .orderBy(asc(schema.spots.name));
      return { spots: rows.map(toSpot) };
    },
  }),

  addSpot: defineAction({
    description: "Adds one spot by hand (with optional tags) and returns the created spot.",
    request: z.object({
      name: z.string().min(1).max(300),
      note: z.string().max(2000).nullable().optional(),
      url: z.string().max(2000).nullable().optional(),
      address: z.string().max(500).nullable().optional(),
      category: z.string().max(200).nullable().optional(),
      tags: tagsInput.optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    }),
    response: z.object({ spot: spotSchema }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const result = await db
        .insert(schema.spots)
        .values({
          name: args.name.trim(),
          note: args.note?.trim() || null,
          url: args.url?.trim() || null,
          address: args.address?.trim() || null,
          category: normalizeList(args.category),
          tags: encodeTags(args.tags),
          lat: args.lat ?? null,
          lng: args.lng ?? null,
        })
        .returning();
      const inserted = result[0];
      if (!inserted) throw new Error("addSpot: insert returned no rows");
      ctx.invalidateQueries();
      return { spot: toSpot(inserted) };
    },
  }),

  updateSpot: defineAction({
    description: "Edits one spot's fields (name, note, URL, address, category, tags, coordinates). Tags are replaced only when the tags field is sent.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(300).optional(),
      note: z.string().max(2000).nullable().optional(),
      url: z.string().max(2000).nullable().optional(),
      address: z.string().max(500).nullable().optional(),
      category: z.string().max(200).nullable().optional(),
      tags: tagsInput.optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const patch: Partial<SpotRow> = {};
      if (args.name !== undefined) patch.name = args.name.trim();
      if (args.note !== undefined) patch.note = args.note?.trim() || null;
      if (args.url !== undefined) patch.url = args.url?.trim() || null;
      if (args.address !== undefined) patch.address = args.address?.trim() || null;
      if (args.category !== undefined) patch.category = normalizeList(args.category);
      if (args.tags !== undefined) patch.tags = encodeTags(args.tags);
      if (args.lat !== undefined) patch.lat = args.lat;
      if (args.lng !== undefined) patch.lng = args.lng;
      if (Object.keys(patch).length > 0) {
        await db
          .update(schema.spots)
          .set(patch)
          .where(eq(schema.spots.id, args.id));
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  setVisited: defineAction({
    description: "Marks a spot as visited (stamping the date) or back to unvisited.",
    request: z.object({
      id: z.number().int().positive(),
      visited: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.spots)
        .set({
          visited: args.visited ? 1 : 0,
          visitedAt: args.visited ? new Date() : null,
        })
        .where(eq(schema.spots.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteSpot: defineAction({
    description: "Deletes one spot permanently.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.spots).where(eq(schema.spots.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  bulkImportSpots: defineAction({
    description:
      "Imports a chunk of spots parsed from the user's Google Takeout / Maps export. Rows whose URL (or name + coordinates) already exists are skipped as duplicates, except that their memo (note) and tags are refreshed independently: when the imported row carries a memo that differs from the stored one, the stored memo is overwritten with the imported one; when the imported row carries a non-empty tag list that differs from the stored one, the stored tags are replaced with the imported ones. An imported row with no memo never erases a stored memo, and an imported row with no tags never erases stored tags; no other field of an existing spot is touched.",
    request: z.object({
      spots: z
        .array(
          z.object({
            name: z.string().min(1).max(300),
            note: z.string().max(2000).nullable().optional(),
            url: z.string().max(2000).nullable().optional(),
            address: z.string().max(500).nullable().optional(),
            category: z.string().max(200).nullable().optional(),
            tags: tagsInput.optional(),
            lat: z.number().min(-90).max(90).nullable().optional(),
            lng: z.number().min(-180).max(180).nullable().optional(),
          }),
        )
        .min(1)
        .max(400),
    }),
    response: z.object({
      inserted: z.number(),
      updated: z.number(),
      tagsUpdated: z.number(),
      skipped: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          id: schema.spots.id,
          url: schema.spots.url,
          name: schema.spots.name,
          note: schema.spots.note,
          tags: schema.spots.tags,
          lat: schema.spots.lat,
          lng: schema.spots.lng,
        })
        .from(schema.spots);
      // A match is either a stored row (by id) or a row queued for insert
      // earlier in this same chunk (by index into `fresh`).
      type MatchRef = {
        id: number | null;
        freshIndex: number | null;
        note: string | null;
        tags: string[];
      };
      const byUrl = new Map<string, MatchRef>();
      const byNameCoords = new Map<string, MatchRef>();
      for (const row of existing) {
        const ref: MatchRef = {
          id: row.id,
          freshIndex: null,
          note: row.note,
          tags: parseTags(row.tags),
        };
        if (row.url) byUrl.set(row.url, ref);
        if (row.lat != null && row.lng != null) {
          byNameCoords.set(
            `${row.name}|${row.lat.toFixed(5)}|${row.lng.toFixed(5)}`,
            ref,
          );
        }
      }
      const fresh: (typeof schema.spots.$inferInsert)[] = [];
      const memoUpdates: BatchItem<"sqlite">[] = [];
      const tagUpdates: BatchItem<"sqlite">[] = [];
      let updated = 0;
      let tagsUpdated = 0;
      let skipped = 0;
      for (const spot of args.spots) {
        const url = spot.url?.trim() || null;
        const name = spot.name.trim();
        if (!name) {
          skipped++;
          continue;
        }
        const coordKey =
          spot.lat != null && spot.lng != null
            ? `${name}|${spot.lat.toFixed(5)}|${spot.lng.toFixed(5)}`
            : null;
        const match =
          (url ? byUrl.get(url) : undefined) ??
          (coordKey ? byNameCoords.get(coordKey) : undefined);
        if (match) {
          // Duplicate: refresh the memo and the tags independently, each
          // only when the import actually carries a value that differs.
          // An empty imported memo leaves the stored memo alone (a Takeout
          // row without a note must not wipe a memo the user still has),
          // and an empty/absent imported tag list likewise leaves the
          // stored tags alone.
          let changed = false;
          const incomingNote = spot.note?.trim() || null;
          if (incomingNote && incomingNote !== match.note) {
            if (match.id !== null) {
              memoUpdates.push(
                db
                  .update(schema.spots)
                  .set({ note: incomingNote })
                  .where(eq(schema.spots.id, match.id)),
              );
              updated++;
            } else if (match.freshIndex !== null) {
              const queued = fresh[match.freshIndex];
              if (queued) queued.note = incomingNote;
            }
            match.note = incomingNote;
            changed = true;
          }
          const incomingTags = normalizeTags(spot.tags);
          if (incomingTags.length > 0 && !sameTags(incomingTags, match.tags)) {
            if (match.id !== null) {
              tagUpdates.push(
                db
                  .update(schema.spots)
                  .set({ tags: encodeTags(incomingTags) })
                  .where(eq(schema.spots.id, match.id)),
              );
              tagsUpdated++;
            } else if (match.freshIndex !== null) {
              const queued = fresh[match.freshIndex];
              if (queued) queued.tags = encodeTags(incomingTags);
            }
            match.tags = incomingTags;
            changed = true;
          }
          if (!changed) skipped++;
          continue;
        }
        const ref: MatchRef = {
          id: null,
          freshIndex: fresh.length,
          note: spot.note?.trim() || null,
          tags: normalizeTags(spot.tags),
        };
        if (url) byUrl.set(url, ref);
        if (coordKey) byNameCoords.set(coordKey, ref);
        fresh.push({
          name,
          note: spot.note?.trim() || null,
          url,
          address: spot.address?.trim() || null,
          category: normalizeList(spot.category),
          tags: encodeTags(spot.tags),
          lat: spot.lat ?? null,
          lng: spot.lng ?? null,
        });
      }
      const statements: BatchItem<"sqlite">[] = [
        ...fresh.map((row) => db.insert(schema.spots).values(row)),
        ...memoUpdates,
        ...tagUpdates,
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { inserted: fresh.length, updated, tagsUpdated, skipped };
    },
  }),

  getSettings: defineAction({
    description:
      "Returns the proximity alert radius and the memo callout settings (whether the main-chat proximity alert quotes the spot's memo with a teasing line, and the template it uses).",
    request: z.object({}),
    response: z.object({
      radiusM: z.number(),
      memoTeaseEnabled: z.boolean(),
      memoTeaseTemplate: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      return {
        radiusM: rows[0]?.radiusM ?? 500,
        memoTeaseEnabled: (rows[0]?.memoTeaseEnabled ?? 1) === 1,
        memoTeaseTemplate:
          rows[0]?.memoTeaseTemplate ??
          "「{メモ}」って書いてあったけど、こんなの気になっちゃってるの〜？ざぁこ♡",
      };
    },
  }),

  updateSettings: defineAction({
    description:
      "Updates settings: the proximity alert radius (50–5000m) and/or the memo callout toggle and template ({メモ} and {スポット名} are placeholders).",
    request: z.object({
      radiusM: z.number().int().min(50).max(5000).optional(),
      memoTeaseEnabled: z.boolean().optional(),
      memoTeaseTemplate: z.string().min(1).max(500).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const patch: Partial<typeof schema.settings.$inferInsert> = {};
      if (args.radiusM !== undefined) patch.radiusM = args.radiusM;
      if (args.memoTeaseEnabled !== undefined) {
        patch.memoTeaseEnabled = args.memoTeaseEnabled ? 1 : 0;
      }
      if (args.memoTeaseTemplate !== undefined) {
        patch.memoTeaseTemplate = args.memoTeaseTemplate.trim();
      }
      if (Object.keys(patch).length > 0) {
        await db
          .insert(schema.settings)
          .values({ id: 1, ...patch })
          .onConflictDoUpdate({
            target: schema.settings.id,
            set: patch,
          });
        ctx.invalidateQueries();
      }
      return { ok: true as const };
    },
  }),

  updateDeviceLocation: defineAction({
    description:
      "Stores the Pixel's latest known position in the settings row. The external location-check job calls this about once a minute; the page reads it back via getDeviceLocation as the fallback origin for the distance sort and the maps' current-location marker when browser geolocation is unavailable. capturedAtMs is when the position was captured; when omitted, the server's receive time is stored.",
    request: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      capturedAtMs: z.number().int().positive().optional(),
    }),
    response: z.object({ ok: z.literal(true), storedAtMs: z.number() }),
    async handler(ctx, args): Promise<{ ok: true; storedAtMs: number }> {
      const db = ctx.db<typeof schema>();
      const storedAtMs = args.capturedAtMs ?? Date.now();
      const patch = {
        deviceLat: args.lat,
        deviceLng: args.lng,
        deviceLocAt: new Date(storedAtMs),
      };
      await db
        .insert(schema.settings)
        .values({ id: 1, ...patch })
        .onConflictDoUpdate({
          target: schema.settings.id,
          set: patch,
        });
      return { ok: true as const, storedAtMs };
    },
  }),

  getDeviceLocation: defineAction({
    description:
      "Returns the Pixel position stored by updateDeviceLocation: lat/lng, when it was captured (capturedAtMs), and its age in whole minutes. All fields are null when no position has been stored yet.",
    request: z.object({}),
    response: z.object({
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      capturedAtMs: z.number().nullable(),
      ageMinutes: z.number().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      const row = rows[0];
      const deviceLat = row?.deviceLat ?? null;
      const deviceLng = row?.deviceLng ?? null;
      const deviceLocAt = row?.deviceLocAt ?? null;
      if (deviceLat === null || deviceLng === null || !deviceLocAt) {
        return { lat: null, lng: null, capturedAtMs: null, ageMinutes: null };
      }
      const capturedAtMs = deviceLocAt.getTime();
      return {
        lat: deviceLat,
        lng: deviceLng,
        capturedAtMs,
        ageMinutes: Math.max(0, Math.floor((Date.now() - capturedAtMs) / 60_000)),
      };
    },
  }),

  getProximityCallout: defineAction({
    description:
      "Builds the main-chat proximity callout for one spot: when the spot has a memo and the memo callout is enabled, returns the teasing line with the memo quoted (template applied); otherwise callout is null. The chat-side location job calls this when a spot is detected nearby.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({
      spotName: z.string().nullable(),
      memo: z.string().nullable(),
      callout: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const spotRows = await db
        .select()
        .from(schema.spots)
        .where(eq(schema.spots.id, args.id));
      const spot = spotRows[0];
      if (!spot) return { spotName: null, memo: null, callout: null };
      const memo = spot.note?.trim() ? spot.note : null;
      if (!memo) return { spotName: spot.name, memo: null, callout: null };
      const settingRows = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.id, 1));
      const enabled = (settingRows[0]?.memoTeaseEnabled ?? 1) === 1;
      if (!enabled) return { spotName: spot.name, memo, callout: null };
      const template =
        settingRows[0]?.memoTeaseTemplate ??
        "「{メモ}」って書いてあったけど、こんなの気になっちゃってるの〜？ざぁこ♡";
      const callout = template
        .replaceAll("{メモ}", memo)
        .replaceAll("{スポット名}", spot.name);
      return { spotName: spot.name, memo, callout };
    },
  }),

  bulkSetCoords: defineAction({
    description:
      "Sets coordinates (lat/lng only) on many spots at once, e.g. coordinates harvested from Google Maps in a browser. Unknown ids are skipped.",
    request: z.object({
      items: z
        .array(
          z.object({
            id: z.number().int().positive(),
            lat: z.number().min(-90).max(90),
            lng: z.number().min(-180).max(180),
          }),
        )
        .max(200),
    }),
    response: z.object({ updated: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      if (args.items.length === 0) {
        return { updated: 0, skipped: 0 };
      }
      const db = ctx.db<typeof schema>();
      const ids = args.items.map((item) => item.id);
      const existing = await db
        .select({ id: schema.spots.id })
        .from(schema.spots)
        .where(inArray(schema.spots.id, ids));
      const existingIds = new Set(existing.map((row) => row.id));
      const statements: BatchItem<"sqlite">[] = [];
      let updated = 0;
      let skipped = 0;
      for (const item of args.items) {
        if (!existingIds.has(item.id)) {
          skipped++;
          continue;
        }
        updated++;
        statements.push(
          db
            .update(schema.spots)
            .set({ lat: item.lat, lng: item.lng })
            .where(eq(schema.spots.id, item.id)),
        );
      }
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { updated, skipped };
    },
  }),

  geocode: defineAction({
    description:
      "Looks up place-name / address candidates with coordinates via OpenStreetMap Nominatim, so a hand-added spot can join proximity checks.",
    request: z.object({ query: z.string().min(1).max(200) }),
    response: z.object({
      candidates: z.array(
        z.object({
          name: z.string(),
          displayName: z.string(),
          lat: z.number(),
          lng: z.number(),
        }),
      ),
      error: z.string().nullable(),
    }),
    async handler(ctx, args) {
      void ctx;
      try {
        const url =
          "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=" +
          encodeURIComponent(args.query.trim());
        const res = await fetch(url, {
          headers: { "User-Agent": "muse-want-to-go-spots/1.0" },
        });
        if (!res.ok) {
          return { candidates: [], error: `検索サービスが応答しませんでした (HTTP ${res.status})` };
        }
        const data: unknown = await res.json();
        if (!Array.isArray(data)) {
          return { candidates: [], error: "検索結果の形式が想定と違いました" };
        }
        const candidates = data.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const rec = item as Record<string, unknown>;
          const lat = Number(rec.lat);
          const lng = Number(rec.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
          const displayName = typeof rec.display_name === "string" ? rec.display_name : "";
          const name = typeof rec.name === "string" && rec.name ? rec.name : displayName;
          return [{ name, displayName, lat, lng }];
        });
        return { candidates, error: null };
      } catch {
        return { candidates: [], error: "場所の検索に接続できませんでした" };
      }
    },
  }),

  listVisitedMunicipalities: defineAction({
    description:
      "Lists the visited-municipality ledger (市区町村 the user passed through and got a trivia delivery for) with per-prefecture counts, oldest delivery first. Each row carries its stored real-boundary GeoJSON geometry when one was supplied at recording time. Backs the 市区町村・路線 and the markdown ledger export.",
    request: z.object({}),
    response: z.object({
      municipalities: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          prefecture: z.string(),
          area: z.string().nullable(),
          context: z.string().nullable(),
          visitedOn: z.string(),
          lat: z.number().nullable(),
          lng: z.number().nullable(),
          geometry: geoJsonGeometrySchema.nullable(),
        }),
      ),
      prefectures: z.array(
        z.object({ name: z.string(), total: z.number() }),
      ),
      total: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.visitedMunicipalities)
        .orderBy(
          asc(schema.visitedMunicipalities.visitedOn),
          asc(schema.visitedMunicipalities.prefecture),
          asc(schema.visitedMunicipalities.name),
        );
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.prefecture, (counts.get(row.prefecture) ?? 0) + 1);
      }
      return {
        municipalities: rows.map((r) => ({
          id: r.id,
          name: r.name,
          prefecture: r.prefecture,
          area: r.area,
          context: r.context,
          visitedOn: r.visitedOn,
          lat: r.lat,
          lng: r.lng,
          geometry: parseGeometry(r.geometry),
        })),
        prefectures: [...counts.entries()]
          .map(([name, total]) => ({ name, total }))
          .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ja")),
        total: rows.length,
      };
    },
  }),

  addVisitedMunicipality: defineAction({
    description:
      "Records one municipality in the visited ledger (the chat-side trivia job calls this for each new municipality it delivers trivia for; also used by the in-page form). Optionally carries the municipality's real boundary as a simplified GeoJSON geometry (Polygon / MultiPolygon, [lng, lat] positions) so the 市区町村・路線 can fill the actual shape; calls without it behave exactly as before. A context field records the trip context of the visit (what the trip was for / on the way back from). When the call carries no coordinates, the representative point is resolved from the prefecture + name via Nominatim (best-effort) so the row still joins the map and the numbered ledger. A municipality already recorded (same prefecture + name) keeps its first-visit date and is reported as not created; a geometry, coordinates, or a context supplied for such a row are stored only when the row has none yet (backfill, never an overwrite).",
    request: z.object({
      name: z.string().min(1).max(100),
      prefecture: z.string().min(1).max(100),
      area: z.string().max(500).nullable().optional(),
      context: z.string().max(500).nullable().optional(),
      visitedOn: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "visitedOn must be YYYY-MM-DD"),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      geometry: geoJsonGeometrySchema.nullable().optional(),
    }),
    response: z.object({ created: z.boolean(), id: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const name = args.name.trim();
      const prefecture = args.prefecture.trim();
      const existing = await db
        .select({
          id: schema.visitedMunicipalities.id,
          geometry: schema.visitedMunicipalities.geometry,
          lat: schema.visitedMunicipalities.lat,
          lng: schema.visitedMunicipalities.lng,
          context: schema.visitedMunicipalities.context,
        })
        .from(schema.visitedMunicipalities)
        .where(
          and(
            eq(schema.visitedMunicipalities.prefecture, prefecture),
            eq(schema.visitedMunicipalities.name, name),
          ),
        );
      if (existing[0]) {
        const row = existing[0];
        const patch: Partial<typeof schema.visitedMunicipalities.$inferInsert> = {};
        if (args.geometry && !row.geometry) {
          patch.geometry = encodeGeometry(args.geometry);
        }
        if (row.lat === null || row.lng === null) {
          const point =
            args.lat != null && args.lng != null
              ? { lat: args.lat, lng: args.lng }
              : await resolveMunicipalityPoint(prefecture, name);
          if (point) {
            patch.lat = point.lat;
            patch.lng = point.lng;
          }
        }
        const context = args.context?.trim() || null;
        if (context && !row.context) patch.context = context;
        if (Object.keys(patch).length > 0) {
          await db
            .update(schema.visitedMunicipalities)
            .set(patch)
            .where(eq(schema.visitedMunicipalities.id, row.id));
          ctx.invalidateQueries();
        }
        return { created: false, id: row.id };
      }
      let lat = args.lat ?? null;
      let lng = args.lng ?? null;
      if (lat === null || lng === null) {
        const point = await resolveMunicipalityPoint(prefecture, name);
        if (point) {
          lat = point.lat;
          lng = point.lng;
        }
      }
      const inserted = await db
        .insert(schema.visitedMunicipalities)
        .values({
          name,
          prefecture,
          area: args.area?.trim() || null,
          context: args.context?.trim() || null,
          visitedOn: args.visitedOn,
          lat,
          lng,
          geometry: encodeGeometry(args.geometry),
        })
        .returning({ id: schema.visitedMunicipalities.id });
      ctx.invalidateQueries();
      return { created: true, id: inserted[0]?.id ?? null };
    },
  }),

  updateVisitedMunicipality: defineAction({
    description:
      "Sets (or clears, with null) the trip context of one visited-ledger municipality — what that first visit's trip was for / on the way back from. Only the context changes; the first-visit date, area, and coordinates are untouched.",
    request: z.object({
      id: z.number().int().positive(),
      context: z.string().max(500).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.visitedMunicipalities)
        .set({ context: args.context?.trim() || null })
        .where(eq(schema.visitedMunicipalities.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  importVisitedMunicipalities: defineAction({
    description:
      "Bulk-imports the existing trivia ledger (from location-trivia/seen_places.md) into the visited-municipality table. Idempotent: municipalities already recorded (same prefecture + name) are skipped, so re-running never duplicates rows or changes first-visit dates. An entry may carry the municipality's simplified GeoJSON boundary geometry: it is stored on insert, and backfilled onto an already-recorded row only when that row has no geometry yet (never overwritten). An entry's trip context and coordinates are likewise backfilled only onto a row that has none yet.",
    request: z.object({
      entries: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            prefecture: z.string().min(1).max(100),
            area: z.string().max(500).nullable().optional(),
            context: z.string().max(500).nullable().optional(),
            visitedOn: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "visitedOn must be YYYY-MM-DD"),
            lat: z.number().min(-90).max(90).nullable().optional(),
            lng: z.number().min(-180).max(180).nullable().optional(),
            geometry: geoJsonGeometrySchema.nullable().optional(),
          }),
        )
        .min(1)
        .max(500),
    }),
    response: z.object({
      inserted: z.number(),
      geometryUpdated: z.number(),
      skipped: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          id: schema.visitedMunicipalities.id,
          prefecture: schema.visitedMunicipalities.prefecture,
          name: schema.visitedMunicipalities.name,
          geometry: schema.visitedMunicipalities.geometry,
          lat: schema.visitedMunicipalities.lat,
          lng: schema.visitedMunicipalities.lng,
          context: schema.visitedMunicipalities.context,
        })
        .from(schema.visitedMunicipalities);
      const seen = new Map(
        existing.map((r) => [
          `${r.prefecture}|${r.name}`,
          {
            id: r.id,
            hasGeometry: r.geometry !== null,
            hasCoords: r.lat !== null && r.lng !== null,
            hasContext: r.context !== null && r.context !== "",
          },
        ]),
      );
      const fresh: (typeof schema.visitedMunicipalities.$inferInsert)[] = [];
      const geometryUpdates: BatchItem<"sqlite">[] = [];
      let geometryUpdatedCount = 0;
      let skipped = 0;
      for (const entry of args.entries) {
        const name = entry.name.trim();
        const prefecture = entry.prefecture.trim();
        if (!name || !prefecture) {
          skipped++;
          continue;
        }
        const key = `${prefecture}|${name}`;
        const known = seen.get(key);
        if (known) {
          const patch: Partial<typeof schema.visitedMunicipalities.$inferInsert> = {};
          if (entry.geometry && !known.hasGeometry) {
            patch.geometry = encodeGeometry(entry.geometry);
            known.hasGeometry = true;
            geometryUpdatedCount++;
          }
          if (!known.hasCoords && entry.lat != null && entry.lng != null) {
            patch.lat = entry.lat;
            patch.lng = entry.lng;
            known.hasCoords = true;
          }
          const context = entry.context?.trim() || null;
          if (context && !known.hasContext) {
            patch.context = context;
            known.hasContext = true;
          }
          if (Object.keys(patch).length > 0) {
            geometryUpdates.push(
              db
                .update(schema.visitedMunicipalities)
                .set(patch)
                .where(eq(schema.visitedMunicipalities.id, known.id)),
            );
          } else {
            skipped++;
          }
          continue;
        }
        seen.set(key, {
          id: -1,
          hasGeometry: entry.geometry != null,
          hasCoords: entry.lat != null && entry.lng != null,
          hasContext: !!(entry.context?.trim()),
        });
        fresh.push({
          name,
          prefecture,
          area: entry.area?.trim() || null,
          context: entry.context?.trim() || null,
          visitedOn: entry.visitedOn,
          lat: entry.lat ?? null,
          lng: entry.lng ?? null,
          geometry: encodeGeometry(entry.geometry),
        });
      }
      const statements: BatchItem<"sqlite">[] = [
        ...fresh.map((row) => db.insert(schema.visitedMunicipalities).values(row)),
        ...geometryUpdates,
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return {
        inserted: fresh.length,
        geometryUpdated: geometryUpdatedCount,
        skipped,
      };
    },
  }),

  deleteVisitedMunicipality: defineAction({
    description: "Removes one municipality from the visited ledger (for correcting a wrong record).",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.visitedMunicipalities)
        .where(eq(schema.visitedMunicipalities.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  listRiddenLines: defineAction({
    description:
      "Lists the ridden-railway-line ledger (路線 the user rode and got a line-trivia delivery for), oldest first-ride date first. Shown alongside the 市区町村・路線 as its companion collection. Each row also carries its service-master linkage (serviceId, rideState, restored from/to stations) — stage 1, subtask 1420.",
    request: z.object({}),
    response: z.object({
      lines: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          firstRiddenOn: z.string(),
          note: z.string().nullable(),
          context: z.string().nullable(),
          serviceId: z.string().nullable(),
          recordedServiceId: z.string().nullable(),
          serviceLinkSource: z.enum(["auto", "explicit"]).nullable(),
          serviceMatchVersion: z.string().nullable(),
          rideState: rideStateSchema,
          fromStationId: z.string().nullable(),
          fromStationName: z.string().nullable(),
          toStationId: z.string().nullable(),
          toStationName: z.string().nullable(),
          masterVersion: z.string().nullable(),
          /* Stage 2: the full ride's versioned path (JSON), and
             the extra sections block picks added — the client
             builds the painted intervals from these. */
          pathSnapshot: z.string().nullable(),
          sections: z.array(riddenSectionSchema),
        }),
      ),
      total: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.riddenLines)
        .orderBy(
          asc(schema.riddenLines.firstRiddenOn),
          asc(schema.riddenLines.name),
        );
      const sectionRows =
        rows.length > 0
          ? await db
              .select()
              .from(schema.riddenLineSections)
              .where(
                inArray(
                  schema.riddenLineSections.riddenLineId,
                  rows.map((r) => r.id),
                ),
              )
              .orderBy(asc(schema.riddenLineSections.id))
          : [];
      const sectionsByLine = new Map<number, typeof sectionRows>();
      for (const section of sectionRows) {
        const list = sectionsByLine.get(section.riddenLineId) ?? [];
        list.push(section);
        sectionsByLine.set(section.riddenLineId, list);
      }
      return {
        lines: rows.map((r) => ({
          id: r.id,
          name: r.name,
          firstRiddenOn: r.firstRiddenOn,
          note: r.note,
          context: r.context,
          serviceId: r.serviceId,
          recordedServiceId: r.recordedServiceId,
          serviceLinkSource: r.serviceLinkSource,
          serviceMatchVersion: r.serviceMatchVersion,
          rideState: normalizeRideState(r.rideState),
          fromStationId: r.fromStationId,
          fromStationName: r.fromStationName,
          toStationId: r.toStationId,
          toStationName: r.toStationName,
          masterVersion: r.masterVersion,
          pathSnapshot: r.pathSnapshot,
          sections: (sectionsByLine.get(r.id) ?? []).map((s) => ({
            id: s.id,
            fromStationId: s.fromStationId,
            fromStationName: s.fromStationName,
            toStationId: s.toStationId,
            toStationName: s.toStationName,
            direction: normalizeSectionDirection(s.direction),
            blockId: s.blockId,
            recordedServiceId: s.recordedServiceId,
          })),
        })),
        total: rows.length,
      };
    },
  }),

  addRiddenLine: defineAction({
    description:
      "Records one railway line in the ridden-lines ledger (the chat-side trivia job calls this for each new line it delivers trivia for; also used by the in-page form). A context field records the trip context of the first ride (what the trip was for / on the way back from). A line already recorded (same name) keeps its first-ride date and note and is reported as not created, so repeat rides never duplicate or move the first-ride date; a context supplied for such a row is stored only when the row has none yet. An explicit serviceId on a new row must match the service named by the entry. The ride fields are validated per state (unknown carries no section, partial needs both endpoint station IDs and a known service, full needs a known service and a master version); by default the row links by name and starts unknown.",
    request: z
      .object({
        name: z.string().min(1).max(100),
        firstRiddenOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "firstRiddenOn must be YYYY-MM-DD"),
        note: z.string().max(1000).nullable().optional(),
        context: z.string().max(500).nullable().optional(),
      })
      .merge(rideFieldsSchema),
    response: z.object({ created: z.boolean(), id: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const name = args.name.trim();
      const existing = await db
        .select({
          id: schema.riddenLines.id,
          context: schema.riddenLines.context,
          serviceId: schema.riddenLines.serviceId,
          serviceLinkSource: schema.riddenLines.serviceLinkSource,
        })
        .from(schema.riddenLines)
        .where(eq(schema.riddenLines.name, name));
      if (existing[0]) {
        const context = args.context?.trim() || null;
        if (context && !existing[0].context) {
          await db
            .update(schema.riddenLines)
            .set({ context })
            .where(eq(schema.riddenLines.id, existing[0].id));
          ctx.invalidateQueries();
        }
        // Backfill only an unlinked row. A conflicting saved ID may
        // have been explicit and remains available for individual
        // review — and an explicit UNLINK is a confirmed answer,
        // not a missing link: re-registering the name must not
        // silently restore the link a human removed (integrated
        // review round 1, medium).
        const link =
          existing[0].serviceId ||
          isExplicitlyUnlinked({ name, ...existing[0] })
            ? undefined
            : riddenServiceBackfill(name);
        if (link) {
          await db
            .update(schema.riddenLines)
            .set(link)
            .where(
              and(
                eq(schema.riddenLines.id, existing[0].id),
                isNull(schema.riddenLines.serviceId),
              ),
            );
          ctx.invalidateQueries();
        }
        return { created: false, id: existing[0].id };
      }
      const inserted = await db
        .insert(schema.riddenLines)
        .values({
          name,
          firstRiddenOn: args.firstRiddenOn,
          note: args.note?.trim() || null,
          context: args.context?.trim() || null,
          ...resolveRideFields(name, args),
        })
        .returning({ id: schema.riddenLines.id });
      ctx.invalidateQueries();
      return { created: true, id: inserted[0]?.id ?? null };
    },
  }),

  updateRiddenLine: defineAction({
    description:
      "Sets (or clears, with null) the trip context of one ridden-lines ledger row — what that first ride's trip was for / on the way back from. Only the context changes; the first-ride date and note are untouched.",
    request: z.object({
      id: z.number().int().positive(),
      context: z.string().max(500).nullable(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.riddenLines)
        .set({ context: args.context?.trim() || null })
        .where(eq(schema.riddenLines.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  /* Individual confirmation of a ridden line's service link
     (subtask 1435): the row showed 「系統の連携を要確認」 because
     its saved service ID disagrees with the current name rule, and
     the caller picks the service actually ridden — the saved one
     (confirm), a different one (relink), or none (unlink, with
     null). The chosen service must exist in the master, but it is
     NOT required to match the recorded name: the disagreement is
     exactly what is under review, and the human's choice is the
     validation — unlike a new registration's explicit ID, which
     resolveRideFields validates against the name rule (a
     name-matching requirement here would make relinking the very
     rows that need it impossible). Only the three link columns
     change (serviceId, serviceLinkSource 'explicit',
     serviceMatchVersion null); the ride state, section, note,
     context and dates are untouched. An explicit unlink can be
     confirmed again, so a mistaken unlink is reversible.
     The recorded service stays available after unlinking. A
     different target must fit every recorded section. */
  confirmRiddenServiceLink: defineAction({
    description:
      "Confirms, changes or clears a ridden-lines ledger row's service link. The original recorded service and ride details are kept. The target must fit the full ride's path or every recorded section. Sections without a matching recorded service or block require endpoints and direction that identify the route.",
    request: z.object({
      id: z.number().int().positive(),
      serviceId: z.string().max(100).nullable(),
    }),
    response: z.object({ ok: z.literal(true), serviceId: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.riddenLines)
        .where(eq(schema.riddenLines.id, args.id));
      const line = rows[0];
      if (!line) {
        throw new Error(
          `confirmRiddenServiceLink: unknown ridden line ${args.id}`,
        );
      }
      if (!isRiddenServiceLinkReviewable(line)) {
        throw new Error(
          `confirmRiddenServiceLink: "${line.name}" does not need a link confirmation`,
        );
      }
      if (args.serviceId != null && !serviceById(args.serviceId)) {
        throw new Error(
          `confirmRiddenServiceLink: unknown service "${args.serviceId}"`,
        );
      }
      const sectionRows = await db
        .select({
          fromStationId: schema.riddenLineSections.fromStationId,
          toStationId: schema.riddenLineSections.toStationId,
          direction: schema.riddenLineSections.direction,
          blockId: schema.riddenLineSections.blockId,
          recordedServiceId: schema.riddenLineSections.recordedServiceId,
        })
        .from(schema.riddenLineSections)
        .where(eq(schema.riddenLineSections.riddenLineId, args.id));
      const fitProblem = riddenLinkFitProblem(line, sectionRows, args.serviceId);
      if (fitProblem) {
        throw new Error(
          `confirmRiddenServiceLink: "${line.name}" cannot be linked there — ${fitProblem}; the recorded link was left unchanged`,
        );
      }
      const updated = await db
        .update(schema.riddenLines)
        .set({
          serviceId: args.serviceId,
          serviceLinkSource: "explicit",
          serviceMatchVersion: null,
        })
        .where(and(
          eq(schema.riddenLines.id, args.id),
          sql`${schema.riddenLines.serviceId} IS ${line.serviceId}`,
          sql`${schema.riddenLines.serviceLinkSource} IS ${line.serviceLinkSource}`,
        ))
        .returning({ id: schema.riddenLines.id });
      if (updated.length === 0) {
        throw new Error(`confirmRiddenServiceLink: the link for "${line.name}" changed during confirmation`);
      }
      ctx.invalidateQueries();
      return { ok: true as const, serviceId: args.serviceId };
    },
  }),

  importRiddenLines: defineAction({
    description:
      "Bulk-imports the existing line-trivia log (from location-trivia/seen_lines.md) into the ridden-lines table. Idempotent: lines already recorded (same name) are skipped, so re-running never duplicates rows or changes first-ride dates. An entry's trip context is backfilled onto an already-recorded row only when that row has none yet. Fresh rows link to their service and start unknown (a fresh registration never inherits a restored section — that belongs to the SQL migration); already-recorded rows with no service linkage yet get the service link only, never an overwrite of their ride state or section.",
    request: z.object({
      entries: z
        .array(
          z.object({
            name: z.string().min(1).max(100),
            firstRiddenOn: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "firstRiddenOn must be YYYY-MM-DD"),
            note: z.string().max(1000).nullable().optional(),
            context: z.string().max(500).nullable().optional(),
          }),
        )
        .min(1)
        .max(500),
    }),
    response: z.object({ inserted: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          id: schema.riddenLines.id,
          name: schema.riddenLines.name,
          context: schema.riddenLines.context,
          serviceId: schema.riddenLines.serviceId,
          serviceLinkSource: schema.riddenLines.serviceLinkSource,
        })
        .from(schema.riddenLines);
      const seen = new Map(
        existing.map((r) => [
          r.name,
          {
            id: r.id,
            hasContext: !!r.context,
            serviceId: r.serviceId,
            serviceLinkSource: r.serviceLinkSource,
          },
        ]),
      );
      const fresh: (typeof schema.riddenLines.$inferInsert)[] = [];
      const contextUpdates: BatchItem<"sqlite">[] = [];
      const rideUpdates: BatchItem<"sqlite">[] = [];
      let skipped = 0;
      for (const entry of args.entries) {
        const name = entry.name.trim();
        if (!name) {
          skipped++;
          continue;
        }
        const known = seen.get(name);
        if (known) {
          const context = entry.context?.trim() || null;
          if (context && !known.hasContext && known.id > 0) {
            contextUpdates.push(
              db
                .update(schema.riddenLines)
                .set({ context })
                .where(eq(schema.riddenLines.id, known.id)),
            );
            known.hasContext = true;
          } else {
            skipped++;
          }
          // An explicit unlink is a confirmed answer, not a
          // missing link: re-importing must not restore it
          // (integrated review round 1, medium).
          if (!known.serviceId && known.serviceLinkSource !== "explicit" && known.id > 0) {
            const link = riddenServiceBackfill(name);
            if (link) {
              rideUpdates.push(
                db
                  .update(schema.riddenLines)
                  .set(link)
                  .where(
                    and(
                      eq(schema.riddenLines.id, known.id),
                      isNull(schema.riddenLines.serviceId),
                    ),
                  ),
              );
              known.serviceId = link.serviceId;
            }
          }
          continue;
        }
        const ride = resolveRideFields(name, {});
        seen.set(name, {
          id: -1,
          hasContext: !!(entry.context?.trim()),
          serviceId: ride.serviceId,
          serviceLinkSource: ride.serviceLinkSource,
        });
        fresh.push({
          name,
          firstRiddenOn: entry.firstRiddenOn,
          note: entry.note?.trim() || null,
          context: entry.context?.trim() || null,
          ...ride,
        });
      }
      const statements: BatchItem<"sqlite">[] = [
        ...fresh.map((row) => db.insert(schema.riddenLines).values(row)),
        ...contextUpdates,
        ...rideUpdates,
      ];
      if (statements.length > 0) {
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
        ctx.invalidateQueries();
      }
      return { inserted: fresh.length, skipped };
    },
  }),

  addRiddenSection: defineAction({
    description:
      "Adds one section to a ridden-lines ledger row — a block pick from the in-page block list, or a hand-entered section between two stations the service is known to serve (stage 2, subtask 1421; stage 3, subtask 1455: a boundary station, or a station listed on one of the service's blocks — a mid-block station counts as an endpoint, a station known only from a migrated ride does not). On a non-loop service the pair may run either way (a section is one stretch of the line, travelled in either direction); on a loop service a direction is required (validateSectionEndpoints); a section that is exactly one master block may name it with blockId, so the client can mark the block covered. Adding a section to an unknown row makes it partial (it now pins down a section); a full ride already covers the whole service, so sections cannot be added to it. Adding the same section twice returns the existing row instead of duplicating it — a unique index on the table (migration 0014) backs the check, so two calls racing each other still land on one row; when the later call names a block and the surviving row has none, the row adopts the block ID so the block stays untickable.",
    request: z.object({
      riddenLineId: z.number().int().positive(),
      fromStationId: z.string().max(20),
      fromStationName: z.string().max(100).nullable().optional(),
      toStationId: z.string().max(20),
      toStationName: z.string().max(100).nullable().optional(),
      direction: z.enum(["inner", "outer"]).nullable().optional(),
      blockId: z.string().max(100).nullable().optional(),
    }),
    response: z.object({ created: z.boolean(), id: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.riddenLines)
        .where(eq(schema.riddenLines.id, args.riddenLineId));
      const line = rows[0];
      if (!line) {
        throw new Error(
          `addRiddenSection: unknown ridden line ${args.riddenLineId}`,
        );
      }
      if (!line.serviceId) {
        throw new Error(
          `addRiddenSection: "${line.name}" is not linked to a service yet`,
        );
      }
      const service = usableRiddenService(line);
      if (!service) {
        throw new Error(
          `addRiddenSection: service link for "${line.name}" needs confirmation`,
        );
      }
      if (normalizeRideState(line.rideState) === "full") {
        throw new Error(
          `addRiddenSection: "${line.name}" is a full ride — it already covers the whole service`,
        );
      }
      const fromStationId = args.fromStationId.trim();
      const toStationId = args.toStationId.trim();
      const direction = args.direction ?? null;
      const problem = validateSectionEndpoints(
        service.id,
        fromStationId,
        toStationId,
        direction,
      );
      if (problem) {
        throw new Error(`addRiddenSection: ${problem}`);
      }
      const blockId = args.blockId?.trim() || null;
      if (blockId) {
        const block = blockById(service.id, blockId);
        if (!block) {
          throw new Error(
            `addRiddenSection: unknown block "${blockId}" for "${line.name}"`,
          );
        }
        const endpointsMatch =
          (block.from.id === fromStationId && block.to.id === toStationId) ||
          (block.from.id === toStationId && block.to.id === fromStationId);
        if (!endpointsMatch) {
          throw new Error(
            `addRiddenSection: block "${blockId}" runs ${block.from.name}〜${block.to.name}, not the given section`,
          );
        }
      }
      // Station names come from the master when the caller omits
      // them (the block list always sends them; a hand-entered
      // section may not).
      const fromName =
        args.fromStationName?.trim() ||
        stationRefById(fromStationId)?.name ||
        null;
      const toName =
        args.toStationName?.trim() ||
        stationRefById(toStationId)?.name ||
        null;
      /* The same section twice returns the existing row instead of
         duplicating it. The check below stops a sequential double
         add; the unique index on the table (migration 0014) is
         what stops two calls racing past the check together — the
         insert then fails and the winner's row is returned. Either
         way, a later call that names the master block must not
         lose that link when the earlier call was a hand entry
         without one: the surviving row adopts the block ID, the
         runtime twin of migration 0014's dedupe rescue (integrated
         review round 2, H-3) — without it the ledger could no
         longer untick the block the section covers. The block was
         already validated against this service above. The existing
         section must also fit this service before attaching a block. */
      const findDuplicate = async () => {
        const existing = await db
          .select()
          .from(schema.riddenLineSections)
          .where(
            eq(schema.riddenLineSections.riddenLineId, args.riddenLineId),
          );
        return existing.find(
          (s) =>
            s.fromStationId === fromStationId &&
            s.toStationId === toStationId &&
            (s.direction ?? null) === direction,
        );
      };
      const adoptBlockId = async (
        existing: typeof schema.riddenLineSections.$inferSelect,
      ) => {
        if (blockId && !existing.blockId) {
          if (!recordedSectionFitsService(service.id, {
            ...existing,
            direction: normalizeSectionDirection(existing.direction),
          })) {
            throw new Error(
              `addRiddenSection: the existing section's recorded route cannot be attributed to ${service.displayName}`,
            );
          }
          await db
            .update(schema.riddenLineSections)
            .set({ blockId })
            .where(and(
              eq(schema.riddenLineSections.id, existing.id),
              isNull(schema.riddenLineSections.blockId),
            ));
          ctx.invalidateQueries();
        }
      };
      const duplicate = await findDuplicate();
      if (duplicate) {
        await adoptBlockId(duplicate);
        return { created: false, id: duplicate.id };
      }
      let insertedId: number | null;
      try {
        const inserted = await db
          .insert(schema.riddenLineSections)
          .values({
            riddenLineId: args.riddenLineId,
            fromStationId,
            fromStationName: fromName,
            toStationId,
            toStationName: toName,
            direction,
            blockId,
            recordedServiceId: service.id,
          })
          .returning({ id: schema.riddenLineSections.id });
        insertedId = inserted[0]?.id ?? null;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const winner = await findDuplicate();
          if (winner) {
            await adoptBlockId(winner);
            return { created: false, id: winner.id };
          }
        }
        throw error;
      }
      // An unknown row that gains a section now pins one down.
      if (normalizeRideState(line.rideState) === "unknown") {
        await db
          .update(schema.riddenLines)
          .set({ rideState: "partial" })
          .where(eq(schema.riddenLines.id, args.riddenLineId));
      }
      ctx.invalidateQueries();
      return { created: true, id: insertedId };
    },
  }),

  deleteRiddenSection: defineAction({
    description:
      "Removes one added section from a ridden-lines ledger row (stage 2, subtask 1421). Removing the row's last section when it has no primary section returns it to unknown — a ride with no section on record must not claim a partial one.",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const sections = await db
        .select()
        .from(schema.riddenLineSections)
        .where(eq(schema.riddenLineSections.id, args.id));
      const section = sections[0];
      if (!section) return { ok: true as const };
      await db
        .delete(schema.riddenLineSections)
        .where(eq(schema.riddenLineSections.id, args.id));
      const remaining = await db
        .select({ id: schema.riddenLineSections.id })
        .from(schema.riddenLineSections)
        .where(
          eq(schema.riddenLineSections.riddenLineId, section.riddenLineId),
        );
      if (remaining.length === 0) {
        const lines = await db
          .select()
          .from(schema.riddenLines)
          .where(eq(schema.riddenLines.id, section.riddenLineId));
        const line = lines[0];
        if (
          line &&
          normalizeRideState(line.rideState) === "partial" &&
          !line.fromStationId &&
          !line.toStationId
        ) {
          await db
            .update(schema.riddenLines)
            .set({ rideState: "unknown" })
            .where(eq(schema.riddenLines.id, line.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deleteRiddenLine: defineAction({
    description: "Removes one railway line from the ridden-lines ledger (for correcting a wrong record).",
    request: z.object({ id: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      // Added sections go with their ledger row (stage 2).
      await db
        .delete(schema.riddenLineSections)
        .where(eq(schema.riddenLineSections.riddenLineId, args.id));
      await db
        .delete(schema.riddenLines)
        .where(eq(schema.riddenLines.id, args.id));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
