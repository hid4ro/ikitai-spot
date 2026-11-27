import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SafeAreaTopScrim, setFailureNoticeText } from "@hatch/space-sdk/client";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { api, type ApiResponse } from "./api";
import { mountPlaceListMap } from "./map-helpers.mjs";
import type { MapLibreLike, PlaceListMapHandle } from "./map-helpers.mjs";
import type { GeoJsonGeometry } from "./geojson";
import {
  ensureBoundaryManifest,
  ensurePrefectureBorders,
  getBoundaryGeometryByKey,
  getBoundaryVersion,
  getPrefectureBorderLines,
  getPrefectureMunicipalityTotals,
  isBoundaryCoverageComplete,
  isBoundaryLoadFailed,
  loadBoundaryPriorities,
  loadRemainingBoundaryPrefectures,
  nearestBoundaryPrefectureName,
  subscribeBoundaryData,
} from "./boundary-data";
import {
  JAPAN_LINE_TOTAL,
  JAPAN_MUNICIPALITY_TOTAL,
  RIDDEN_LINE_GEOMETRIES,
} from "./assets/visited-lines";
import {
  buildLineKeyByName,
  resolveRiddenLineKey,
} from "./line-resolution";
import {
  SERVICE_MASTER,
  blocksForService,
  isRiddenServiceLinkReviewable,
  resolveRiddenService,
  sectionEndpointsKnownToService,
  serviceById,
  serviceIsLoop,
  serviceOrderedStations,
  usableRiddenService,
  validateSectionEndpoints,
} from "../../shared/service-master";
import {
  computeRiddenLineCoverage,
  coveredBlockIds,
  focusSectionFeature,
  paintedLegFeature,
  remainderLegFeature,
  riddenLineIntervals,
  servicePaintColor,
  wholeLineBounds,
  type LineCoverage,
  type LineGeometryMap,
  type PaintedLegFeature,
  type PathLeg,
} from "./line-geometry";
import {
  ghostCoverageKey,
  ghostFeaturesMatchCoverage,
  serializeGhostCoverage,
  trimUnriddenGhostFeatures,
} from "./unridden-ghost";
import { createUnriddenGhostClient } from "./unridden-ghost-client";
import {
  JAPAN_LINE_TOTAL_KM,
  OPERATOR_TOTAL_KM,
} from "./line-totals";
import {
  firstLineByOperator,
  groupLinesByOperator,
  nearestRiddenLine,
  operatorOfLine,
  UNKNOWN_OPERATOR_GROUP,
} from "./line-focus";
import {
  applyUnriddenLineGhostLatest,
  applyVariantPaint,
  decideSpotDataRemount,
  GHOST_SPOT_PAINT,
  lineRowForPaintedFeature,
  mapPaneBlockRendered,
  municipalityRowForPaintedName,
  shouldMountLiveMap,
  spotsInitialCamera,
  stickyPaneVisibleTop,
  UNRIDDEN_FOCUS_SOURCE_ID,
  UNRIDDEN_LINES_SOURCE_ID,
  ensureUnriddenRemainderFocus,
  unriddenRemainderKeysForRow,
  unriddenRemainderKeysForSelection,
  unriddenRemainderLegsForRow,
  unriddenRemainderLegsForSelection,
  type MapMountKeys,
  type RecordMapVariant,
  type RemainderLeg,
  type UnriddenGhostResult,
  type UnriddenLineFeature,
} from "./map-variant";
import {
  createSelectionSequencer,
  fallbackPhaseAfterReady,
} from "./spot-selection";
import { conquestTimelineForVariant } from "./conquest-timeline";
import { formatProgressValue, progressTickFraction } from "./progress-format";
import {
  isTapAfterPress,
  pointFromMapEvent,
  type PressSnapshot,
} from "./tap-guard";
import {
  autoFitGate,
  autoFitMayApply,
  autoFitMayPublishLocation,
  consumeRecordRetakeCameraRequest,
  createAutoFitRuns,
  createAutoFitShots,
  createSharedLocationPublisher,
  fitBoundsPadding,
  focusCameraPlan,
  resolveFrameLocation,
} from "./map-framing";
import {
  geometryBounds,
  geometryContainsPoint,
} from "./municipality-geometry";
import { acquireScrollLock } from "./scroll-lock";
import visitedMapFallbackUrl from "./assets/visited-map-fallback.png";
import unriddenGhostWorkerUrl from "./assets/unridden-ghost-worker.json" with { type: "file" };

const unriddenGhostClient = createUnriddenGhostClient(unriddenGhostWorkerUrl);

/* Input limits come from the server actions' request schemas, so the
   form fields and the server can never disagree (platform v29). */
const FIELDS = actionFields<typeof Actions>();

/* One shared height for the unified map's single pane, which
   serves all three map tabs — so switching tabs never changes
   the map's footprint. The height tracks the viewport (40% of
   it) up to a 20rem cap: tall enough to read, small enough
   that the list below stays in reach (the reader found the old
   60dvh / 32rem pane far too big). Horizontally the pane breaks out
   of the page column's side padding and runs edge to edge. */
const MAP_PANE_HEIGHT = "h-[min(40dvh,20rem)]";

/* The fixed bottom tab bar's real height (content + safe-area
   inset), measured from the live element: fullscreen framing
   pads the map's bottom by it (map-framing.ts's
   fitBoundsPadding), so the number must track the bar itself,
   never a copied constant. 0 when the bar is not mounted. */
function bottomTabBarHeightPx(): number {
  if (typeof document === "undefined") return 0;
  const bar = document.querySelector<HTMLElement>("[data-bottom-tab-bar]");
  return bar ? bar.getBoundingClientRect().height : 0;
}

/* Fullscreen toggle for the shared map pane (subtask 1484):
   the map's bottom-left corner, over the canvas. It began in
   the top-right corner, landed exactly on the runtime's zoom-in
   button, and moved below the navigation group (subtask 1556) —
   a spot the reader still found awkward (「位置がダサい」, with
   a bottom-left suggested instead, 2026-11-26; subtask 1564).
   The bottom-left is free in both layouts: the runtime's
   navigation control sits top-right and its attribution
   bottom-right, and nothing else claims the corner. In
   fullscreen the wrapper is fixed inset-0 UNDER the bottom tab
   bar (z-30 against the bar's z-40), so the button lifts by the
   bar's measured height — the same live measurement
   fitBoundsPadding and the fallback cover's attribution link
   use — and stays tappable just above the bar. The fullscreen
   itself is CSS, not the Fullscreen API — the API would hide
   the bottom tab bar, and the reader asked for the bar to stay
   on top of the map so tabs can still be switched while
   fullscreen. The button lives in the pane's wrapper (the
   element that goes fixed), so it stays visible in the
   fallback / failure states too. */
function MapFullscreenButton({
  fullscreen,
  onToggle,
}: {
  fullscreen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={fullscreen ? "全画面表示を終了" : "地図を全画面表示"}
      aria-pressed={fullscreen}
      title={fullscreen ? "全画面表示を終了" : "地図を全画面表示"}
      style={fullscreen ? { bottom: bottomTabBarHeightPx() + 8 } : undefined}
      className="absolute bottom-2 left-2 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--dim)] shadow-[0_2px_8px_rgb(0_0_0/0.18)]"
    >
      {fullscreen ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
        </svg>
      )}
    </button>
  );
}

/* Save failures that no mutation handles itself surface as a bottom
   notice; word it in Japanese to match the page. Mutations that render
   their own error text pass onError, so they never double-report. */
setFailureNoticeText(() => "保存に失敗しました。もう一度お試しください。");
/* The bundled Meta map runtime: a classic script copied into assets that
   registers globalThis.HatchMaps. Imported for its side effect so it ships
   inside the single client bundle. */
import "./assets/hatch-maps.js";

type Spot = ApiResponse<typeof api, "listSpots">["spots"][number];
/* One plotted spot on the spot list's pinned map: a spot with
   coordinates plus its detail fields (memo capped at 200 chars by
   the server). */
type SpotMapPoint = ApiResponse<typeof api, "listSpotPoints">["points"][number];
/* One row of the ridden-lines ledger (乗った路線). */
type RiddenLine = ApiResponse<typeof api, "listRiddenLines">["lines"][number];
type ImportRow = {
  name: string;
  note?: string | null;
  url?: string | null;
  address?: string | null;
  category?: string | null;
  tags?: string[];
  lat?: number | null;
  lng?: number | null;
};

/* Human-readable distance for the distance sort: metres under 1 km,
   one decimal of kilometres above (850m / 3.2km). */
function formatDistanceKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

/* Great-circle distance in kilometres between two coordinates. The
   distance SORT's distances are computed server-side; this exists
   only for the spot-list map's nearest-spot framing. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* The one link a spot's 「地図で開く」 may point at: the spot's own URL
   only when it is an http(s) URL (anything else — a javascript: URL, a
   bare path, a typo — must never reach an href); otherwise the
   Google Maps search URL built from the spot's coordinates. A spot
   with neither a usable URL nor coordinates gets no link at all. */
function spotMapsHref(spot: {
  url: string | null;
  lat: number | null;
  lng: number | null;
}): string | null {
  if (spot.url && /^https?:\/\//i.test(spot.url)) return spot.url;
  if (spot.lat !== null && spot.lng !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`;
  }
  return null;
}

/* The Pixel position stored server-side (getDeviceLocation) is only
   trusted while it is at most this old — the location-check job
   writes about once a minute, so 30 minutes of slack covers a
   sleeping phone without ever sorting around a stale point. */
const DEVICE_LOCATION_FRESH_MS = 30 * 60 * 1000;
/* A single read of the stored Pixel position gets at most this long
   before the reader is told it could not be confirmed. Without the
   cap, a read that never settles left 「Pixelの位置を確認中…」 on
   screen forever (the position itself is written about once a
   minute and is normally already stored, so the read is one quick
   round-trip — waiting longer never helps). */
const DEVICE_READ_TIMEOUT_MS = 12_000;
type DeviceLocationData = ApiResponse<typeof api, "getDeviceLocation">;

function freshDeviceCoords(
  data: DeviceLocationData | null,
): { lat: number; lng: number; capturedAtMs: number } | null {
  if (!data || data.lat === null || data.lng === null || data.capturedAtMs === null) {
    return null;
  }
  if (Date.now() - data.capturedAtMs > DEVICE_LOCATION_FRESH_MS) return null;
  return { lat: data.lat, lng: data.lng, capturedAtMs: data.capturedAtMs };
}

function deviceAgeMinutes(capturedAtMs: number): number {
  return Math.max(0, Math.floor((Date.now() - capturedAtMs) / 60_000));
}

/* A camera move asked for by an explicit re-take (the reader pressed
   「Pixelの位置を取り直す」 on a map): each successful re-take mints
   a new request with the next seq, and each map applies a request
   for its own target at most once (tracked by its applied-seq ref).
   A fresh object per re-take — even at the SAME coordinates as the
   previous one — is what lets a re-take pull the camera back to the
   current location after the reader panned away by hand, which a
   coordinates-change signal alone could never express. Camera
   requests are the ONLY thing that moves a map camera on a re-take:
   the 60 s background follow and the deviceLoc adoption stay
   marker-only. */
type MapCameraRequest = {
  seq: number;
  target: "spots" | "visited";
  lat: number;
  lng: number;
  /* The capture time of the stored position the re-take read
     that minted this request (v89 review round 6, P2-1): the
     camera-request effect adopts the position into the shared
     location through the single funnel, and the funnel needs
     the capture time to refuse a request held while another
     route adopted a newer position. */
  capturedAtMs: number;
};
/* The outcome of the map-only re-take (App's retakeMapDeviceLocation):
   the calling map's button uses it to report a failure in place —
   no camera request is issued on failure, so the map keeps its view
   and its previous marker, and the button explains what happened.
   "superseded" means a newer device request won the race; the newer
   request's own outcome drives the UI, so callers show nothing. */
type RetakeDeviceResult =
  | { ok: true }
  | {
      ok: false;
      reason: "stale" | "none" | "error" | "superseded";
      at: number | null;
    };

/* Where the maps' current-location marker goes: the Pixel position
   stored server-side by the location-check job, while it is fresh.
   Browser geolocation is NOT used anywhere on this page anymore
   (the reader's call: the Muse in-app browser cannot geolocate,
   so the option only confused — the position source is the Pixel
   alone now). The label carries the position's age, so the reader
   always knows how current the marker is. Null when no fresh
   stored position can be read. */
async function resolveCurrentLocation(): Promise<{
  lat: number;
  lng: number;
  label: string;
  /* The stored position's capture time, carried through so
     the framing publish gate can compare it across tabs
     (v89 review round 5): a read held across a tab switch
     must not rewind the shared location with older
     coordinates. Callers that only plot the position
     ignore it. */
  capturedAtMs: number;
} | null> {
  try {
    const stored = freshDeviceCoords(
      await Promise.race([
        api.getDeviceLocation({}),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), DEVICE_READ_TIMEOUT_MS),
        ),
      ]),
    );
    if (stored) {
      return {
        lat: stored.lat,
        lng: stored.lng,
        label: `Pixelの位置（${deviceAgeMinutes(stored.capturedAtMs)}分前）`,
        capturedAtMs: stored.capturedAtMs,
      };
    }
  } catch {
    /* a failed read leaves no marker, same as no stored position */
  }
  return null;
}

/* Draws the current-location marker on a live map: a blue disc with a
   white rim in its own source/layer, sized and colored to read as
   "you are here" next to the small orange spot dots and the green
   municipality fills. The camera pans to the point but the zoom is
   left exactly as the reader had it (flyTo without a zoom keeps the
   current one). */
function drawCurrentLocationMarker(
  map: MapLibreLike,
  lat: number,
  lng: number,
  pan: boolean,
) {
  if (!map.getSource("current-location")) {
    map.addSource("current-location", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
  }
  if (!map.getLayer("current-location-circle")) {
    map.addLayer({
      id: "current-location-circle",
      type: "circle",
      source: "current-location",
      paint: {
        "circle-radius": 9,
        "circle-color": "#2563eb",
        "circle-opacity": 0.9,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 3,
        "circle-stroke-opacity": 1,
      },
    });
  }
  map.getSource("current-location")?.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [lng, lat] },
      },
    ],
  });
  if (pan) {
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* A deliberate pan first stops whatever camera animation the
       previous tab left running (review round 1, finding 7). */
    try {
      map.stop?.();
    } catch {
      /* stopping is best-effort */
    }
    map.flyTo({ center: [lng, lat], duration: reduceMotion ? 0 : 800 });
  }
}

/* Splits a raw tag cell (Takeout "Tags" column / form input) into a clean
   tag list: comma / semicolon / 、 separated, trimmed, deduped. */
function splitTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;、\n]/)) {
    const t = part.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/* ---------------- dashboard polling: compare before reflecting ----------------
   (phase 4) The 15s dashboard poll must stay quiet: a response that
   changes nothing must not move a number, a row, the scroll position,
   or the focus. These helpers are the structuralSharing functions of
   the stats / lists / tags queries — React Query runs each incoming
   response through them before it can become the displayed data, so
   an identical aggregate keeps its previous object identity, and in
   the list counts each unchanged row (keyed by its list name, the
   stable ID) keeps its own identity while a changed row is replaced
   on its own. */

function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqualJson(item, b[i]));
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  if (aKeys.length !== Object.keys(bRec).length) return false;
  return aKeys.every((key) => deepEqualJson(aRec[key], bRec[key]));
}

function shareJson<T>(oldData: T | undefined, newData: T): T {
  return oldData !== undefined && deepEqualJson(oldData, newData) ? oldData : newData;
}

type StatsData = ApiResponse<typeof api, "getStats">;
type ListsData = ApiResponse<typeof api, "listLists">;
type TagsData = ApiResponse<typeof api, "listTags">;

function shareLists(oldData: ListsData | undefined, newData: ListsData): ListsData {
  if (!oldData) return newData;
  const oldByName = new Map(oldData.lists.map((row) => [row.name, row]));
  let identical = oldData.lists.length === newData.lists.length;
  const lists = newData.lists.map((row, i) => {
    const old = oldByName.get(row.name);
    if (old && deepEqualJson(old, row)) {
      if (oldData.lists[i] !== old) identical = false;
      return old;
    }
    identical = false;
    return row;
  });
  return identical ? oldData : { lists };
}

/* ---------------- import parsing (client-side) ---------------- */

function extractCoordsFromUrl(url: string): { lat: number; lng: number } | null {
  const patterns = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /[?&](?:query|destination|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m && m[1] && m[2]) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
  }
  return null;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function csvToSpots(text: string, fallbackCategory: string): ImportRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const first = rows[0] ?? [];
  const header = first.map((h) => h.trim().toLowerCase());
  const findCol = (names: string[]) => header.findIndex((h) => names.includes(h));
  const nameIdx = findCol(["title", "name", "名前", "タイトル"]);
  const hasHeader = nameIdx >= 0 || header.includes("url");
  const noteIdx = findCol(["note", "comment", "description", "メモ"]);
  const urlIdx = findCol(["url", "link", "リンク"]);
  const tagsIdx = findCol(["tags", "tag", "タグ"]);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const ni = hasHeader ? nameIdx : 0;
  const oi = hasHeader ? noteIdx : 1;
  const ui = hasHeader ? urlIdx : 2;
  const ti = hasHeader ? tagsIdx : -1;
  const out: ImportRow[] = [];
  for (const r of dataRows) {
    const name = (ni >= 0 ? r[ni] : undefined)?.trim();
    if (!name) continue;
    const url = (ui >= 0 ? r[ui] : undefined)?.trim() || null;
    const coords = url ? extractCoordsFromUrl(url) : null;
    const tagsCell = (ti >= 0 ? r[ti] : undefined)?.trim() || "";
    out.push({
      name,
      note: (oi >= 0 ? r[oi] : undefined)?.trim() || null,
      url,
      category: fallbackCategory,
      tags: tagsCell ? splitTags(tagsCell) : [],
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
    });
  }
  return out;
}

function geoJsonToSpots(text: string, fallbackCategory: string): ImportRow[] {
  const data: unknown = JSON.parse(text);
  const features: unknown[] = Array.isArray(data)
    ? data
    : typeof data === "object" && data !== null && Array.isArray((data as { features?: unknown }).features)
      ? ((data as { features: unknown[] }).features as unknown[])
      : typeof data === "object" && data !== null && (data as { type?: unknown }).type === "Feature"
        ? [data]
        : [];
  const out: ImportRow[] = [];
  for (const f of features) {
    if (typeof f !== "object" || f === null) continue;
    const feature = f as {
      properties?: Record<string, unknown> | null;
      geometry?: { type?: unknown; coordinates?: unknown } | null;
    };
    const props = feature.properties ?? {};
    const rawName = props.name ?? props.Title ?? props.title;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) continue;
    let lat: number | null = null;
    let lng: number | null = null;
    const coords = feature.geometry?.coordinates;
    if (
      feature.geometry?.type === "Point" &&
      Array.isArray(coords) &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      lng = coords[0];
      lat = coords[1];
    }
    const rawUrl = props.url ?? props["Google Maps URL"] ?? props.Link;
    const url = typeof rawUrl === "string" && rawUrl ? rawUrl : null;
    if (lat === null && url) {
      const c = extractCoordsFromUrl(url);
      if (c) {
        lat = c.lat;
        lng = c.lng;
      }
    }
    const rawDesc = props.description ?? props.Note ?? props.note;
    const rawAddr = props.address ?? props.Address;
    const rawTags = props.Tags ?? props.tags ?? props.Tag;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
      : typeof rawTags === "string"
        ? splitTags(rawTags)
        : [];
    out.push({
      name,
      note: typeof rawDesc === "string" ? rawDesc : null,
      url,
      address: typeof rawAddr === "string" ? rawAddr : null,
      category: fallbackCategory,
      tags,
      lat,
      lng,
    });
  }
  return out;
}

/* ---------------- small components ---------------- */

function StatCell({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3">
      <p className="text-xs text-[var(--dim)]">{label}</p>
      <p
        className={`mt-0.5 font-[family-name:var(--font-display)] text-2xl font-black leading-none ${
          accent ? "text-[var(--accent)]" : "text-[var(--text)]"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-[var(--dim)]">{sub}</p>}
    </div>
  );
}

function ProgressBar({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-[var(--dim)]">{label}</span>
        <span className="font-medium">
          {value.toLocaleString()} / {total.toLocaleString()}件（{pct}%）
        </span>
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-[var(--surface-alt)]"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* Subtask 450 — the fill eases to its new width over 200ms
            (design memo: 150–250ms, ease out) instead of jumping, so
            a poll that moves a number reads as movement; the number
            itself is always shown, and the bar only moves when the
            value actually changes. */}
        <div className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ---------------- spot form (add / edit) ---------------- */

function SpotForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  busy,
  listNames,
  defaultList,
}: {
  initial?: Spot | null;
  submitLabel: string;
  onSubmit: (row: ImportRow & { name: string }) => void;
  onCancel?: () => void;
  busy: boolean;
  listNames: string[];
  defaultList?: string | null;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [tagsText, setTagsText] = useState((initial?.tags ?? []).join(", "));
  const [category, setCategory] = useState(initial?.category ?? defaultList ?? "行ってみたい");
  const [lat, setLat] = useState<number | null>(initial?.lat ?? null);
  const [lng, setLng] = useState<number | null>(initial?.lng ?? null);
  const [geoQuery, setGeoQuery] = useState("");
  const [candidates, setCandidates] = useState<
    { name: string; displayName: string; lat: number; lng: number }[]
  >([]);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const runGeocode = async () => {
    const q = geoQuery.trim() || name.trim() || address.trim();
    if (!q) {
      setGeoMsg("まずスポット名か住所を入れてください");
      return;
    }
    setGeoBusy(true);
    setGeoMsg(null);
    try {
      const res = await api.geocode({ query: q });
      setCandidates(res.candidates);
      if (res.error) setGeoMsg(res.error);
      else if (res.candidates.length === 0) setGeoMsg("候補が見つかりませんでした");
    } catch {
      setGeoMsg("場所の検索に失敗しました");
    } finally {
      setGeoBusy(false);
    }
  };

  const inputCls =
    "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)] placeholder:text-[var(--dim)]";
  const labelCls = "block text-sm font-medium text-[var(--text)] mb-1";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          setNameError("スポット名を入力してください");
          return;
        }
        setNameError(null);
        onSubmit({
          name: name.trim(),
          note: note.trim() || null,
          url: url.trim() || null,
          address: address.trim() || null,
          category: category.trim() || null,
          tags: splitTags(tagsText),
          lat,
          lng,
        });
      }}
      className="space-y-3"
    >
      <div>
        <label htmlFor="spot-name" className={labelCls}>スポット名 *</label>
        <input id="spot-name" {...FIELDS.addSpot.name} className={inputCls} value={name} onChange={(e) => { setName(e.target.value); if (nameError) setNameError(null); }} placeholder="例: ○○食堂" />
        {nameError && <p className="mt-1 text-sm text-[var(--signal)]">{nameError}</p>}
      </div>
      <div>
        <label htmlFor="spot-category" className={labelCls}>リスト *</label>
        <input id="spot-category" {...FIELDS.addSpot.category} className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="行ってみたい" list="spot-list-names" />
        <datalist id="spot-list-names">
          {listNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <p className="mt-1 text-xs text-[var(--dim)]">既存のリスト名を選ぶか、新しい名前をそのまま入力できます</p>
      </div>
      <div>
        <label htmlFor="spot-tags" className={labelCls}>タグ</label>
        <input id="spot-tags" className={inputCls} value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="例: 🦝 ぽこピー, ランチ" />
        <p className="mt-1 text-xs text-[var(--dim)]">複数ある場合はカンマ区切り。タグで絞り込み・検索できます（近接通知の呼びかけには使われません）</p>
      </div>
      <div>
        <label htmlFor="spot-note" className={labelCls}>メモ</label>
        <textarea id="spot-note" {...FIELDS.addSpot.note} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 友達のおすすめ、ランチが安い" rows={3} />
        <p className="mt-1 text-xs text-[var(--dim)]">近くのスポットとしてお知らせするとき、このメモがチャットで引用されます</p>
      </div>
      <div>
        <label htmlFor="spot-address" className={labelCls}>住所</label>
        <input id="spot-address" {...FIELDS.addSpot.address} className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="例: 東京都…" />
      </div>
      <div>
        <label htmlFor="spot-url" className={labelCls}>Googleマップ等のURL</label>
        <input id="spot-url" {...FIELDS.addSpot.url} className={inputCls} value={url} onChange={(e) => {
          setUrl(e.target.value);
          const c = extractCoordsFromUrl(e.target.value);
          if (c && lat === null) { setLat(c.lat); setLng(c.lng); }
        }} placeholder="https://maps.app.goo.gl/…" inputMode="url" />
      </div>
      <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] p-3">
        <p className="text-sm text-[var(--text)]">
          座標:{" "}
          {lat !== null && lng !== null ? (
            <span className="font-medium">{lat.toFixed(5)}, {lng.toFixed(5)}</span>
          ) : (
            <span className="text-[var(--dim)]">未設定（近接通知の対象外）</span>
          )}
          {lat !== null && (
            <button type="button" className="ml-2 text-sm text-[var(--signal)] underline" onClick={() => { setLat(null); setLng(null); }}>
              座標を消す
            </button>
          )}
        </p>
        <div className="mt-2 flex gap-2">
          <input
            aria-label="座標検索ワード"
            {...FIELDS.geocode.query}
            /* The box lives inside the spot form: the spread's
               required would block saving a spot until a geocode
               query is typed, so it is explicitly overridden off —
               the schema's maxLength still applies. */
            required={false}
            className={inputCls + " min-w-0 flex-1"}
            value={geoQuery}
            onChange={(e) => setGeoQuery(e.target.value)}
            placeholder="地名・店名で座標を検索"
          />
          <button type="button" onClick={runGeocode} disabled={geoBusy} className="shrink-0 rounded-[var(--radius)] bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-50">
            {geoBusy ? "検索中…" : "座標を探す"}
          </button>
        </div>
        {geoMsg && <p className="mt-2 text-sm text-[var(--signal)]">{geoMsg}</p>}
        {candidates.length > 0 && (
          <ul className="mt-2 space-y-1">
            {candidates.map((cand, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="w-full rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-sm text-[var(--text)]"
                  onClick={() => {
                    setLat(cand.lat);
                    setLng(cand.lng);
                    if (!address) setAddress(cand.displayName);
                    setCandidates([]);
                  }}
                >
                  <span className="font-medium">{cand.name}</span>
                  <span className="block truncate text-xs text-[var(--dim)]">{cand.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-[var(--dim)]">座標データ © OpenStreetMap contributors</p>
      </div>
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={busy || !name.trim()} className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] disabled:opacity-50">
          {busy ? "保存中…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5 text-[var(--text)]">
            キャンセル
          </button>
        )}
      </div>
    </form>
  );
}

/* ---------------- visited municipalities (市区町村・路線) ---------------- */

type VisitedMunicipality =
  ApiResponse<typeof api, "listVisitedMunicipalities">["municipalities"][number];

/* The municipality's real boundary for the fill: the geometry stored on
   the row when one was supplied at recording time, else the boundary
   data (simplified JapanCityGeoJson / 国土数値情報 N03 shapes for all
   47 prefectures, fetched per prefecture — see boundary-data.ts).
   Null when neither exists (or that prefecture has not loaded yet) —
   the map then falls back to a circle at the representative point. */
function boundaryGeometryFor(m: VisitedMunicipality): GeoJsonGeometry | null {
  return m.geometry ?? getBoundaryGeometryByKey().get(`${m.prefecture}|${m.name}`) ?? null;
}

/* The municipality's representative point: the stored coordinates when
   the row has them, else the centroid of its known boundary's largest
   exterior ring. Rows recorded by the chat-side job before it supplied
   coordinates (the 2026-11-21 batch) have no stored point, but their
   boundary is in the boundary data — deriving the point here lets them
   join the map and the numbered ledger instead of showing a bare "・".
   Null only when neither coordinates nor any boundary are known.

   The derivation walks the boundary's rings, and the focus paths
   ask for the point on every tap (subtask 1584/1586), so a derived
   point is cached per row object. Only non-null results are
   cached: a null can mean the row's prefecture has not loaded
   yet, and that answer must stay retryable — once the boundary
   lands, the same row derives its point. A cached point is
   stable because it comes from the row's own coordinates or from
   an immutable boundary geometry. */
const representativePointCache = new WeakMap<
  VisitedMunicipality,
  { lat: number; lng: number }
>();

function representativePoint(
  m: VisitedMunicipality,
): { lat: number; lng: number } | null {
  const cached = representativePointCache.get(m);
  if (cached) return cached;
  const point = computeRepresentativePoint(m);
  if (point) representativePointCache.set(m, point);
  return point;
}

function computeRepresentativePoint(
  m: VisitedMunicipality,
): { lat: number; lng: number } | null {
  if (m.lat !== null && m.lng !== null) return { lat: m.lat, lng: m.lng };
  const geometry = boundaryGeometryFor(m);
  if (!geometry) return null;
  const polygons: number[][][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let bestRing: number[][] | null = null;
  let bestSpan = -1;
  for (const polygon of polygons) {
    const ring = polygon[0];
    if (!ring || ring.length === 0) continue;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const pos of ring) {
      const lng = pos[0];
      const lat = pos[1];
      if (lng === undefined || lat === undefined) continue;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const span = (maxLng - minLng) * (maxLat - minLat);
    if (span > bestSpan) {
      bestSpan = span;
      bestRing = ring;
    }
  }
  if (!bestRing || bestRing.length === 0) return null;
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const pos of bestRing) {
    const lng = pos[0];
    const lat = pos[1];
    if (lng === undefined || lat === undefined) continue;
    sumLng += lng;
    sumLat += lat;
    count++;
  }
  if (count === 0) return null;
  return { lat: sumLat / count, lng: sumLng / count };
}

/* Designated cities （政令指定都市）, by name — all twenty. In the
   collection a designated city counts as ONE municipality: its wards
   are not ledger entries and are never counted or named separately.
   But the boundary geometry still carries the old ward polygons as
   separate MultiPolygon parts (the merge kept the parts; 千葉市 has
   8, さいたま市 11 — the wards plus harbor / enclave splits), and the
   map strokes those part outlines as thin light lines so the ward
   divisions stay visible as information (the designated-city-wards
   overlay in VisitedMapSection). Tokyo's special wards are NOT in
   this list: there each ward is itself a municipality. Non-designated
   cities can also have multi-part geometries （船橋市 has 6 parts —
   islands and enclaves), so the parts of a city are only read as
   wards when its name is in this set. */
const DESIGNATED_CITY_NAMES: ReadonlySet<string> = new Set([
  "札幌市",
  "仙台市",
  "さいたま市",
  "千葉市",
  "横浜市",
  "川崎市",
  "相模原市",
  "新潟市",
  "静岡市",
  "浜松市",
  "名古屋市",
  "京都市",
  "大阪市",
  "堺市",
  "神戸市",
  "岡山市",
  "広島市",
  "北九州市",
  "福岡市",
  "熊本市",
]);

/* Ward-line geometry for a designated city: ALWAYS the boundary
   data, keyed 「都道府県|市名」, never the ledger row's geometry.
   A ledger row may carry the whole city merged into a single
   Polygon (its parts collapsed), which has no ward divisions left
   to stroke — boundaryGeometryFor prefers that stored geometry, so
   sourcing the ward lines from it would erase the ward outlines
   the moment the city is visited. The boundary data keeps the old
   ward polygons as separate parts, so both the mount-time ward
   overlays and the focus ward lines read from it alone. Null for
   non-designated cities and for designated cities the data does
   not cover (or whose prefecture has not loaded yet) — those
   simply draw no ward lines. The whole-city fill
   and the focus highlight are unaffected: they keep using
   boundaryGeometryFor / the tapped geometry as before. */
function wardGeometryFor(prefecture: string, name: string): GeoJsonGeometry | null {
  if (!DESIGNATED_CITY_NAMES.has(name)) return null;
  return getBoundaryGeometryByKey().get(`${prefecture}|${name}`) ?? null;
}

/* ---------------- ridden railway lines ---------------- */

/* Line name → asset key, for the normalization fallback below
   (built by line-resolution.ts; a name shared by two operators is
   ambiguous and left out). */
const LINE_KEY_BY_NAME: ReadonlyMap<string, string> =
  buildLineKeyByName(RIDDEN_LINE_GEOMETRIES);

/* The ride's recorded section, as one short line under the ledger
   name: the restored section for partial rides （区間：新宿→大崎）,
   全線乗車 for full rides, 区間不明 where the record pins down no
   section. The state comes from the row (ridden_lines.ride_state);
   formal line names stay out of the display — the list shows service
   names and station names only. */
function riddenLineRideLabel(line: RiddenLine): string | null {
  if (line.rideState === "partial") {
    if (line.fromStationName && line.toStationName) {
      return `区間：${line.fromStationName}→${line.toStationName}`;
    }
    /* A partial row with no primary section can still pin down
       sections added by hand (stage 3, subtask 1455): show the
       first one instead of claiming no section is recorded. */
    const added = line.sections ?? [];
    if (added.length > 0) {
      const first = added[0]!;
      const label = `区間：${first.fromStationName ?? first.fromStationId}→${first.toStationName ?? first.toStationId}`;
      return added.length > 1
        ? `${label} ほか${added.length - 1}区間`
        : label;
    }
    return "区間指定（区間の記録なし）";
  }
  if (line.rideState === "full") return "全線乗車";
  if (line.rideState === "unknown") return "区間不明";
  return null;
}

/* ---------------- conquest charts （制覇グラフ) ---------------- */

/* Per-prefecture municipality totals, from the boundary data's
   manifest (the municipalities the fill map can paint: all 47
   prefectures). This is the denominator for the per-prefecture
   progress bars — a prefecture the data does not cover has no
   honest denominator here, so it is left out of that chart and
   named in a note instead. The map is the boundary store's own
   (see boundary-data.ts): empty until the manifest lands, then
   filled in place, and components re-read it on every render the
   boundary version counter drives. */
const PREFECTURE_MUNICIPALITY_TOTALS: ReadonlyMap<string, number> =
  getPrefectureMunicipalityTotals();

/* Per-operator line totals across all of Japan, counted from the
   bundled line asset (the same 597 lines behind JAPAN_LINE_TOTAL).
   The denominator for the per-operator progress bars. */
const LINE_OPERATOR_TOTALS: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const entry of Object.values(RIDDEN_LINE_GEOMETRIES)) {
    map.set(entry.operator, (map.get(entry.operator) ?? 0) + 1);
  }
  return map;
})();

/* Chart series colors: fixed hues that stay readable on both the
   light and dark page surfaces (the theme tokens themselves cannot
   be used as SVG fill attributes). The muted remainder slice is the
   same gray-green at low opacity on both. */
const CHART_MUNICIPALITY_COLOR = "#16a34a";
const CHART_LINE_COLOR = "#ea580c";
const CHART_REST_COLOR = "#7d8f83";

/* Tooltip chrome follows the page theme via inline style (CSS
   variables are valid there, unlike in SVG attributes). */
const CHART_TOOLTIP_STYLE = {
  backgroundColor: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
} as const;

type ProgressRow = { name: string; done: number; total: number; rest: number };

/* One overall-progress donut: achieved slice vs. the remainder, with
   the percent and the raw count in the hole. Fixed 150px size — no
   responsive container needed for a square this small. */
function ProgressDonut({
  title,
  value,
  total,
  pctText,
  color,
  doneLabel,
  unit,
}: {
  title: string;
  value: number;
  total: number;
  pctText: string;
  color: string;
  doneLabel: string;
  /* Appended to both numbers in the hole (the 路線 donut passes
     "km": 123.4km / 26,903.9km). Values keep one decimal at most,
     so a distance never shows a spurious long fraction. */
  unit?: string;
}) {
  const fmt = (n: number) =>
    n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const data = [
    { name: doneLabel, value },
    { name: "残り", value: Math.max(0, total - value) },
  ];
  return (
    <figure className="min-w-[140px] flex-1" aria-label={`${title}の制覇率 ${pctText}%（${fmt(value)}${unit ?? ""} / ${fmt(total)}${unit ?? ""}）`}>
      <figcaption className="text-center text-sm font-medium">{title}</figcaption>
      <div className="relative mx-auto h-[150px] w-[150px]">
        <PieChart width={150} height={150} aria-hidden="true">
          <Pie
            data={data}
            dataKey="value"
            innerRadius={52}
            outerRadius={70}
            startAngle={90}
            endAngle={-270}
            strokeWidth={0}
            isAnimationActive={false}
          >
            <Cell fill={color} />
            <Cell fill={CHART_REST_COLOR} fillOpacity={0.3} />
          </Pie>
        </PieChart>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
          <span className="font-[family-name:var(--font-display)] text-2xl font-black leading-none">
            {pctText}
            <span className="text-sm font-bold">%</span>
          </span>
          <span className="mt-1 text-xs text-[var(--dim)]">
            {fmt(value)}
            {unit} / {fmt(total)}
            {unit}
          </span>
        </div>
      </div>
    </figure>
  );
}

/* Stacked horizontal progress bars: achieved + remainder = the whole
   total, one row per group, starting at zero. The axis tick carries
   the exact fraction （埼玉県 12/63) so the numbers survive without
   hovering; the tooltip adds the percent. */
function StackedProgressBars({
  rows,
  doneName,
  color,
  onSelect,
}: {
  rows: ProgressRow[];
  doneName: string;
  color: string;
  /* When given (the 事業者別（路線）chart), a tap on either stacked
     segment of a row reports that row's name — the bar itself is
     the jump control. The chart stays aria-hidden (its numbers are
     in the axis ticks and the caller's accessible button list), so
     this is the pointer path only. */
  onSelect?: (name: string) => void;
}) {
  const byName = new Map(rows.map((r) => [r.name, r]));
  /* The tick is two lines — the group name over its exact
     fraction — because the one-line label （東日本旅客鉄道
     155.5/6,960.6) outgrew the label column and recharts
     right-anchors ticks, so the name's head ran off the chart's
     left edge and was clipped on device (subtask 1576). Split
     in two, each line fits the column: names run to 8 full-width
     glyphs (≈88px at 11px) and fractions to ≈13 half-width
     glyphs (≈86px), so width 100 holds both and hands the bars
     more room than the old one-line width 124 did. */
  const renderTick = (props: {
    x?: number;
    y?: number;
    payload?: { value?: string };
  }) => {
    const name = String(props.payload?.value ?? "");
    const fraction = progressTickFraction(byName.get(name));
    const x = props.x ?? 0;
    const y = props.y ?? 0;
    return (
      <text x={x} y={y} textAnchor="end" fontSize={11} fill="currentColor">
        <tspan x={x} dy={fraction ? "-0.58em" : "0.35em"}>
          {name}
        </tspan>
        {fraction && (
          <tspan x={x} dy="1.2em">
            {fraction}
          </tspan>
        )}
      </text>
    );
  };
  return (
    <div className="text-[var(--dim)]" aria-hidden="true">
      <ResponsiveContainer width="100%" height={rows.length * 38 + 46}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal={false} stroke="currentColor" strokeOpacity={0.12} />
          <XAxis type="number" domain={[0, "dataMax"]} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: "currentColor", strokeOpacity: 0.25 }} tickFormatter={(value: number) => formatProgressValue(value)} />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            tick={renderTick}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            formatter={(value, name) => [formatProgressValue(Number(value)), name]}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="done" name={doneName} stackId="total" fill={color} barSize={16} isAnimationActive={false}>
            {onSelect &&
              rows.map((row) => (
                <Cell
                  key={row.name}
                  onClick={() => onSelect(row.name)}
                  style={{ cursor: "pointer" }}
                />
              ))}
          </Bar>
          <Bar dataKey="rest" name="残り" stackId="total" fill={CHART_REST_COLOR} fillOpacity={0.3} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
            {onSelect &&
              rows.map((row) => (
                <Cell
                  key={row.name}
                  onClick={() => onSelect(row.name)}
                  style={{ cursor: "pointer" }}
                />
              ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* The growth chart's cumulative series and its per-tab model
   live in ./conquest-timeline (subtask 1482): the month axis and
   the chart's visibility are decided by the selected tab's
   records alone. */

/* The 制覇グラフ block under the fill map: overall donuts for
   municipalities and lines, per-prefecture municipality bars,
   per-operator line bars (only operators with at least one ridden
   line), and the cumulative growth chart. Every number is computed
   here from the same ledger rows and bundled totals the map and the
   headline counts above it use. The block is split per tab
   (subtask 1482): the 市区町村 tab shows only the municipality
   family's stats, the 路線 tab only the line family's — the same
   graphs used to show on both tabs. The numbers themselves are
   unchanged; only which family renders is gated by `variant`. */
function ConquestCharts({
  variant,
  municipalities,
  prefectures,
  totalVisited,
  riddenLines,
  networkRiddenKm,
  completeServiceCount,
  unpreparedLines,
  operatorKm,
  municipalityProgressPct,
  lineProgressPct,
  onOperatorSelect,
}: {
  /* Which record tab shows this block (tab split, subtask 1482):
     "municipalities" renders the municipality donut, the
     per-prefecture bars and the municipality growth series;
     "lines" renders the line donut, the per-operator bars and
     the line growth series. */
  variant: "municipalities" | "lines";
  municipalities: VisitedMunicipality[];
  prefectures: { name: string; total: number }[];
  totalVisited: number;
  riddenLines: readonly RiddenLine[];
  /* The 路線 donut's numerator (stage 2): the deduped ridden
     distance in km, against every formal line in Japan
     (26,903.9 km). The same number the map paints, so the donut
     and the map always agree. */
  networkRiddenKm: number;
  /* Services ridden end to end, and N02 lines the master does
     not cover yet — the two notes under the donut. */
  completeServiceCount: number;
  unpreparedLines: number;
  /* Per-operator ridden distance (formal-line based, deduped —
     the parent bar, matching the painted total). */
  operatorKm: ReadonlyMap<string, number>;
  municipalityProgressPct: string;
  lineProgressPct: string;
  /* 事業者別（路線）bar tap (and its accessible button twin):
     jump the ridden-lines ledger to that operator's first row. */
  onOperatorSelect?: (operator: string) => void;
}) {
  const prefRows: ProgressRow[] = prefectures.flatMap((p) => {
    const total = PREFECTURE_MUNICIPALITY_TOTALS.get(p.name);
    if (!total) return [];
    return [{ name: p.name, done: p.total, total, rest: Math.max(0, total - p.total) }];
  });
  const uncoveredPrefectures = prefectures.filter(
    (p) => !PREFECTURE_MUNICIPALITY_TOTALS.has(p.name),
  );

  /* Per-operator bars are distances (stage 2): the parent is the
     formal-line-based deduped total, so a shared stretch ridden
     as two services counts once here — the same number the map
     paints. The denominator is the operator's whole network
     (every formal line, ridden or not). The per-system distance
     lives on each ledger row instead: a stretch ridden as 埼京線
     never credits another system. */
  const operatorRows: ProgressRow[] = [...operatorKm.entries()]
    .map(([name, done]) => {
      const total = OPERATOR_TOTAL_KM[name] ?? done;
      return { name, done, total, rest: Math.max(0, total - done) };
    })
    .sort(
      (a, b) =>
        b.done - a.done || b.total - a.total || a.name.localeCompare(b.name, "ja"),
    );

  /* The growth chart's month axis and visibility come from the
     selected tab's records alone (./conquest-timeline). */
  const timeline = conquestTimelineForVariant(
    variant,
    municipalities.map((m) => m.visitedOn),
    riddenLines
      .filter((line) => !resolveRiddenService(line).needsReview)
      .map((line) => line.firstRiddenOn),
  );

  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-3">
      <h3 className="font-[family-name:var(--font-display)] text-base font-bold">制覇グラフ</h3>

      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {variant === "municipalities" && (
          <ProgressDonut
            title="市区町村"
            value={totalVisited}
            total={JAPAN_MUNICIPALITY_TOTAL}
            pctText={municipalityProgressPct}
            color={CHART_MUNICIPALITY_COLOR}
            doneLabel="訪問済み"
          />
        )}
        {variant === "lines" && (
          <ProgressDonut
            title="路線"
            value={networkRiddenKm}
            total={JAPAN_LINE_TOTAL_KM}
            pctText={lineProgressPct}
            color={CHART_LINE_COLOR}
            doneLabel="乗車済み"
            unit="km"
          />
        )}
      </div>
      {variant === "lines" && (completeServiceCount > 0 || unpreparedLines > 0) && (
        <p className="mt-1 text-center text-xs text-[var(--dim)]">
          {completeServiceCount > 0 && `完乗 ${completeServiceCount}系統`}
          {completeServiceCount > 0 && unpreparedLines > 0 && " ・ "}
          {unpreparedLines > 0 && `未整備 ${unpreparedLines}線`}
        </p>
      )}

      {variant === "municipalities" && prefRows.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-medium">都道府県別（市区町村）</h4>
          <div className="mt-1">
            <StackedProgressBars rows={prefRows} doneName="訪問済み" color={CHART_MUNICIPALITY_COLOR} />
          </div>
          <p className="mt-1 text-xs text-[var(--dim)]">
            分母は地図で塗れる市区町村の収録数です（全国47都道府県分）
          </p>
          {uncoveredPrefectures.length > 0 && (
            <p className="mt-1 text-xs text-[var(--dim)]">
              地図データ未収録の県は分母がないため棒グラフには含めていません：
              {uncoveredPrefectures.map((p) => `${p.name} ${p.total}件`).join(" ・ ")}
            </p>
          )}
        </div>
      )}

      {variant === "lines" && (
      <div className="mt-4">
        <h4 className="text-sm font-medium">事業者別（路線）</h4>
        {operatorRows.length > 0 ? (
          <>
            <div className="mt-1">
              <StackedProgressBars
                rows={operatorRows}
                doneName="乗車済み"
                color={CHART_LINE_COLOR}
                onSelect={onOperatorSelect}
              />
            </div>
            {/* The chart above is aria-hidden and pointer-only, so
                the same jump lives here as real buttons: keyboard
                and screen-reader users get the identical target
                (the operator's first row in the 乗った路線 list). */}
            {onOperatorSelect && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {operatorRows.map((row) => (
                  <button
                    key={row.name}
                    type="button"
                    onClick={() => onOperatorSelect(row.name)}
                    aria-label={`${row.name}の乗った路線へ移動`}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium"
                  >
                    {row.name}{" "}
                    {row.done.toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}
                    km
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-[var(--dim)]">
              乗った路線がある事業者だけを表示しています（全{LINE_OPERATOR_TOTALS.size}事業者のうち{operatorRows.length}事業者）。
              距離は地図で塗られた区間の重複を除いた合計で、分母は各事業者の全路線の総延長です
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-[var(--dim)]">
            まだ路線の記録がありません。路線が記録されると、事業者ごとの進み具合がここに出ます。
          </p>
        )}
      </div>
      )}

      {timeline.visible && (
        <div className="mt-4">
          <h4 className="text-sm font-medium">これまでの伸び（月ごとの累計）</h4>
          <div className="mt-1 text-[var(--dim)]" aria-hidden="true">
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={timeline.rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="currentColor" strokeOpacity={0.12} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "currentColor", strokeOpacity: 0.25 }}
                  tickFormatter={(v: string) => v.replace("-", "/")}
                  minTickGap={24}
                />
                <YAxis width={30} allowDecimals={false} domain={[0, "dataMax"]} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(v) => String(v).replace("-", "/")}
                  formatter={(value, name) => [`${Number(value).toLocaleString()}件`, name]}
                />
                <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="stepAfter"
                  dataKey="count"
                  name={timeline.seriesName}
                  stroke={variant === "municipalities" ? CHART_MUNICIPALITY_COLOR : CHART_LINE_COLOR}
                  fill={variant === "municipalities" ? CHART_MUNICIPALITY_COLOR : CHART_LINE_COLOR}
                  fillOpacity={0.16}
                  strokeWidth={2}
                  dot={{ r: 2.5, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-xs text-[var(--dim)]">
            初めて訪れた日・初めて乗った日の記録から数えた累計です
          </p>
        </div>
      )}
    </div>
  );
}

/* The map runtime is bundled with the app (see the side-effect import at
   the top), so this just confirms it registered itself. Resolves false
   when it did not, so the caller falls back to the stored static map. */
function loadHatchMaps(): Promise<boolean> {
  const w = window as unknown as { HatchMaps?: unknown };
  return Promise.resolve(Boolean(w.HatchMaps));
}

/* How long a freshly mounted map gets to produce its basemap before
   the load is treated as stalled. A basemap load can STALL without
   ever erroring — on a flaky mobile connection (the reader was on a
   train, outdoors) the style request hangs: no load event, no error
   event, so the runtime's onFatalError never fires and the pane used
   to sit blank forever while the rest of the page worked. That was
   the "both maps won't load outside" report: at home on stable Wi-Fi
   the same load finishes in well under a second. The watchdog below
   closes the gap — if the basemap has not arrived within the timeout,
   the caller retries the mount on a backoff ladder and only then
   swaps in its fallback (the visited map's stored static image /
   the spot map's notice) with a reload button, instead of an empty
   box. And the fallback is not the end: while it is shown, recovery
   rounds keep retrying the live mount in the background (see
   useMapMountRecovery), so a page opened during one bad minute
   heals itself once the connection settles instead of staying on
   the static image until the reader notices and taps reload —
   that stuck-after-one-bad-minute state is exactly what the
   reader reported again after the one-retry fix. The budget was
   15 s at first; it is 30 s now, because on congested mobile data
   a cold load pays the worker probe, the style fetch, and the
   sprite/glyph chain through the page origin's proxy back to
   back, and a restarted attempt re-pays ALL of it — a budget the
   slow-but-alive load can never beat turns the retry ladder into
   a livelock that never lets the map finish, which matches the
   reader's "still the static image after waiting" report. */
const MAP_LOAD_TIMEOUT_MS = 30000;

/* Failure reasons carried from the failing signal to the fallback
   note, so the reader's next screenshot says WHY the map did not
   load instead of just that it did not. Until this round every
   signal was funnelled into a zero-argument fail callback and the
   runtime's fatal-error message — the one piece of evidence that
   separates "the connection dropped the style fetch" from "this
   WebView cannot run the map engine at all" — was discarded at
   the helper boundary, which is why two hardening rounds could
   not name the on-device cause. Codes the app itself mints: */
const MAP_FAIL_TIMEOUT = "timeout";
const MAP_FAIL_NO_RUNTIME = "no-runtime";
const MAP_FAIL_NO_HANDLE = "no-handle";

/* The reader-facing wording for a failure reason. Known codes get
   a plain explanation; the runtime's own message (a style-fetch
   failure, a React render error inside the map, …) is shown
   verbatim after a label — it is the diagnostic the fallback
   exists to surface, and translating it would lose information. */
function describeMapFailure(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (reason === MAP_FAIL_TIMEOUT) {
    return "時間内に地図データが届きませんでした（通信が混み合っている可能性があります）";
  }
  if (reason === MAP_FAIL_NO_RUNTIME) {
    return "地図エンジン本体を読み込めませんでした";
  }
  if (reason === MAP_FAIL_NO_HANDLE) {
    return "地図エンジンを起動できませんでした";
  }
  if (reason === "unsupported:webgl") {
    return "この端末・表示環境ではWebGLが使えないため、地図を表示できません";
  }
  if (
    reason === "unsupported:worker" ||
    reason === "This page does not allow the Web Worker the map needs"
  ) {
    return "この表示環境ではWeb Workerが使えないため、地図を表示できません";
  }
  if (reason.startsWith("unsupported:")) {
    return "この表示環境では地図エンジンが使えません";
  }
  return `読み込みエラー（${reason}）`;
}

/* Polls a mounted map until its BASEMAP has arrived, then calls
   onLoaded once; calls onTimeout once if that never happens within
   MAP_LOAD_TIMEOUT_MS (including when the underlying map never
   appears at all). Returns a stop function for the mount's teardown.

   "Arrived" is the map's own `load` event — the style has loaded and
   the first frame has rendered — or isStyleLoaded() as the backstop
   for a map whose load event fired before the watcher first saw it.
   The earlier version judged success by isStyleLoaded() alone, which
   in MapLibre stays false until every pending tile and source has
   settled too: on a slow connection the initial tile set (dozens of
   vector tiles for the fitted view) legitimately takes longer than
   the timeout, so healthy, still-loading maps were being torn down
   and replaced by the fallback. The basemap's arrival and the
   tiles'/overlays' completion are separate outcomes; only the
   basemap's is judged here. */
function watchBasemapLoad(
  getMap: () => MapLibreLike | null,
  onLoaded: () => void,
  onTimeout: () => void,
): () => void {
  let stopped = false;
  let loaded = false;
  let hookedMap: MapLibreLike | null = null;
  const startedAt = Date.now();
  const succeed = () => {
    if (stopped || loaded) return;
    loaded = true;
    window.clearInterval(timer);
    onLoaded();
  };
  const timer = window.setInterval(() => {
    if (stopped || loaded) return;
    let map: MapLibreLike | null = null;
    try {
      map = getMap();
    } catch {
      map = null;
    }
    if (map) {
      if (hookedMap !== map) {
        hookedMap = map;
        try {
          map.once("load", succeed);
        } catch {
          /* the isStyleLoaded poll below still applies */
        }
      }
      let styleLoaded = false;
      try {
        styleLoaded = map.isStyleLoaded();
      } catch {
        styleLoaded = false;
      }
      if (styleLoaded) {
        succeed();
        return;
      }
    }
    if (Date.now() - startedAt >= MAP_LOAD_TIMEOUT_MS) {
      stopped = true;
      window.clearInterval(timer);
      onTimeout();
    }
  }, 400);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/* Automatic-retry ladder for a failed map mount, in milliseconds
   between attempts: a pre-load failure is retried at +0.6 s, +2 s,
   and +5 s before the mount gives up and shows its fallback. The
   previous shape spent a single retry at +0.6 s — outdoors, a page
   opened while the phone's connection is still waking up (radio
   state change, a train entering a dead zone) burns both attempts
   inside the same bad minute, and the map was then dead for the
   whole session. The ladder stretches the same idea across ~8 s of
   worsening patience; a hung style request never recovers by
   waiting, only by starting over, so each rung is a fresh mount. */
const MAP_RETRY_DELAYS_MS = [600, 2000, 5000];

/* How often a map sitting on its fallback starts another background
   recovery round (a fresh retry ladder) on its own. Together with
   the `online` and visibility kicks in useMapMountRecovery, this is
   what makes the fallback temporary in practice: the connection
   coming back — not the reader finding the reload button — is what
   brings the live map back. */
const MAP_RECOVERY_INTERVAL_MS = 20000;

/* The shared failure path for one map mount, used by both live
   maps. The mount effect creates one control per run and wires:
   - markLoaded: the watchdog's onLoaded — the basemap arrived, so
     any later failure callback is ignored and the live map stays.
   - fail: the runtime's fatal-error callback AND the watchdog's
     timeout both land here. A pre-load failure destroys the mount
     (via destroyMount, where the component has teardown beyond the
     effect cleanup) and schedules the next ladder rung through
     remount; when the ladder is spent, giveUp shows the fallback.
   The retry budget (retryCountRef) lives in the component, so it
   persists across the effect re-runs the remounts cause; the
   manual reload button and the background recovery rounds reset
   it to zero for a fresh ladder. The ladder timer is guarded by
   isCancelled, so a timer left behind by an unmounted or
   superseded effect run simply never fires its remount. */
function createMapMountFailureControl(opts: {
  retryCountRef: { current: number };
  isCancelled: () => boolean;
  destroyMount: () => void;
  remount: () => void;
  giveUp: (reason?: string) => void;
}): { markLoaded: () => void; fail: (reason?: string) => void } {
  let failed = false;
  let loaded = false;
  let lastReason: string | undefined;
  return {
    markLoaded: () => {
      loaded = true;
    },
    fail: (reason?: string) => {
      if (opts.isCancelled() || failed) return;
      failed = true;
      /* The first effective failure's reason wins: it is the
         signal that actually killed this mount, and later calls
         (the helper's null-handle follow-up, a second error
         event) must not overwrite it. It reaches the reader only
         when the ladder is spent and the fallback shows. */
      if (reason !== undefined) lastReason = reason;
      /* A failure after the basemap arrived is almost always a
         single dropped tile/glyph request, which MapLibre recovers
         from on its own as the reader pans and zooms — the live
         map stays mounted and nothing is torn down. */
      if (loaded) return;
      opts.destroyMount();
      const delay = MAP_RETRY_DELAYS_MS[opts.retryCountRef.current];
      if (delay !== undefined) {
        opts.retryCountRef.current += 1;
        window.setTimeout(() => {
          if (!opts.isCancelled()) opts.remount();
        }, delay);
        return;
      }
      opts.giveUp(lastReason);
    },
  };
}

/* While a map is showing its fallback, keep offering it a way back:
   a recovery round (the component's recover callback — it resets
   the retry ladder and remounts) runs every
   MAP_RECOVERY_INTERVAL_MS, immediately when the browser reports
   the connection is back (`online`), and when the page becomes
   visible again (returning to the app is exactly when a settled
   connection should get its chance). The effect exists only while
   `failed` is true, so a live map is never disturbed, and a round
   in progress (failed back to false) cannot be overlapped by the
   interval. */
function useMapMountRecovery(failed: boolean, recover: () => void): void {
  const recoverRef = useRef(recover);
  recoverRef.current = recover;
  useEffect(() => {
    if (!failed) return;
    const kick = () => recoverRef.current();
    const id = window.setInterval(kick, MAP_RECOVERY_INTERVAL_MS);
    window.addEventListener("online", kick);
    const onVisibility = () => {
      if (document.visibilityState === "visible") kick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [failed]);
}

/* The markdown ledger: same shape as the chat-side seen_places.md, so the
   file the user downloads here can stand in for it anywhere. */
function buildLedgerMarkdown(
  municipalities: VisitedMunicipality[],
  prefectures: { name: string; total: number }[],
): string {
  const lines: string[] = [
    "# 市区町村・路線 台帳（通った市区町村）",
    "",
    `全${municipalities.length}市区町村：${prefectures.map((p) => `${p.name} ${p.total}`).join("・")}`,
    "",
    "| 日付 | 市区町村 | エリア名 | 行程 |",
    "|---|---|---|---|",
  ];
  for (const m of municipalities) {
    lines.push(
      `| ${m.visitedOn} | ${m.name}（${m.prefecture}） | ${m.area ?? ""} | ${m.context ?? ""} |`,
    );
  }
  lines.push("", "座標データ © OpenStreetMap contributors");
  return lines.join("\n") + "\n";
}

/* The camera target for one municipality: its real boundary's bounds
   when a shape is known, else a small box around the representative
   point (roughly the size of the fallback circle). */
function boundsForMunicipality(
  m: VisitedMunicipality,
): [[number, number], [number, number]] | null {
  const geometry = boundaryGeometryFor(m);
  if (geometry) {
    const b = geometryBounds(geometry);
    if (b) return b;
  }
  if (m.lat === null || m.lng === null) return null;
  return [
    [m.lng - 0.04, m.lat - 0.03],
    [m.lng + 0.04, m.lat + 0.03],
  ];
}

/* The municipality a point falls in, for the fill map's default
   framing (「今いる市区町村に自動で合わせる」): the ledger rows'
   shapes are tested first (stored geometry wins over the boundary
   data inside boundaryGeometryFor), then every municipality in
   the boundary data loaded so far — visited or not, so a first
   visit to a home-prefecture municipality still frames correctly.
   Null when no known boundary contains the point (e.g. in a
   prefecture that has not loaded yet); the caller then frames a
   small box around the point itself. */
function findMunicipalityAt(
  lat: number,
  lng: number,
  ledger: VisitedMunicipality[],
): { name: string; prefecture: string; geometry: GeoJsonGeometry } | null {
  for (const m of ledger) {
    const geometry = boundaryGeometryFor(m);
    if (geometry && geometryContainsPoint(geometry, lng, lat)) {
      return { name: m.name, prefecture: m.prefecture, geometry };
    }
  }
  for (const [key, geometry] of getBoundaryGeometryByKey()) {
    if (!geometryContainsPoint(geometry, lng, lat)) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    return { name: key.slice(sep + 1), prefecture: key.slice(0, sep), geometry };
  }
  return null;
}

const FOCUS_POLYGON_SOURCE_ID = "visited-focus-polygon";
const FOCUS_POINT_SOURCE_ID = "visited-focus-point";
const FOCUS_WARDS_SOURCE_ID = "designated-city-focus-wards";
const FOCUS_OUTLINE_SOURCE_ID = "visited-focus-outline-lines";
const FOCUS_FILL_SOURCE_ID = "visited-focus-fill-only";
const EMPTY_FOCUS_DATA = { type: "FeatureCollection", features: [] };

/* Boundary segments of a designated city, classified by part
   sharing; internalWardLineFeatures (the ward lines) and
   outerBoundaryLineFeatures (the city's outer edge) split them.
   Stroking every part's full outline also re-strokes the
   segments where a ward polygon runs along the city's outer edge,
   and because the ward layers paint after the whole-city outlines,
   that thin light line overwrote the city boundary itself — the
   border against neighbouring municipalities read as thin as an
   internal ward line (user report, 2026-11-21). A segment shared by
   two or more DIFFERENT parts is an internal ward-to-ward border;
   a segment used by only one part is the city's outer edge and
   must stay with the normal municipality outline layers, so it is
   left out here. Sharing is defined by distinct parts, not by raw
   occurrence count: a ring that doubles back over its own edge
   (A → B → A) re-uses the segment within the same part and must
   NOT mark it internal (Codex review, 2026-11-22). Segment identity is direction-free (the same edge
   walked opposite ways by the two wards counts once) and each shared
   segment is emitted exactly once, as a LineString the existing thin
   ward-outline layers can stroke unchanged. Each segment
   also records the ring it was first walked in: the outer-boundary
   side chains its segments into continuous polylines per ring (see
   outerBoundaryLineFeatures), and the ring is the unit that keeps a
   hole's edge from ever being chained into the outer ring.

   Classification runs in two stages (collectBoundarySegments).
   Stage 1 is exact: before keying, every segment is split at the
   vertices of OTHER parts that lie on it, so a border one ward
   walks as A → C and the next as A → B → C keys identically on
   both sides (user report, 2026-11-22: unsplit, the A → C side
   matched nothing and was stroked as a thick outer fragment inside
   さいたま市）. Stage 2 exists because the boundary data simplified
   each ward ring independently (Douglas-Peucker, tolerance
   0.0005°): along a curvy border the two wards' copies of the same
   edge diverge by up to that tolerance and share neither endpoints
   nor intermediate vertices, so no exact key can ever match them —
   measured on the asset, stage 1 alone leaves 133 of さいたま市's
   outer segments with their midpoint on another ward's border.
   A segment stage 1 left unshared is therefore noded at its
   crossings with, and at the projections of, the other parts'
   geometry, and each piece whose midpoint lies within the same
   0.0005° of another part's border is classified shared; the other
   side's copy of the same border piece is emitted only once.
   Verified on the asset (2026-11-22): after both stages no outer
   segment of 千葉市 or さいたま市 has its midpoint on another
   part's border, and every part's border stays fully covered by
   the drawn lines. A city whose parts share nothing simply draws
   no ward lines rather than falling back to full outlines. */
type BoundarySegment = {
  partIndex: number;
  ringIndex: number;
  shared: boolean;
  from: number[];
  to: number[];
};

/* Stage 1 split tolerance, in degrees: a vertex of another part
   counts as lying ON a segment when it is this close to it. The
   asset stores coordinates rounded to 5 decimal places, so a
   vertex that was exactly on the segment before rounding can sit
   up to ~1.4e-5° off it; 2e-5° covers that rounding scale while
   staying far below the asset's simplification tolerance. */
const BOUNDARY_SPLIT_EPS = 2e-5;

/* Stage 2 pairing tolerance, in degrees: the asset's own
   Douglas-Peucker simplification tolerance (0.0005°, see the
   boundary asset's header). Two independently simplified copies
   of the same ward border diverge by at most this much; the next
   nearest distinct borders in the asset measure 6.5e-4° away or
   more, so the tolerance separates the two populations. */
const BOUNDARY_PAIR_TOL = 5e-4;

function boundaryPointKey(p: number[]): string {
  return `${p[0]},${p[1]}`;
}

/* Distance from p to segment a→b, with the projection parameter t
   (unclamped: t outside [0, 1] means the perpendicular foot falls
   beyond an endpoint). */
function boundaryDistToSegment(
  p: number[],
  a: number[],
  b: number[],
): { d: number; t: number } {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0 ? 0 : ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / len2;
  const tc = Math.max(0, Math.min(1, t));
  return {
    d: Math.hypot(p[0]! - (a[0]! + tc * dx), p[1]! - (a[1]! + tc * dy)),
    t,
  };
}

/* The parameter t at which segment a→b properly crosses segment
   c→d (both parameters strictly inside), or null. */
function boundaryCrossingT(
  a: number[],
  b: number[],
  c: number[],
  d: number[],
): number | null {
  const rx = b[0]! - a[0]!;
  const ry = b[1]! - a[1]!;
  const sx = d[0]! - c[0]!;
  const sy = d[1]! - c[1]!;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((c[0]! - a[0]!) * sy - (c[1]! - a[1]!) * sx) / denom;
  const u = ((c[0]! - a[0]!) * ry - (c[1]! - a[1]!) * rx) / denom;
  return t > 0 && t < 1 && u > 0 && u < 1 ? t : null;
}

type RawBoundarySegment = {
  partIndex: number;
  ringIndex: number;
  from: number[];
  to: number[];
};

/* The classification is recomputed from the same boundary geometry
   on every mount and focus change (the ward-line and the
   outer-boundary features each ask for it), so results are cached
   per geometry object; the returned segments are only ever read
   by the feature builders and the chaining walk. */
const boundarySegmentCache = new WeakMap<
  GeoJsonGeometry,
  BoundarySegment[]
>();

function collectBoundarySegments(
  geometry: GeoJsonGeometry,
): BoundarySegment[] {
  const cached = boundarySegmentCache.get(geometry);
  if (cached) return cached;
  const result = classifyBoundarySegments(geometry);
  boundarySegmentCache.set(geometry, result);
  return result;
}

function classifyBoundarySegments(
  geometry: GeoJsonGeometry,
): BoundarySegment[] {
  const parts =
    geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [geometry.coordinates];

  // Every part's raw segments, in walk order.
  const rawByPart: RawBoundarySegment[][] = parts.map((part, partIndex) => {
    const list: RawBoundarySegment[] = [];
    part.forEach((ring, ringIndex) => {
      for (let i = 0; i + 1 < ring.length; i += 1) {
        const a = ring[i]!;
        const b = ring[i + 1]!;
        if (a[0] === b[0] && a[1] === b[1]) continue;
        list.push({ partIndex, ringIndex, from: a, to: b });
      }
    });
    return list;
  });
  const allRaw = rawByPart.flat();

  // Spatial grids over the raw segments and the parts' vertices,
  // so the neighbourhood lookups below never scan a whole city.
  // Segment cells are BOUNDARY_PAIR_TOL wide and hold every segment
  // whose bounding box touches the cell; a point query reads the
  // 3×3 block around the point, which covers everything within
  // pairing distance of it.
  const cellOf = (v: number) => Math.floor(v / BOUNDARY_PAIR_TOL);
  const segmentGrid = new Map<string, RawBoundarySegment[]>();
  for (const raw of allRaw) {
    const minCx = cellOf(Math.min(raw.from[0]!, raw.to[0]!));
    const maxCx = cellOf(Math.max(raw.from[0]!, raw.to[0]!));
    const minCy = cellOf(Math.min(raw.from[1]!, raw.to[1]!));
    const maxCy = cellOf(Math.max(raw.from[1]!, raw.to[1]!));
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const key = `${cx},${cy}`;
        const list = segmentGrid.get(key);
        if (list) list.push(raw);
        else segmentGrid.set(key, [raw]);
      }
    }
  }
  const segmentsNearPoint = (
    p: number[],
    excludePart: number,
  ): RawBoundarySegment[] => {
    const out = new Set<RawBoundarySegment>();
    const cx = cellOf(p[0]!);
    const cy = cellOf(p[1]!);
    for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
      for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
        for (const raw of segmentGrid.get(`${ix},${iy}`) ?? []) {
          if (raw.partIndex !== excludePart) out.add(raw);
        }
      }
    }
    return [...out];
  };
  const segmentsNearSegment = (
    a: number[],
    b: number[],
    excludePart: number,
  ): RawBoundarySegment[] => {
    const out = new Set<RawBoundarySegment>();
    const minCx = cellOf(Math.min(a[0]!, b[0]!) - BOUNDARY_PAIR_TOL);
    const maxCx = cellOf(Math.max(a[0]!, b[0]!) + BOUNDARY_PAIR_TOL);
    const minCy = cellOf(Math.min(a[1]!, b[1]!) - BOUNDARY_PAIR_TOL);
    const maxCy = cellOf(Math.max(a[1]!, b[1]!) + BOUNDARY_PAIR_TOL);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        for (const raw of segmentGrid.get(`${cx},${cy}`) ?? []) {
          if (raw.partIndex !== excludePart) out.add(raw);
        }
      }
    }
    return [...out];
  };
  const distanceToOtherParts = (p: number[], partIndex: number): number => {
    let best = Infinity;
    for (const raw of segmentsNearPoint(p, partIndex)) {
      best = Math.min(best, boundaryDistToSegment(p, raw.from, raw.to).d);
    }
    return best;
  };
  // Vertex grid at a coarser cell: a vertex lying on a segment sits
  // inside the segment's bounding box, so the box's cells plus one
  // ring of neighbours hold every stage-1 split candidate.
  const vertexCellOf = (v: number) => Math.floor(v / 1e-3);
  const vertexGrid = new Map<string, { p: number[]; partIndex: number }[]>();
  parts.forEach((part, partIndex) => {
    const seen = new Set<string>();
    part.forEach((ring) => {
      ring.forEach((p) => {
        const key = boundaryPointKey(p);
        if (seen.has(key)) return;
        seen.add(key);
        const cellKey = `${vertexCellOf(p[0]!)},${vertexCellOf(p[1]!)}`;
        const list = vertexGrid.get(cellKey);
        const entry = { p, partIndex };
        if (list) list.push(entry);
        else vertexGrid.set(cellKey, [entry]);
      });
    });
  });
  const verticesNearSegment = (
    a: number[],
    b: number[],
    excludePart: number,
  ): number[][] => {
    const out: number[][] = [];
    const minCx = vertexCellOf(Math.min(a[0]!, b[0]!)) - 1;
    const maxCx = vertexCellOf(Math.max(a[0]!, b[0]!)) + 1;
    const minCy = vertexCellOf(Math.min(a[1]!, b[1]!)) - 1;
    const maxCy = vertexCellOf(Math.max(a[1]!, b[1]!)) + 1;
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        for (const v of vertexGrid.get(`${cx},${cy}`) ?? []) {
          if (v.partIndex !== excludePart) out.push(v.p);
        }
      }
    }
    return out;
  };

  // ---- Stage 1: split at other parts' vertices lying on the
  // segment (inserting the vertex itself, so the pieces key
  // exactly like the other side's own segments), then classify by
  // direction-free exact keys. Only a DIFFERENT part turns a
  // segment shared; a re-appearance inside the same part (a ring
  // doubling back on its own edge) does not.
  const exact = new Map<string, BoundarySegment>();
  const addExact = (
    partIndex: number,
    ringIndex: number,
    a: number[],
    b: number[],
  ) => {
    const aKey = boundaryPointKey(a);
    const bKey = boundaryPointKey(b);
    if (aKey === bKey) return;
    const forward = aKey < bKey;
    const key = forward ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    const existing = exact.get(key);
    if (existing) {
      if (existing.partIndex !== partIndex) existing.shared = true;
    } else {
      exact.set(key, {
        partIndex,
        ringIndex,
        shared: false,
        from: forward ? a : b,
        to: forward ? b : a,
      });
    }
  };
  for (const raw of allRaw) {
    const splits: { t: number; p: number[] }[] = [];
    for (const v of verticesNearSegment(raw.from, raw.to, raw.partIndex)) {
      if (
        boundaryPointKey(v) === boundaryPointKey(raw.from) ||
        boundaryPointKey(v) === boundaryPointKey(raw.to)
      ) {
        continue;
      }
      const { d, t } = boundaryDistToSegment(v, raw.from, raw.to);
      if (d <= BOUNDARY_SPLIT_EPS && t > 0 && t < 1) splits.push({ t, p: v });
    }
    splits.sort((x, y) => x.t - y.t);
    let prev = raw.from;
    for (const split of splits) {
      addExact(raw.partIndex, raw.ringIndex, prev, split.p);
      prev = split.p;
    }
    addExact(raw.partIndex, raw.ringIndex, prev, raw.to);
  }
  const stage1 = [...exact.values()];

  // ---- Stage 2: the segments stage 1 left unshared may still run
  // along another part's border — the two sides just kept different
  // vertices when the asset simplified them. Node each such
  // segment at its crossings with the other parts' segments and at
  // the projections of their endpoints (points ON the segment, so
  // its own geometry is unchanged), then classify each piece by
  // its midpoint: within pairing tolerance of another part's
  // border means the piece IS a ward border. A piece that
  // duplicates an already-emitted shared segment (the other side's
  // copy of the same border) is dropped, so every shared border is
  // still emitted exactly once.
  const result: BoundarySegment[] = [];
  const sharedMidGrid = new Map<string, BoundarySegment[]>();
  const midpointOf = (s: BoundarySegment): number[] => [
    (s.from[0]! + s.to[0]!) / 2,
    (s.from[1]! + s.to[1]!) / 2,
  ];
  const emitShared = (segment: BoundarySegment) => {
    result.push(segment);
    const mid = midpointOf(segment);
    const key = `${cellOf(mid[0]!)},${cellOf(mid[1]!)}`;
    const list = sharedMidGrid.get(key);
    if (list) list.push(segment);
    else sharedMidGrid.set(key, [segment]);
  };
  for (const segment of stage1) {
    if (segment.shared) emitShared(segment);
  }
  const duplicatesShared = (piece: BoundarySegment): boolean => {
    const mid = midpointOf(piece);
    const cx = cellOf(mid[0]!);
    const cy = cellOf(mid[1]!);
    for (let ix = cx - 1; ix <= cx + 1; ix += 1) {
      for (let iy = cy - 1; iy <= cy + 1; iy += 1) {
        for (const other of sharedMidGrid.get(`${ix},${iy}`) ?? []) {
          if (other.partIndex === piece.partIndex) continue;
          const otherMid = midpointOf(other);
          if (
            Math.hypot(otherMid[0]! - mid[0]!, otherMid[1]! - mid[1]!) >
            BOUNDARY_PAIR_TOL
          ) {
            continue;
          }
          if (
            boundaryDistToSegment(mid, other.from, other.to).d <=
              BOUNDARY_PAIR_TOL &&
            boundaryDistToSegment(otherMid, piece.from, piece.to).d <=
              BOUNDARY_PAIR_TOL
          ) {
            return true;
          }
        }
      }
    }
    return false;
  };
  for (const segment of stage1) {
    if (segment.shared) continue;
    const ts = new Set<number>([0, 1]);
    for (const raw of segmentsNearSegment(
      segment.from,
      segment.to,
      segment.partIndex,
    )) {
      const crossing = boundaryCrossingT(
        segment.from,
        segment.to,
        raw.from,
        raw.to,
      );
      if (crossing !== null) ts.add(crossing);
      for (const v of [raw.from, raw.to]) {
        const { d, t } = boundaryDistToSegment(v, segment.from, segment.to);
        if (d <= BOUNDARY_PAIR_TOL && t > 0 && t < 1) ts.add(t);
      }
    }
    const sorted = [...ts]
      .sort((x, y) => x - y)
      .filter((t, i, arr) => i === 0 || t - arr[i - 1]! > 1e-12);
    const points = sorted.map((t) =>
      t === 0
        ? segment.from
        : t === 1
          ? segment.to
          : [
              segment.from[0]! + t * (segment.to[0]! - segment.from[0]!),
              segment.from[1]! + t * (segment.to[1]! - segment.from[1]!),
            ],
    );
    for (let i = 0; i + 1 < points.length; i += 1) {
      const piece: BoundarySegment = {
        partIndex: segment.partIndex,
        ringIndex: segment.ringIndex,
        shared: false,
        from: points[i]!,
        to: points[i + 1]!,
      };
      if (
        distanceToOtherParts(midpointOf(piece), segment.partIndex) <=
        BOUNDARY_PAIR_TOL
      ) {
        piece.shared = true;
        if (!duplicatesShared(piece)) emitShared(piece);
      } else {
        result.push(piece);
      }
    }
  }
  return result;
}

/* Chains one ring's segments into continuous polylines:
   starting from any unused segment, keep appending an unused
   segment that touches the growing line's tail (then its head)
   until neither end can grow. Every segment is consumed exactly
   once, so the chained lines hold precisely the segments they were
   built from — none added, none dropped — and neighbouring
   vertices always meet at a shared endpoint. A ring whose outer
   segments form a full loop closes on itself: the walk returns to
   the first coordinate, so the line's first and last coordinates
   are identical. Where a ring's outer edge is interrupted (a
   stretch shared with another part), the chain simply ends there
   and the remaining segments start a new line. Used for BOTH the
   outer-boundary lines and (since the 2026-11-22 boundary
   hierarchy) the dashed internal ward lines, which need the same
   continuous polylines for their dash pattern to read as one
   broken line instead of restarting per segment. */
function chainOuterSegments(segments: BoundarySegment[]): number[][][] {
  const keyOf = (p: number[]) => `${p[0]},${p[1]}`;
  const incident = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const point of [segment.from, segment.to]) {
      const key = keyOf(point);
      const list = incident.get(key);
      if (list) list.push(index);
      else incident.set(key, [index]);
    }
  });
  const used = new Array<boolean>(segments.length).fill(false);
  const lines: number[][][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    used[start] = true;
    const first = segments[start]!;
    const line: number[][] = [first.from, first.to];
    const isClosed = () =>
      line.length > 2 && keyOf(line[0]!) === keyOf(line[line.length - 1]!);
    while (!isClosed()) {
      const tail = line[line.length - 1]!;
      const next = (incident.get(keyOf(tail)) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      const segment = segments[next]!;
      line.push(keyOf(segment.from) === keyOf(tail) ? segment.to : segment.from);
    }
    while (!isClosed()) {
      const head = line[0]!;
      const next = (incident.get(keyOf(head)) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      const segment = segments[next]!;
      line.unshift(
        keyOf(segment.from) === keyOf(head) ? segment.to : segment.from,
      );
    }
    lines.push(line);
  }
  return lines;
}

/* Internal ward borders only: the segments two or more different
   parts share (see the segment comment above). Like the outer
   boundary below, the segments are CHAINED into continuous
   polylines per part and ring before they are emitted: the ward
   layers stroke them DASHED (boundary hierarchy, 2026-11-22), and
   a dash pattern restarts at every feature, so one LineString per
   segment would read as a near-solid line of tiny dashes. The
   chaining consumes exactly the shared segments — none added,
   none dropped — grouped per part and ring for the same reason
   as the outer lines (a hole's edge never chains into an outer
   ring). */
function internalWardLineFeatures(geometry: GeoJsonGeometry, name: string) {
  const groups = new Map<string, BoundarySegment[]>();
  for (const segment of collectBoundarySegments(geometry)) {
    if (!segment.shared) continue;
    const key = `${segment.partIndex}|${segment.ringIndex}`;
    const group = groups.get(key);
    if (group) group.push(segment);
    else groups.set(key, [segment]);
  }
  const features: {
    type: string;
    properties: { name: string };
    geometry: { type: string; coordinates: number[][] };
  }[] = [];
  for (const group of groups.values()) {
    for (const coordinates of chainOuterSegments(group)) {
      features.push({
        type: "Feature",
        properties: { name },
        geometry: { type: "LineString", coordinates },
      });
    }
  }
  return features;
}

/* The complement of internalWardLineFeatures: the segments no other
   part shares — the designated city's OUTER boundary. The normal
   municipality outline layers stroke every part's full outline, so
   on a designated city the ward-to-ward borders would ALSO receive
   the thick dark stroke, and the thin light ward lines painted over
   them cannot cover the width difference — dark lines stayed
   visible inside the city (user report, 2026-11-22). Designated
   cities are therefore excluded from those polygon outline layers
   and stroked with these outer segments instead, in the same paint.
   The two sets partition the geometry's border pieces (stage 2 of
   the classification may node a segment into pieces along the
   other parts' geometry): every piece is drawn exactly once,
   either as a thin ward line or as part of the outer boundary —
   no overlap, no gap.
   Unlike the ward lines, the outer segments are NOT emitted one
   LineString per segment: stroked that way, MapLibre's line-join
   never applies between separate features and the default butt
   line-cap leaves a notch on the outside of every bend, so the
   outline — above all the thick focus outline — could read as
   broken at the vertices (Codex review, 2026-11-22). Instead the
   segments are chained into continuous polylines (chainOuterSegments),
   grouped per part AND per ring so segments from different parts,
   or from a hole's ring, are never chained into the outer ring.
   The layers stroking these lines also set round line-join /
   line-cap, so even a chain end that could not be joined stays
   gap-free. */
function outerBoundaryLineFeatures(geometry: GeoJsonGeometry, name: string) {
  const groups = new Map<string, BoundarySegment[]>();
  for (const segment of collectBoundarySegments(geometry)) {
    if (segment.shared) continue;
    const key = `${segment.partIndex}|${segment.ringIndex}`;
    const group = groups.get(key);
    if (group) group.push(segment);
    else groups.set(key, [segment]);
  }
  const features: {
    type: string;
    properties: { name: string };
    geometry: { type: string; coordinates: number[][] };
  }[] = [];
  for (const group of groups.values()) {
    for (const coordinates of chainOuterSegments(group)) {
      features.push({
        type: "Feature",
        properties: { name },
        geometry: { type: "LineString", coordinates },
      });
    }
  }
  return features;
}

/* Adds the focus highlight layers (orange fill + thick outline for
   polygons, a ring for point-only municipalities) to the live map,
   once. Safe to call repeatedly and before the style has loaded.
   The polygon and point cases draw from SEPARATE sources on purpose:
   the first build shared one source and kept the layers apart with
   geometry-type filters, but on the real device the circle layer still
   painted a circle at every vertex of the polygon (千葉市・鎌ケ谷市
   turned into a solid blob of overlapping orange circles) — the filter
   did not hold there. With split sources the separation is structural:
   the circle layer's source only ever contains a Point feature, and
   the fill / outline layers' source only ever contains a Polygon /
   MultiPolygon, so no filter behaviour is involved at all. */

/* ---------------- nationwide boundary overlays ---------------- */

/* Designated-city geometries from the boundary data, keyed
   「都道府県|市名」: the ward-line overlays and the outer-boundary
   outlines (unvisited / visited / focus) all read the ward parts
   from here, never from a ledger row. Only prefectures loaded so
   far contribute — the set grows as background loads land. */
function designatedBoundaryGeometries(): Map<string, GeoJsonGeometry> {
  const map = new Map<string, GeoJsonGeometry>();
  for (const [key, geometry] of getBoundaryGeometryByKey()) {
    if (!geometry) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    if (DESIGNATED_CITY_NAMES.has(key.slice(sep + 1))) {
      map.set(key, geometry);
    }
  }
  return map;
}

type UnvisitedAreaFeature =
  | ReturnType<typeof outerBoundaryLineFeatures>[number]
  | { type: string; properties: { name: string }; geometry: GeoJsonGeometry };

/* Unvisited boundaries, line-only: every municipality in the
   boundary data loaded so far that is NOT in the ledger. Shared by
   the map mount and by refreshNationwideBoundarySources below, so
   a prefecture that arrives in the background paints exactly what
   a fresh mount would have painted. A name ending in 「区」 is
   drawn only when it is a Tokyo special ward; a designated city
   contributes only its outer-boundary segments. */
function buildUnvisitedAreaFeatures(
  visitedKeys: ReadonlySet<string>,
): UnvisitedAreaFeature[] {
  const features: UnvisitedAreaFeature[] = [];
  for (const [key, geometry] of getBoundaryGeometryByKey()) {
    if (!geometry || visitedKeys.has(key)) continue;
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const prefecture = key.slice(0, sep);
    const name = key.slice(sep + 1);
    if (name.endsWith("区") && prefecture !== "東京都") continue;
    const label = `${prefecture} ${name}`;
    if (DESIGNATED_CITY_NAMES.has(name)) {
      features.push(...outerBoundaryLineFeatures(geometry, label));
    } else {
      features.push({
        type: "Feature",
        properties: { name: label },
        geometry,
      });
    }
  }
  return features;
}

/* Ward-line features of every designated city in the loaded data,
   split by whether the city is in the ledger. Same sharing rule as
   buildUnvisitedAreaFeatures: mount and background refresh build
   from this one function. */
function buildWardLineFeatures(visitedKeys: ReadonlySet<string>): {
  visited: ReturnType<typeof internalWardLineFeatures>;
  unvisited: ReturnType<typeof internalWardLineFeatures>;
} {
  const visited: ReturnType<typeof internalWardLineFeatures> = [];
  const unvisited: ReturnType<typeof internalWardLineFeatures> = [];
  for (const [key, geometry] of designatedBoundaryGeometries()) {
    const features = internalWardLineFeatures(geometry, key.replace("|", " "));
    if (visitedKeys.has(key)) {
      visited.push(...features);
    } else {
      unvisited.push(...features);
    }
  }
  return { visited, unvisited };
}

/* Layer specs for the two overlays whose data grows after the
   mount (unvisited municipality outlines, unvisited designated
   cities' ward lines). The mount passes them to the map runtime;
   refreshNationwideBoundarySources reuses them when it has to add
   a source the mount could not create yet (its data was empty at
   mount time). Paint comments live with the mount's overlay code. */
const UNVISITED_AREAS_LAYER = {
  id: "unvisited-areas-outline",
  type: "line",
  source: "unvisited-areas",
  layout: { "line-cap": "round", "line-join": "round" },
  minzoom: 7.5,
  paint: {
    "line-color": "#64748b",
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 7.5, 0.35, 9, 0.55, 10, 0.8],
    "line-width": ["interpolate", ["linear"], ["zoom"], 7.5, 0.7, 9, 1, 10, 1.4],
  },
} as const;

const DESIGNATED_WARDS_UNVISITED_LAYER = {
  id: "designated-city-wards-unvisited-outline",
  type: "line",
  source: "designated-city-wards-unvisited",
  layout: { "line-join": "round" },
  paint: {
    "line-dasharray": [4, 3],
    "line-color": "#94a3b8",
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 9.5, 0, 10.5, 0.76],
    "line-width": 1.05,
  },
} as const;

/* Prefecture border layer spec — same sharing rule as the two
   specs above: the mount paints it from the overlay list, and
   refreshNationwideBoundarySources reuses it when it has to add
   the source late (the borders file failed at mount time and
   only arrived on a retry). Paint values live with the mount's
   overlay code comment. */
const PREFECTURE_BORDERS_LAYER = {
  id: "prefecture-borders-line",
  type: "line",
  source: "prefecture-borders",
  layout: { "line-cap": "round", "line-join": "round" },
  paint: {
    "line-color": "#334155",
    "line-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0.65, 10, 0.85],
    "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.2, 7, 1.5, 9, 1.9, 10, 2.2],
  },
} as const;

/* Prefecture border features from the store's current lines —
   shared by the mount and by refreshNationwideBoundarySources,
   so borders that only arrive on a retry paint exactly what a
   fresh mount would have painted. */
function buildPrefectureBorderFeatures() {
  return getPrefectureBorderLines().map((coordinates) => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates },
  }));
}

/* After the mount, background prefecture loads grow three of the
   map's sources: the unvisited municipality outlines, the
   unvisited designated cities' ward lines, and the prefecture
   borders (whose file belongs to the priority set, so it is only
   ever missing when it failed at mount time and lands on a
   retry). This pushes the rebuilt data into the live map (adding
   a source + layer first when the mount had no data for it yet),
   keeping the boundary paint order by inserting late layers
   below the first overlay layer that already sits above them.
   Called on every boundary version bump; a no-op until the map
   exists and for sources whose data the new loads did not change
   in kind. */
function refreshNationwideBoundarySources(
  map: MapLibreLike,
  municipalities: readonly VisitedMunicipality[],
): void {
  const visitedKeys = new Set(
    municipalities.map((m) => `${m.prefecture}|${m.name}`),
  );
  const jobs: {
    sourceId: string;
    layer:
      | typeof UNVISITED_AREAS_LAYER
      | typeof DESIGNATED_WARDS_UNVISITED_LAYER
      | typeof PREFECTURE_BORDERS_LAYER;
    features: unknown[];
    aboveLayerIds: string[];
  }[] = [
    {
      sourceId: "unvisited-areas",
      layer: UNVISITED_AREAS_LAYER,
      features: buildUnvisitedAreaFeatures(visitedKeys),
      aboveLayerIds: ["visited-areas-outline", "prefecture-borders-line", "visited-lines-casing"],
    },
    {
      sourceId: "designated-city-wards-unvisited",
      layer: DESIGNATED_WARDS_UNVISITED_LAYER,
      features: buildWardLineFeatures(visitedKeys).unvisited,
      aboveLayerIds: ["unvisited-areas-outline", "visited-areas-outline", "prefecture-borders-line", "visited-lines-casing"],
    },
    {
      sourceId: "prefecture-borders",
      layer: PREFECTURE_BORDERS_LAYER,
      features: buildPrefectureBorderFeatures(),
      /* Above the borders sit only the ridden lines and the
         focus layers; anchor below whichever of those exists. */
      aboveLayerIds: ["visited-lines-casing", "visited-focus-fill"],
    },
  ];
  for (const job of jobs) {
    const data = { type: "FeatureCollection", features: job.features };
    const source = map.getSource(job.sourceId);
    if (source) {
      source.setData(data);
      continue;
    }
    if (job.features.length === 0) continue;
    map.addSource(job.sourceId, { type: "geojson", data });
    const beforeId = job.aboveLayerIds.find((id) => map.getLayer(id));
    map.addLayer({ ...job.layer }, beforeId);
  }
}

/* ---------------- unvisited-spot ghost points ----------------
   The ghost of the スポット tab on the record map (tab split,
   subtask 1439): the not-yet-visited spots — that tab's hero
   data — drawn as small faint dots under everything else, so
   either record tab still shows where the reader wants to go.
   The points share the spot tab's own query (["spotPoints"]),
   so the fetch happens once for the whole page. The layer is
   display-only: it is never in any tap hit-test set. */

const GHOST_SPOTS_SOURCE_ID = "ghost-spots";
const GHOST_SPOTS_LAYER_ID = "ghost-spots-circle";

function ghostSpotFeatures(
  points: readonly SpotMapPoint[],
): {
  type: "Feature";
  properties: { id: number };
  geometry: { type: "Point"; coordinates: [number, number] };
}[] {
  return points
    .filter((p) => !p.visited)
    .map((p) => ({
      type: "Feature" as const,
      properties: { id: p.id },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] },
    }));
}

/* Adds the ghost-spot source + layer to a live map, or refreshes
   its data when they already exist. Inserted below every record
   overlay (the visited fills first, the ridden lines when no
   fills exist) so the dots stay a true underlay on both tabs;
   the focus layers added later still paint above them. */
function ensureGhostSpotPoints(
  map: MapLibreLike,
  features: ReturnType<typeof ghostSpotFeatures>,
): void {
  const data = { type: "FeatureCollection", features };
  const source = map.getSource(GHOST_SPOTS_SOURCE_ID);
  if (source) {
    source.setData(data);
    return;
  }
  map.addSource(GHOST_SPOTS_SOURCE_ID, { type: "geojson", data });
  const beforeId = [
    "visited-areas-fill",
    "visited-lines-casing",
    "visited-focus-fill",
  ].find((id) => map.getLayer(id));
  map.addLayer(
    {
      id: GHOST_SPOTS_LAYER_ID,
      type: "circle",
      source: GHOST_SPOTS_SOURCE_ID,
      /* The paint spec lives in map-variant.ts (GHOST_SPOT_PAINT):
         the spot tab's own dots are #ea580c at 0.6, and the ghost
         keeps the hue at about a quarter of the strength and
         size, so the underlay reads as a background (subtask
         1481 — the old 0.32 / 2.5–4.5 dots were too loud on the
         record tabs). */
      paint: GHOST_SPOT_PAINT,
    },
    beforeId,
  );
}

/* The 路線 tab's ghost features for one coverage — every
   formal line's unridden remainder, coarsened — are computed
   by computeUnriddenGhostFeatures in unridden-ghost.ts, inside
   the ghost's Web Worker (review round 3; the computation used
   to live here). */

function ensureFocusLayers(map: MapLibreLike) {
  if (!map.getSource(FOCUS_POLYGON_SOURCE_ID)) {
    map.addSource(FOCUS_POLYGON_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getSource(FOCUS_POINT_SOURCE_ID)) {
    map.addSource(FOCUS_POINT_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getSource(FOCUS_WARDS_SOURCE_ID)) {
    map.addSource(FOCUS_WARDS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getSource(FOCUS_OUTLINE_SOURCE_ID)) {
    map.addSource(FOCUS_OUTLINE_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getSource(FOCUS_FILL_SOURCE_ID)) {
    map.addSource(FOCUS_FILL_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getLayer("visited-focus-fill")) {
    map.addLayer({
      id: "visited-focus-fill",
      type: "fill",
      source: FOCUS_POLYGON_SOURCE_ID,
      paint: { "fill-color": "#ea580c", "fill-opacity": 0.45 },
    });
  }
  if (!map.getLayer("visited-focus-outline")) {
    map.addLayer({
      id: "visited-focus-outline",
      type: "line",
      source: FOCUS_POLYGON_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        /* Boundary hierarchy (2026-11-22): the selected
           municipality's outer boundary is #ea580c at width 2.0 /
           opacity 0.95 — the widest line on the map, above even
           the prefecture borders it may run along. */
        "line-color": "#ea580c",
        "line-opacity": 0.95,
        "line-width": 2,
      },
    });
  }
  /* A focused designated city is filled from a SEPARATE source:
     the polygon source above feeds both the fill and the outline
     layers, and its outline strokes every ward part — thick orange
     lines along the internal ward borders too. So for a designated
     city setFocusPolygon leaves the polygon source empty, puts the
     whole-city geometry here (fill only, same paint as
     visited-focus-fill) and the outer segments in the outline-lines
     source below; the structural split, not a layer filter, decides
     which strokes the city gets. Any other focus leaves both extra
     sources empty. */
  if (!map.getLayer("visited-focus-fill-only")) {
    map.addLayer({
      id: "visited-focus-fill-only",
      type: "fill",
      source: FOCUS_FILL_SOURCE_ID,
      paint: { "fill-color": "#ea580c", "fill-opacity": 0.45 },
    });
  }
  /* Outer boundary of a focused designated city, in the same paint
     as the focus outline. Added before the wards layer below so
     the deep-orange ward lines still paint above it. */
  if (!map.getLayer("visited-focus-outer-outline")) {
    map.addLayer({
      id: "visited-focus-outer-outline",
      type: "line",
      source: FOCUS_OUTLINE_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ea580c",
        "line-opacity": 0.95,
        "line-width": 2,
      },
    });
  }
  if (!map.getLayer("visited-focus-circle")) {
    map.addLayer({
      id: "visited-focus-circle",
      type: "circle",
      source: FOCUS_POINT_SOURCE_ID,
      paint: {
        "circle-radius": 36,
        "circle-color": "#ea580c",
        "circle-opacity": 0.3,
        "circle-stroke-width": 3,
        "circle-stroke-color": "#ea580c",
        "circle-stroke-opacity": 0.9,
      },
    });
  }
  /* Ward lines of the focused designated city, in a deepened
     version of the focus orange (#ea580c → #c2410c): added last so
     they paint above the focus fill and outline. Boundary
     hierarchy (2026-11-22): like every ward line they are now
     DASHED [4, 3] over the chained polylines
     internalWardLineFeatures emits — width 1.15, and the opacity
     ramps in with zoom (0 at zoom 9, the full 0.85 at zoom 10),
     so a selected city at wide zoom shows its outer boundary
     alone. (They began as a pale solid tint, #fdba74 at 0.85 /
     width 1.1, then a solid 1.25 / 0.95 that read as strongly as
     the outer outline; the dash is what now separates them from
     it.) Kept in their own source for the same structural reason
     as the split above — the fill source only ever holds the
     whole-city geometry, this one only ever holds internal
     ward-border lines. */
  if (!map.getLayer("designated-city-focus-wards-outline")) {
    map.addLayer({
      id: "designated-city-focus-wards-outline",
      type: "line",
      source: FOCUS_WARDS_SOURCE_ID,
      layout: { "line-join": "round" },
      paint: {
        "line-dasharray": [4, 3],
        "line-color": "#c2410c",
        "line-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          9,
          0,
          10,
          0.85,
        ],
        "line-width": 1.15,
      },
    });
  }
}

/* Focus fill switching (boundary hierarchy / exclave fix,
   2026-11-22): while a municipality is focused, its NORMAL fill
   is filtered out of the visited fill layers and the orange
   focus fill replaces it, so the two translucent fills never
   stack into a darker patch — the same double-paint the exclave
   geometries caused, in selection form. The tap hit test does
   NOT use these visual layers: the mount adds separate
   opacity-0 hit layers (visited-areas-hit / visited-fill-hit)
   over the same sources, which are never filtered, so the
   focused municipality stays tappable. `name` is the feature
   label (`${prefecture} ${name}`); null restores every fill. */
function setNormalFillExclusion(map: MapLibreLike, name: string | null) {
  const filter = name ? ["!=", ["get", "name"], name] : null;
  if (map.getLayer("visited-areas-fill")) {
    map.setFilter("visited-areas-fill", filter);
  }
  if (map.getLayer("visited-fill-circle")) {
    map.setFilter("visited-fill-circle", filter);
  }
}

/* Paints one boundary polygon as the orange focus highlight (and
   clears the point ring). The unvisited-tap path uses this directly:
   it has a geometry but no ledger row to fall back to a point for.
   When the focused municipality is a designated city, the caller
   also passes its internal ward-line features, painted as deep-orange
   lines over the focus fill (see ensureFocusLayers), AND its
   outer-boundary features: the highlight then moves to the split
   fill / outline-lines sources, so the thick focus outline follows
   the city's outer edge only instead of stroking every ward part.
   Any other focus clears those lines and uses the polygon source
   exactly as before. */
function setFocusPolygon(
  map: MapLibreLike,
  geometry: GeoJsonGeometry,
  wardFeatures?: ReturnType<typeof internalWardLineFeatures>,
  outerFeatures?: ReturnType<typeof outerBoundaryLineFeatures>,
  name?: string,
) {
  ensureFocusLayers(map);
  /* A visited focus swaps its normal fill for the focus fill
     (see setNormalFillExclusion); an unvisited focus has no
     normal fill to swap, and passing its name is harmless — no
     visited feature carries it. */
  setNormalFillExclusion(map, name ?? null);
  const wholeCity = {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry }],
  };
  if (outerFeatures !== undefined) {
    map.getSource(FOCUS_POLYGON_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
    map.getSource(FOCUS_FILL_SOURCE_ID)?.setData(wholeCity);
    map
      .getSource(FOCUS_OUTLINE_SOURCE_ID)
      ?.setData(
        outerFeatures.length > 0
          ? { type: "FeatureCollection", features: outerFeatures }
          : EMPTY_FOCUS_DATA,
      );
  } else {
    map.getSource(FOCUS_POLYGON_SOURCE_ID)?.setData(wholeCity);
    map.getSource(FOCUS_FILL_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
    map.getSource(FOCUS_OUTLINE_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  }
  map.getSource(FOCUS_POINT_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  map
    .getSource(FOCUS_WARDS_SOURCE_ID)
    ?.setData(
      wardFeatures && wardFeatures.length > 0
        ? { type: "FeatureCollection", features: wardFeatures }
        : EMPTY_FOCUS_DATA,
    );
}

function setFocusGeometry(map: MapLibreLike, geometry: GeoJsonGeometry | null, m: VisitedMunicipality) {
  ensureFocusLayers(map);
  const polygonSource = map.getSource(FOCUS_POLYGON_SOURCE_ID);
  const pointSource = map.getSource(FOCUS_POINT_SOURCE_ID);
  const wardsSource = map.getSource(FOCUS_WARDS_SOURCE_ID);
  const fillSource = map.getSource(FOCUS_FILL_SOURCE_ID);
  const outlineSource = map.getSource(FOCUS_OUTLINE_SOURCE_ID);
  if (geometry) {
    /* The whole-city highlight uses the passed geometry as before;
       the ward lines come from the boundary data only
       (wardGeometryFor) — the passed geometry may be the ledger
       row's merged single Polygon, which has no ward parts left.
       The outer-boundary lines come from the same asset geometry,
       for the same reason. */
    const wardGeometry = wardGeometryFor(m.prefecture, m.name);
    setFocusPolygon(
      map,
      geometry,
      wardGeometry
        ? internalWardLineFeatures(wardGeometry, `${m.prefecture} ${m.name}`)
        : undefined,
      wardGeometry
        ? outerBoundaryLineFeatures(wardGeometry, `${m.prefecture} ${m.name}`)
        : undefined,
      `${m.prefecture} ${m.name}`,
    );
  } else if (m.lat !== null && m.lng !== null) {
    /* Point-only focus: the normal circle is swapped for the
       focus ring the same way (see setNormalFillExclusion). */
    setNormalFillExclusion(map, `${m.prefecture} ${m.name}`);
    polygonSource?.setData(EMPTY_FOCUS_DATA);
    fillSource?.setData(EMPTY_FOCUS_DATA);
    outlineSource?.setData(EMPTY_FOCUS_DATA);
    wardsSource?.setData(EMPTY_FOCUS_DATA);
    pointSource?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [m.lng, m.lat] },
        },
      ],
    });
  } else {
    setNormalFillExclusion(map, null);
    polygonSource?.setData(EMPTY_FOCUS_DATA);
    pointSource?.setData(EMPTY_FOCUS_DATA);
    wardsSource?.setData(EMPTY_FOCUS_DATA);
    fillSource?.setData(EMPTY_FOCUS_DATA);
    outlineSource?.setData(EMPTY_FOCUS_DATA);
  }
}

function clearFocusGeometry(map: MapLibreLike) {
  setNormalFillExclusion(map, null);
  map.getSource(FOCUS_POLYGON_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  map.getSource(FOCUS_POINT_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  map.getSource(FOCUS_WARDS_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  map.getSource(FOCUS_FILL_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
  map.getSource(FOCUS_OUTLINE_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
}

/* ---------------- ridden-line focus highlight ----------------
   The 路線 counterpart of the municipality focus above: while a
   line is focused, its NORMAL layers (visited-lines casing +
   color) filter it out and the focus layers below replace it.
   Unlike the municipality focus, the paint keeps the line's OWN
   color (2026-11-25, the reader's request: repainting the line
   signal orange hides which line it is). The emphasis is carried
   by width and layering instead — a halo in the line's own color
   at low opacity, a white casing, and a core in the line's own
   color, drawn wider than any normal line so the focused line
   reads at a glance without losing its identity. The color rides
   on each focus feature as a property (see setFocusSection), the
   same contract as the normal line layers. On the 市区町村 tab
   the line layers stay out of the tap hit-test set, so the
   highlight cannot intercept a municipality tap; on the 路線 tab
   the focus layers ARE hit-tested, so the highlighted track
   itself stays tappable (see the line tap handler). */

const LINE_FOCUS_SOURCE_ID = "visited-line-focus";

function ensureLineFocusLayers(map: MapLibreLike) {
  if (!map.getSource(LINE_FOCUS_SOURCE_ID)) {
    map.addSource(LINE_FOCUS_SOURCE_ID, {
      type: "geojson",
      data: EMPTY_FOCUS_DATA,
    });
  }
  if (!map.getLayer("visited-line-focus-halo")) {
    map.addLayer({
      id: "visited-line-focus-halo",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 0.3,
        "line-width": 13,
      },
    });
  }
  if (!map.getLayer("visited-line-focus-casing")) {
    map.addLayer({
      id: "visited-line-focus-casing",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": 0.95,
        "line-width": 8,
      },
    });
  }
  if (!map.getLayer("visited-line-focus-color")) {
    map.addLayer({
      id: "visited-line-focus-color",
      type: "line",
      source: LINE_FOCUS_SOURCE_ID,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 1,
        "line-width": 5,
      },
    });
  }
}

/* Line-focus switching, mirroring setNormalFillExclusion: while a
   line is focused its normal paint is filtered out of the
   visited-lines layers and the focus layers replace it, so the
   line is never double-painted. The exclusion is by SERVICE id
   (the property every overlay feature carries), not by formal
   line key: two services can share one key — 総武本線 and
   総武快速線 both paint JR・総武線 — and focusing one must not
   hide the other (integrated review round 1, medium). Null
   restores every line. The unknown layer is excluded the
   same way: a focused unknown ride must not show both as a
   thin whole path and as the focus highlight. */
function setNormalLineExclusion(map: MapLibreLike, serviceId: string | null) {
  const filter = serviceId
    ? ["all", ["!=", ["get", "unknown"], true], ["!=", ["get", "serviceId"], serviceId]]
    : ["!=", ["get", "unknown"], true];
  const unknownFilter = serviceId
    ? ["all", ["==", ["get", "unknown"], true], ["!=", ["get", "serviceId"], serviceId]]
    : ["==", ["get", "unknown"], true];
  if (map.getLayer("visited-lines-casing")) {
    map.setFilter("visited-lines-casing", filter);
  }
  if (map.getLayer("visited-lines-color")) {
    map.setFilter("visited-lines-color", filter);
  }
  if (map.getLayer("visited-lines-unknown")) {
    map.setFilter("visited-lines-unknown", unknownFilter);
  }
}

/* The ghost context a remainder-focus call rewrites the
   ghost's source from: the canonical features (the worker's
   latest result, held by the caller), the coverage key of
   the result they came from, and the CURRENT coverage.
   `spans` are the focused service's remainder legs in their
   full edge frame — the stretches the ghost must not also
   paint while the focus layer shows them at midway strength.
   No spans restores the canonical features untouched. The
   source is rewritten only while the features still belong
   to the current coverage (ghostFeaturesMatchCoverage):
   after a ledger change the held result is the old ledger's
   until the worker's fresh answer lands. */
type RemainderGhostContext = {
  features: readonly UnriddenLineFeature[];
  coverageKey: string | null;
  coverage: LineCoverage;
  spans: readonly PathLeg[];
};

/* The focused line's unridden remainder (subtask 1589,
   rescoped to the service itself by subtask 1635): while a
   line is focused, the stretches of ITS OWN path it has not
   ridden yet repaint at the midway strength of the
   unridden-lines-focus layer (see map-variant.ts for the
   paint), so where the selected line is still unridden reads
   at a glance. The layer reads its OWN source, filled here
   with the service's remainder legs from the coverage — the
   old cut shared the ghost source and selected by formal-line
   key, so a branch service painted its whole formal line's
   remainder (むさしの号's 東北線 slice drew Tokyo→Aomori).
   The switching mirrors setNormalLineExclusion: every stretch
   is painted exactly once, at exactly one strength — the
   ghost's source is rewritten with the remainder's stretches
   trimmed out of it (trimUnriddenGhostFeatures in
   unridden-ghost.ts), span-precise by formal-line key and
   graph edge, so the rest of a shared formal line keeps its
   ghost while its service is focused （東北線 north of 田端
   survives a 山手線 focus). The first cut excluded whole
   formal-line keys by layer filter, keyed off the PAINTED
   legs' keys: a ride painting only one of a service's keys
   left the other keys' ghosts stacked under the remainder,
   shifting its hue (subtask 1680, review round 1). An
   unknown ride passes no keys and no legs — nothing is
   recorded as ridden for it, so there is no remainder to
   single out, and its whole path is the focus highlight
   already. Null (or no keys) restores the ghost's canonical
   features and empties the focus source. A map whose focus
   layer never joined yet gains it here, as in
   ensureLineFocusLayers. A caller that cannot supply the
   ghost context (ghost = null) leaves the ghost's source as
   it stands; the paths that can — every focus change and
   clear — pass it, and the ghost's own late join re-applies
   the current focus right after landing. */
function setUnriddenRemainderFocus(
  map: MapLibreLike,
  keys: readonly string[] | null,
  legs: readonly RemainderLeg[],
  serviceId?: string | null,
  ghost?: RemainderGhostContext | null,
) {
  const active = keys && keys.length > 0 ? [...keys] : null;
  ensureUnriddenRemainderFocus(map);
  map.getSource(UNRIDDEN_FOCUS_SOURCE_ID)?.setData({
    type: "FeatureCollection",
    /* remainderLegFeature (line-geometry.ts) builds these —
       the same builder the tests assert the colors through
       (subtask 1680, review round 2, finding 3). A
       paint-unified service (山手線) keeps its representative
       color on the remainder too, so the focused loop reads
       as one line at both strengths. */
    features: legs.map((leg) =>
      remainderLegFeature(serviceId ?? null, leg, RIDDEN_LINE_GEOMETRIES),
    ),
  });
  if (
    ghost &&
    ghost.features.length > 0 &&
    ghostFeaturesMatchCoverage(ghost.coverageKey, ghost.coverage)
  ) {
    /* The coverage-key gate (subtask 1680, review round 2,
       finding 2 — the same discipline as the worker apply
       path's, in applyUnriddenLineGhostLatest): while the
       worker recomputes after a ledger change, the held
       features belong to the old coverage, and writing them
       back here — trimmed against the new coverage's spans,
       or restored whole on a focus clear — would resurrect a
       stale ghost. Leaving the source as it stands is safe:
       the fresh result joins through the apply path, which
       re-applies the current focus right after landing. */
    map.getSource(UNRIDDEN_LINES_SOURCE_ID)?.setData({
      type: "FeatureCollection",
      features:
        active && ghost.spans.length > 0
          ? trimUnriddenGhostFeatures(
              ghost.features,
              ghost.coverage,
              RIDDEN_LINE_GEOMETRIES,
              ghost.spans,
            )
          : ghost.features,
    });
  }
  /* The ghost layer carries no filter: the exclusion lives in
     its source data now, not in a key filter. Clearing any
     filter a previous build set keeps that invariant on a map
     that outlives the switch. */
  if (map.getLayer("unridden-lines-ghost")) {
    map.setFilter("unridden-lines-ghost", null);
  }
}

/* Paints one ridden service's painted legs as the focus
   highlight, swapping them out of the normal line layers (see
   setNormalLineExclusion). `legs` are the service's painted legs
   from the line coverage — a partial ride highlights only its
   ridden section, a full ride its whole path, an unknown ride
   its whole path. Each feature carries its leg's own color (the
   asset entry for the leg's key, the same lookup the normal
   overlay features use) so the focus layers paint the line in
   its own color; a leg whose asset entry has no color falls
   back to the signal orange, the pre-2026-11-25 paint. The
   features carry the serviceId too, so a tap on the highlight
   itself resolves to the same service (the focus layers are in
   the tap hit-test set — see the line tap handler). */
function setFocusSection(
  map: MapLibreLike,
  serviceId: string,
  legs: readonly { key: string; coords: readonly [number, number][] }[],
) {
  ensureLineFocusLayers(map);
  setNormalLineExclusion(map, serviceId);
  map.getSource(LINE_FOCUS_SOURCE_ID)?.setData({
    type: "FeatureCollection",
    /* focusSectionFeature (line-geometry.ts) builds these —
       the same builder the tests assert the colors through
       (subtask 1680, review round 2, finding 3). A
       paint-unified service (山手線) highlights in its
       representative color throughout, not per formal line —
       the highlight is the service's identity cue. */
    features: legs.map((leg) =>
      focusSectionFeature(serviceId, leg, RIDDEN_LINE_GEOMETRIES),
    ),
  });
}

function clearFocusLineGeometry(
  map: MapLibreLike,
  ghost?: Omit<RemainderGhostContext, "spans"> | null,
) {
  setNormalLineExclusion(map, null);
  /* No spans: the ghost's source goes back to the canonical
     features, undoing the cleared focus's trim. */
  setUnriddenRemainderFocus(
    map,
    null,
    [],
    null,
    ghost ? { ...ghost, spans: [] } : ghost,
  );
  map.getSource(LINE_FOCUS_SOURCE_ID)?.setData(EMPTY_FOCUS_DATA);
}

function VisitedMapSection({
  active,
  variant,
  deviceLoc,
  cameraRequest,
  onRetakeDeviceLocation,
  visitFilter,
  listFilter,
  tagFilter,
  search,
  centerGetterRef,
  onSpotTap,
  fullscreen,
  onToggleFullscreen,
  children,
}: {
  active: boolean;
  /* Which map tab is showing (tab split, subtask 1439; the
     スポット tab joined the shared map in the unification,
     subtask 1460): the section stays mounted across all three
     map tabs — one map, one load of every dataset — and the
     variant only swaps the hero / ghost paint on the map and
     which ledger renders below it. See map-variant.ts for the
     paint side. */
  variant: RecordMapVariant;
  /* Fullscreen (subtask 1484): the shared App flag — every map
     tab reads the same value through this one section, so
     switching tabs while fullscreen keeps the newly shown map
     fullscreen too. */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /* The maps' shared Pixel position (App state) — the SAME position
     the スポット tab's map receives. Updated every time any
     stored-position read (a re-take on either tab, or the initial
     mount read) lands a fresh position, whatever the spot list's
     sort choice is, and adopted by this map the moment it changes
     (see the adoption effect below), so both maps follow a re-take
     instantly instead of one waiting for the 60 s poll. Null until
     the first successful read; the map then keeps whatever
     position it already has. */
  deviceLoc: { lat: number; lng: number; capturedAtMs: number } | null;
  /* Explicit camera moves from a re-take (see MapCameraRequest in
     App): only requests targeting "visited" are applied here, each
     at most once. This is what finally moves THIS map's camera on
     a re-take — the adoption effect below is marker-only by
     design, so without the request a re-take whose marker landed
     off-screen looked like nothing happened at all. */
  cameraRequest: MapCameraRequest | null;
  /* App's map-only re-take (retakeMapDeviceLocation): reads the
     stored position, updates the shared deviceLoc, and mints the
     camera request above on success — without touching the spot
     list's sort at all. Resolves with the outcome so this tab's
     button can report a failure next to itself. */
  onRetakeDeviceLocation: () => Promise<RetakeDeviceResult>;
  /* The スポット tab's list filters (unification, subtask 1460):
     the unified map plots the same filtered set the spot list
     shows, so these arrive as props now that the spot map lives
     here instead of in SpotListMap. */
  visitFilter: "all" | "unvisited" | "visited";
  listFilter: string | null;
  tagFilter: string | null;
  search: string;
  /* Registered once the live map attaches and cleared when it is
     destroyed; while it is null the caller falls back to the
     whole-country center. The getter reads the camera at call
     time, so it always returns the CURRENT center, never a stale
     snapshot. (Moved from SpotListMap with the map.) */
  centerGetterRef?: {
    current: (() => { lat: number; lng: number } | null) | null;
  };
  /* A tap on a plotted spot, resolved against the CURRENT filtered
     set (the same set the points layer paints). Optional: without a
     handler the map stays display-only. (Moved from SpotListMap
     with the map.) */
  onSpotTap?: (point: SpotMapPoint) => void;
  /* Content rendered below the map pane, inside the same grid div
     (review round 1, finding 3): App passes the スポット tab's
     list and controls here, so the sticky map pane's parent spans
     the list too and the pane stays pinned while the list scrolls
     beneath it. On the record tabs nothing is passed. */
  children?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const visitedQuery = useQuery({
    queryKey: ["visitedMunicipalities"],
    queryFn: () => api.listVisitedMunicipalities({}),
  });
  const municipalities = visitedQuery.data?.municipalities ?? [];
  const prefectures = visitedQuery.data?.prefectures ?? [];
  const totalVisited = visitedQuery.data?.total ?? 0;
  /* Boundary data (boundary-data.ts): the version counter drives a
     re-render whenever a prefecture file lands, so the derived
     shapes below (mappable / shaped / circled) and the progress
     denominators pick new boundaries up as they arrive. The map
     mount waits for the priority set — the ledger's prefectures
     plus the prefecture borders — to settle, so the first mount
     already paints the visited shapes; the static preview covers
     the pane meanwhile, exactly as it does while the basemap
     loads. A failed priority load does not hold the mount: the
     map mounts without the boundary layers and boundaryFailed
     shows the discreet note under the map. */
  const boundaryVersion = useSyncExternalStore(
    subscribeBoundaryData,
    getBoundaryVersion,
    getBoundaryVersion,
  );
  const [boundarySettled, setBoundarySettled] = useState(false);
  const boundaryFailed = isBoundaryLoadFailed();
  /* The manifest and the prefecture borders do not depend on the
     ledger; start them with the section itself. */
  useEffect(() => {
    void ensureBoundaryManifest();
    void ensurePrefectureBorders();
  }, []);
  /* The priority prefectures follow the ledger — but the ledger
     must not gate the map (review round 1, finding 2): this
     (re)runs whenever a new ledger lands, so a municipality
     recorded in a prefecture that has not loaded yet pulls its
     boundaries in too, and it starts at once with whatever
     prefectures are known so far (none while the ledger is still
     pending), so a hung ledger API no longer holds the map on
     ライブ地図を読み込み中 forever. boundarySettled flips once
     the first priority round finishes, successfully or not. The
     wait is also capped: a slow manifest-then-prefecture
     sequence used to add ~30 s before the mount could start;
     after the cap the map mounts without the boundary layers and
     they fill in behind it (the background refresh and the
     placesKey remount pick the shapes up when they land). */
  useEffect(() => {
    const prefs = [
      ...new Set(
        (visitedQuery.data?.municipalities ?? []).map((m) => m.prefecture),
      ),
    ];
    let cancelled = false;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const settleCap = new Promise<void>((resolve) => {
      capTimer = setTimeout(resolve, 10_000);
    });
    void Promise.race([loadBoundaryPriorities(prefs), settleCap]).then(
      () => {
        if (!cancelled) setBoundarySettled(true);
      },
    );
    return () => {
      cancelled = true;
      if (capTimer) clearTimeout(capTimer);
    };
  }, [visitedQuery.data, visitedQuery.isError]);
  /* Once the priority set is in, the rest of the country streams
     in behind it; refreshNationwideBoundarySources (below, on
     every boundaryVersion bump) completes the nationwide layers
     in place as those files land. The prefecture the reader is
     currently in heads the background queue (it is NOT part of
     the priority set — the mount never waits for it), so the
     boundaries around the reader arrive first. The effect re-runs
     when the shared Pixel position lands; the loader is shared
     and idempotent, so a re-run costs nothing once under way. */
  useEffect(() => {
    if (!boundarySettled) return;
    const hint = deviceLoc
      ? nearestBoundaryPrefectureName(deviceLoc.lat, deviceLoc.lng)
      : null;
    void loadRemainingBoundaryPrefectures(hint);
  }, [boundarySettled, deviceLoc]);
  /* Mappable = has a representative point (stored coordinates, or one
     derived from the known boundary — see representativePoint). The
     ledger number, by contrast, belongs to EVERY row: it is the row's
     position in the ledger order (first-visit date first), whether or
     not the row can be placed on the map. Numbering only the mappable
     rows is what left the 2026-11-21 rows showing a bare "・". */
  const mappable = municipalities.filter((m) => representativePoint(m) !== null);
  const mappableIndex = new Map(mappable.map((m, i) => [m.id, i]));
  const ledgerIndex = new Map(municipalities.map((m, i) => [m.id, i]));
  /* Municipalities with a real boundary shape, and the ones that still
     only have a representative point (drawn as a circle). */
  const shaped = municipalities
    .map((m) => ({ m, geometry: boundaryGeometryFor(m) }))
    .filter((x): x is { m: VisitedMunicipality; geometry: GeoJsonGeometry } => x.geometry !== null);
  const circled = mappable.filter((m) => boundaryGeometryFor(m) === null);

  /* Ridden lines: this section owns the fetch and hands the rows
     down to RiddenLinesBlock as props (integrated review round 1,
     medium — the block used to run its own useQuery on the same
     key, and switching tabs re-ran it). The rows feed the stage-2
     line coverage below, which paints only the ridden sections. */
  const riddenQuery = useQuery({
    queryKey: ["riddenLines"],
    queryFn: () => api.listRiddenLines({}),
  });
  /* The スポット tab's points, under that tab's own query key so
     the whole page shares ONE fetch (tab split, subtask 1439):
     the not-yet-visited points become the ghost dots on this map
     (see ensureGhostSpotPoints). */
  const spotPointsQuery = useQuery({
    queryKey: ["spotPoints"],
    queryFn: () => api.listSpotPoints({}),
  });
  const ghostSpotPointFeatures = useMemo(
    () => ghostSpotFeatures(spotPointsQuery.data?.points ?? []),
    [spotPointsQuery.data],
  );
  const ghostSpotPointFeaturesRef = useRef(ghostSpotPointFeatures);
  ghostSpotPointFeaturesRef.current = ghostSpotPointFeatures;
  /* The スポット tab's filtered set (unification, subtask 1460 —
     the same visit-state / list / tag / search filter the spot
     list applies, so the unified map plots exactly the dots the
     list shows). The mount paints this set; later filter changes
     flow through the sync effect below via setData, never a
     remount — the same contract SpotListMap kept. */
  const allSpotPoints = spotPointsQuery.data?.points ?? [];
  const filteredSpots = allSpotPoints.filter((p) => {
    if (visitFilter === "unvisited" && p.visited) return false;
    if (visitFilter === "visited" && !p.visited) return false;
    if (listFilter && p.category !== listFilter) return false;
    if (tagFilter && !p.tags.includes(tagFilter)) return false;
    if (search) {
      const hay = [p.name, p.address ?? "", p.note ?? "", ...p.tags]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  });
  const filteredSpotsKey = filteredSpots
    .map((p) => `${p.id}:${p.lng},${p.lat}`)
    .join(";");
  const filteredSpotsRef = useRef(filteredSpots);
  filteredSpotsRef.current = filteredSpots;
  const pointsFeatureCollection = (pts: SpotMapPoint[]) => ({
    type: "FeatureCollection",
    features: pts.map((p) => ({
      type: "Feature",
      properties: { id: p.id },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  });
  const lineCoverage = useMemo(
    () => computeRiddenLineCoverage(
      riddenQuery.data?.lines ?? [],
      RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap,
      JAPAN_LINE_TOTAL,
    ),
    [riddenQuery.data],
  );
  /* The map exists for the lines as much as for the municipalities
     (integrated review round 1, high): a reader whose only
     records are rides — zero visited municipalities — still gets
     the map on the 路線 tab. The map's mount and every render
     gate key off this, never off the municipality count alone. */
  const hasRiddenLines = (riddenQuery.data?.lines.length ?? 0) > 0;
  const showLiveMap = mappable.length > 0 || hasRiddenLines;
  /* The map pane shows whenever any tab has something to plot:
     the record tabs' showLiveMap, or the スポット tab itself —
     the old spot map mounted on the スポット tab even with no
     spots and no records (its whole-country initial camera is
     the empty state, not a blank pane), so the mount gate must
     not wait for a first spot to arrive. The mount gate and the
     pane's render gate both read this, never the municipality
     count alone. */
  const showMapPane = showLiveMap || variant === "spots";
  /* Mirrors for the map tap listeners and the mount effect, which
     run outside this render's closure: the current variant, the
     ledger rows, and the coverage they resolve taps against. */
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const riddenRowsRef = useRef<readonly RiddenLine[]>([]);
  riddenRowsRef.current = riddenQuery.data?.lines ?? [];
  const lineCoverageRef = useRef(lineCoverage);
  lineCoverageRef.current = lineCoverage;
  /* The 路線 tab's ghost of everything NOT ridden (tab split,
     subtask 1439 — the reader allowed unridden lines as a ghost
     there): for each formal line, the drawing shape minus the
     solid-painted ranges, edge by edge (see ghostLineLegs) —
     so a partially ridden line keeps exactly its unridden
     stretches as a thin underlay, and only a line with nothing
     unridden left leaves the ghost. The old whole-key exclusion
     dropped the whole 山手線 loop from the ghost the moment one
     section of it was ridden, so the unridden arcs showed
     nothing and the loop read as gapped (subtask 1456, review
     round 1). One feature per key, in its own color, drawn as
     one thin layer whose visibility the variant paint toggles.
     The remainder is then coarsened with the ghost
     simplification (subtask 1457): the pieces chained and
     simplified at the spec's 60 m tolerance, under half the
     coordinates — the faint underlay does not need the record's
     precision, and the ridden legs above it still draw at full
     precision. The subtraction makes the remainder depend on
     the coverage, so it is simplified per key through
     simplifyGhostRemainder, whose memo re-runs a line only when
     its remainder actually changed (review round 1: a coverage
     change used to re-simplify all 597 lines). The painted
     legs' endpoints on each key ride along as protected points,
     so the points where ghost meets paint are pinned exactly —
     unpinned, chaining plus DP could drop a shared point
     mid-run and the ghost slid off the paint (17.5 m on
     山手線）. Slice endpoints survive simplification exactly,
     so the painted/ghost boundary keeps its precision.
     The computation itself is the map's heaviest (all 597
     lines), so it runs off the UI thread entirely (review
     round 3): the first cut's useMemo simplified everything
     synchronously on EVERY tab — including the two that never
     show the ghost — before the first paint, and round 2's
     setTimeout deferral still let the ~300 ms computation
     precede the 路線 tab's first paint. Now an effect hands
     the settled coverage to the ghost's Web Worker
     (unridden-ghost.ts / unridden-ghost-client.ts) once the
     路線 tab is showing, and the result — tagged with the
     coverage key of the ledger it was computed from — joins
     the live map through applyUnriddenLineGhostLatest (the
     mount still bakes it in directly when a remount finds it
     ready AND still current). Tabs that never show the ghost
     never start the worker at all. */
  const lineCoverageKey = useMemo(
    () => ghostCoverageKey(serializeGhostCoverage(lineCoverage)),
    [lineCoverage],
  );
  const lineCoverageKeyRef = useRef(lineCoverageKey);
  lineCoverageKeyRef.current = lineCoverageKey;
  const [unriddenGhost, setUnriddenGhost] =
    useState<UnriddenGhostResult | null>(null);
  const unriddenGhostRef = useRef(unriddenGhost);
  unriddenGhostRef.current = unriddenGhost;
  /* The mount overlay bake still reads a plain feature list:
     the latest result's features, or none before the first
     result lands. Whether they may be baked at all is decided
     where the overlay is built (the coverage-key check). */
  const unriddenLineFeatures: readonly UnriddenLineFeature[] =
    unriddenGhost?.features ?? [];
  /* The ghost context every focus change hands to
     setUnriddenRemainderFocus: the canonical features as the
     worker last delivered them and the current coverage, read
     from the refs at call time, like the selection itself. */
  const remainderGhostContext = (): Omit<
    RemainderGhostContext,
    "spans"
  > => ({
    features: unriddenGhostRef.current?.features ?? [],
    coverageKey: unriddenGhostRef.current?.coverageKey ?? null,
    coverage: lineCoverageRef.current,
  });
  /* Re-applies the CURRENT selection's unridden-remainder
     emphasis to a map whose remainder layer was (re)created
     under it — the mount completion and the ghost's late join
     share this routine (Codex review batch round 1, finding 3):
     both paths (re)build the layer with its empty source, and
     when the ghost result itself did not change, the ghost
     effect never re-runs, so without this the row would stay
     selected while its emphasis is gone. The selection is read
     from the same refs the tap handlers write, at call time.
     No applicable selection — the layers keep their state
     (a fresh layer's empty source is exactly that state). */
  const applyUnriddenRemainderFocus = (map: MapLibreLike) => {
    const keys = unriddenRemainderKeysForSelection(
      riddenRowsRef.current,
      lineCoverageRef.current.perServiceLegs,
      focusedLineIdRef.current,
    );
    const legs = unriddenRemainderLegsForSelection(
      riddenRowsRef.current,
      lineCoverageRef.current.perServiceLegs,
      lineCoverageRef.current.perServiceUnriddenLegs,
      focusedLineIdRef.current,
    );
    if (keys !== null && legs !== null) {
      /* The selection's service, resolved the same way the
         keys/legs helpers resolve it, so a paint-unified
         service's remainder keeps its representative color
         on this re-apply path too (subtask 1680). */
      const focusedRow = riddenRowsRef.current.find(
        (row) => row.id === focusedLineIdRef.current,
      );
      const focusService = focusedRow
        ? usableRiddenService(focusedRow)
        : undefined;
      /* The ghost trim's spans: the service's remainder legs
         in their full edge frame — the same legs the focus
         source paints, before the RemainderLeg projection
         drops the frame. An empty remainder trims nothing. */
      const spans =
        legs.length > 0 && focusService
          ? (lineCoverageRef.current.perServiceUnriddenLegs.get(
              focusService.id,
            ) ?? [])
          : [];
      setUnriddenRemainderFocus(map, keys, legs, focusService?.id ?? null, {
        ...remainderGhostContext(),
        spans,
      });
    }
  };
  const lineCoverageSettled =
    riddenQuery.data !== undefined || riddenQuery.isError;
  useEffect(() => {
    if (variant !== "lines" || !lineCoverageSettled) return;
    if (unriddenGhostRef.current?.coverageKey === lineCoverageKey) return;
    let cancelled = false;
    unriddenGhostClient
      .request(serializeGhostCoverage(lineCoverage))
      .then((result) => {
        if (cancelled || !result) return;
        /* The ledger moved on while the worker was computing:
           this result belongs to a coverage the map no longer
           shows, and the newer request's result is the one to
           apply (review round 3, finding 1 — a stale ghost must
           never reach the map). */
        if (result.coverageKey !== lineCoverageKeyRef.current) return;
        setUnriddenGhost(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error("Unridden line geometry failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [variant, lineCoverageSettled, lineCoverage, lineCoverageKey]);

  /* The overlay features: one per painted leg, so a partial ride
     paints only its ridden section and an unknown ride paints
     its whole path thin. A leg's key is its formal line; the
     color comes from the asset entry for that key. `key`,
     `serviceId` and `unknown` ride along so a line focus can
     filter its legs OUT of the normal line layers while the
     focus highlight replaces them (see setNormalLineExclusion)
     and so a map tap can resolve the SERVICE that painted the
     tapped leg: services sharing one formal line (総武本線 /
     総武快速線 both draw JR・総武線) are told apart by
     serviceId, never by key alone (integrated review round 1,
     medium). */
  const riddenLineFeatures = useMemo(() => {
    const features: PaintedLegFeature[] = [];
    for (const [serviceId, painted] of lineCoverage.perServiceLegs) {
      for (const leg of painted.legs) {
        /* paintedLegFeature (line-geometry.ts) builds these —
           the same builder the tests assert the colors through
           (subtask 1680, review round 2, finding 3). A
           paint-unified service (山手線) paints every leg in
           its representative color: the loop is one named line
           to the reader even where its trains run on the
           東北線・東海道線 formal lines. The leg's key still
           names its formal line for coverage and the ghost;
           a leg with no color at all is skipped, as before. */
        const feature = paintedLegFeature(
          serviceId,
          leg,
          painted.unknown,
          RIDDEN_LINE_GEOMETRIES,
        );
        if (feature) features.push(feature);
      }
    }
    return features;
  }, [lineCoverage]);

  const riddenLinesKey = useMemo(
    () => JSON.stringify(
      [...lineCoverage.perServiceLegs].map(([serviceId, { legs, unknown }]) => [
        serviceId,
        unknown,
        legs.map(({ key, edge, fromT, toT }) => [key, edge, fromT, toT]),
      ]),
    ),
    [lineCoverage],
  );

  /* Progress: the main metric is the deduped ridden distance
     against every formal line in Japan (26,903.9 km). The
     numerator is the painted total, so the donut, the header,
     and the map always agree. The count of complete services
     and the unprepared-lines note ride alongside it. */
  const networkRiddenKm = lineCoverage.networkRiddenKm;
  const completeServiceCount = lineCoverage.completeServiceIds.length;
  const unpreparedLines = lineCoverage.unpreparedLines;
  const municipalityProgressPct =
    JAPAN_MUNICIPALITY_TOTAL > 0
      ? ((totalVisited / JAPAN_MUNICIPALITY_TOTAL) * 100).toFixed(2)
      : "0.00";
  const lineProgressPct =
    JAPAN_LINE_TOTAL_KM > 0
      ? ((networkRiddenKm / JAPAN_LINE_TOTAL_KM) * 100).toFixed(1)
      : "0.0";
  const networkRiddenKmText = `${networkRiddenKm.toLocaleString(undefined, { maximumFractionDigits: 1 })}km`;

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const fallbackMapRef = useRef<HTMLElement>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  /* The ledger wrapper element: at xl it becomes its own scroll pane
     beside the map, and scrollRowFullyIntoView then measures and
     scrolls against the pane instead of the window. */
  const ledgerPaneRef = useRef<HTMLDivElement>(null);
  const mapHandleRef = useRef<PlaceListMapHandle | null>(null);
  /* Callbacks waiting for a live map (see withLiveMap below): a
     waiter whose poll ran out stays registered here until a map
     signals readiness (flushMapWaiters) or the mount is torn down
     (cancelMapWaiters), so a call that raced a slow map is applied
     to it late instead of being dropped. */
  type MapWaiter = {
    fn: (map: MapLibreLike) => void;
    cancelled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    retry: () => void;
  };
  const mapWaitersRef = useRef(new Set<MapWaiter>());
  /* The map instance the blank-tap clear listeners are attached to, and
     a snapshot of the current press (canvas point + camera center) so
     a drag, which also produces a click, does not count as a tap
     (see tap-guard.ts for the decision and why the pointer, not the
     camera, decides). */
  const focusListenerMapRef = useRef<MapLibreLike | null>(null);
  const pressSnapshotRef = useRef<PressSnapshot | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [basemapReady, setBasemapReady] = useState(false);
  /* The loading overlay's fade-out (the reader asked for a fade
     instead of the hard cut): while the basemap loads, the overlay
     — the stored static image — covers the live map; when the
     basemap lands it used to vanish in a single frame. It now stays
     mounted for one beat at opacity 0, crossfading into the live
     map already painted underneath, and only then unmounts. A
     remount (retry ladder / background recovery) flips basemapReady
     back to false and the overlay returns at full opacity, ready to
     fade again when the new basemap lands. */
  const [fallbackPhase, setFallbackPhase] = useState<"shown" | "fading" | "gone">(
    "shown",
  );
  useEffect(() => {
    if (!basemapReady) {
      setFallbackPhase("shown");
      return;
    }
    /* Reduced motion: the overlay comes off the moment the basemap
       is ready — no fade, no 600 ms linger (subtask 1216, review
       low). The CSS-wide reduced-motion rule already collapses the
       transition itself, but the phase timer would still keep the
       overlay mounted and fading state alive; skip both here. */
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = fallbackPhaseAfterReady(reduceMotion);
    setFallbackPhase((phase) => (phase === "shown" ? next : phase));
    if (next === "gone") return;
    const t = setTimeout(() => setFallbackPhase("gone"), 600);
    return () => clearTimeout(t);
  }, [basemapReady]);
  /* Automatic recovery from a failed basemap load: a transient
     failure — a style fetch reset on a weak connection, a resource
     error the runtime classifies as fatal — no longer drops
     straight to the static fallback. The mount effect's failure
     path (createMapMountFailureControl) remounts on a backoff
     ladder (mapAttempt is the nonce that re-runs it;
     mapRetryCountRef is the ladder position, reset by the manual
     reload button and by each background recovery round), and only
     a spent ladder shows the fallback. The fallback is not final
     either: useMapMountRecovery below starts fresh rounds while it
     is shown, so the live map returns on its own once the
     connection settles. Once a mount's basemap has actually
     arrived, later error callbacks are ignored entirely: the live
     map stays up, because at that point the runtime's "fatal" is
     almost always a single dropped tile/glyph request, which
     MapLibre recovers from on its own as the reader pans and
     zooms. */
  const [mapAttempt, setMapAttempt] = useState(0);
  const mapRetryCountRef = useRef(0);
  /* Why the last mount gave up, shown in the fallback note (see
     describeMapFailure). Set only at give-up time, from the first
     effective failure signal of the final attempt; cleared when a
     fresh round starts. */
  const [mapFailureReason, setMapFailureReason] = useState<string | null>(null);
  /* Background recovery while the static fallback is shown: reset
     the ladder and remount. Any half-mounted handle is destroyed
     first so the fresh mount starts from an empty container. */
  useMapMountRecovery(mapFailed, () => {
    try {
      mapHandleRef.current?.destroy();
    } catch {
      /* a half-mounted handle may refuse; the remount replaces
         its container either way */
    }
    mapHandleRef.current = null;
    focusListenerMapRef.current = null;
    mapRetryCountRef.current = 0;
    setMapFailureReason(null);
    setMapFailed(false);
    setMapAttempt((n) => n + 1);
  });
  /* Current-location marker: the last position shown (kept in a ref
     so a re-attached map can redraw it). The position source
     is the stored Pixel position alone (resolveCurrentLocation);
     browser geolocation is gone from the whole page. */
  const currentLocRef = useRef<{ lat: number; lng: number } | null>(null);
  /* The スポット tab's framing position (unification, subtask 1460
     — moved from SpotListMap): the same stored position as
     currentLocRef, but as state, so the spots sync + framing
     effect below re-runs when it lands or moves. The record tabs
     never read it; their marker-only paths keep using
     currentLocRef. */
  const [spotLoc, setSpotLoc] = useState<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);
  const spotLocRef = useRef<{
    lat: number;
    lng: number;
    label: string;
  } | null>(null);
  /* The shared location's single publisher (map-framing.ts,
     v89 review round 6, P2-1): the capture time of the
     position last adopted into spotLoc, so a held read
     cannot rewind it with older coordinates. */
  const sharedLocationPublisherRef = useRef(createSharedLocationPublisher());
  /* The ONE place the shared location is written (v89 review
     round 6, P2-1). Every route that adopts a position
     funnels through here — the framing reads, the manual
     frame button, the 60 s poll, the deviceLoc adoption,
     the mount resolve, the re-take camera request — so the
     capture time of the adopted position and the position
     itself are compared and recorded together: whichever
     route adopted the newer position, a held older read
     landing later can no longer rewind it. Returns whether
     the candidate was adopted; a refused candidate changes
     nothing. A candidate at the same coordinates only moves
     the freshness bar: the refs and the state already hold
     those coordinates, and rewriting them would re-run the
     spots framing effect (and re-fit its camera) for no
     movement — the old poll and adoption early-returns did
     the same, minus the bar, which is exactly the hole
     round 6 closed. */
  const publishSharedLocation = (loc: {
    lat: number;
    lng: number;
    label: string;
    capturedAtMs: number;
  }): boolean => {
    if (!sharedLocationPublisherRef.current.publish(loc)) return false;
    const cur = currentLocRef.current;
    if (cur && cur.lat === loc.lat && cur.lng === loc.lng) return true;
    currentLocRef.current = { lat: loc.lat, lng: loc.lng };
    spotLocRef.current = loc;
    setSpotLoc(loc);
    return true;
  };
  /* Mirrors for the spots framing effect, which reads them outside
     the cameraRequest prop's own effect: the latest request, and
     the live map itself (set once the mount hands the map over,
     cleared when the mount is torn down). */
  const cameraRequestRef = useRef(cameraRequest);
  cameraRequestRef.current = cameraRequest;
  const liveMapRef = useRef<MapLibreLike | null>(null);
  /* Stop any camera animation still running on the live map, so a
     deliberate camera move never fights the previous tab's
     in-flight fitBounds / flyTo (review round 1, finding 7). The
     stop lives at each deliberate move, not at the variant-change
     effect's head: that callback runs in the same commit as the
     new tab's framing, so a stop there would cancel the framing
     that just started (and the spots re-take fly-to). */
  const stopCamera = (map: MapLibreLike) => {
    try {
      map.stop?.();
    } catch {
      /* stopping is best-effort */
    }
  };
  /* Tear down the live map instance and drop every reference to
     it: the handle, the live-map ref the framing effects read,
     the center getter the spot list's sort reads, and the
     listener guards. Called whenever the map goes away — the
     mount effect's cleanup (so leaving for the その他 tab, or a
     remount, never leaves a detached instance running), and the
     mount gate's no-mount path (so the empty record state keeps
     at most one instance, review round 1, finding 1).
     Idempotent: a missing handle is a no-op. */
  const destroyLiveMap = () => {
    try {
      mapHandleRef.current?.destroy();
    } catch {
      /* a half-mounted handle may refuse */
    }
    mapHandleRef.current = null;
    liveMapRef.current = null;
    focusListenerMapRef.current = null;
    spotTapListenerMapRef.current = null;
    if (centerGetterRef) centerGetterRef.current = null;
  };
  /* The スポット tab's whole-country initial camera (review round
     1, finding 4): the same center / zoom the mount passes on
     the スポット tab. Used when entering the スポット tab with
     no Pixel position — the spots framing effect leaves the
     camera alone without one, so the record tab's view would
     otherwise linger. Instant, like the mount. */
  const resetSpotsCamera = (map: MapLibreLike) => {
    const { center, zoom } = spotsInitialCamera(
      mapContainerRef.current?.clientWidth ?? 0,
    );
    try {
      stopCamera(map);
      map.flyTo({ center: [center.lng, center.lat], zoom, duration: 0 });
    } catch {
      /* framing is a cue; a failure leaves the current view */
    }
  };
  const [locBusy, setLocBusy] = useState(false);
  /* Busy flag for this tab's own 「Pixelの位置を取り直す」 button
     (separate from locBusy, which belongs to the frame button). */
  const [retakeBusy, setRetakeBusy] = useState(false);
  /* Why this tab's last re-take could not be used, shown next to
     the button: on failure no camera request is issued, so the
     camera stays put and the previous marker stays — the notice
     says so, with the previous position's age when there is one.
     A "superseded" outcome (a newer request won the race) shows
     nothing: the newer request's own outcome drives the UI. */
  const [retakeNotice, setRetakeNotice] = useState<
    { kind: "stale"; at: number } | { kind: "none" } | { kind: "error" } | null
  >(null);
  /* The newest camera-request seq this map has already flown to:
     each request is applied at most once, and one that arrives
     before the map is ready is held until mapReady rises. */
  const appliedCameraSeqRef = useRef(0);
  /* Bumped once the interactive map is live, so the default framing
     below knows when it can move the camera. */
  const [mapReady, setMapReady] = useState(0);
  /* Default framing (the reader's final call on the zoom question):
     fit the camera to the boundary of the municipality the reader
     is currently in — found by testing the Pixel position against
     the known boundary shapes — so the fit is right whether that
     municipality is large or small. When no known boundary contains
     the position, a small box around the position itself is fitted
     instead. The blue Pixel marker is drawn either way. Runs once
     automatically when the map and the ledger are ready (unless the
     reader has already picked a municipality), and again whenever
     the 「今いる市区町村に合わせる」 button is pressed. */
  /* fitBounds padding for this section's framing moves: in
     fullscreen the fitted frame must end above the bottom tab
     bar, which floats over the map's lower edge (v89 review
     round 1, finding 6). The flag is read through a ref and
     the bar height from the live DOM, both at the moment the
     fit is applied to the camera: every caller runs inside a
     live-map callback, which can land long after the closure
     was created — a location read that resolves after the
     reader toggled fullscreen mid-flight must frame with the
     CURRENT state, not the state at request time (v89 review
     round 2, finding 4). */
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const mapFitPadding = (base = 36) =>
    fitBoundsPadding(fullscreenRef.current, bottomTabBarHeightPx(), base);
  const frameCurrentMunicipality = async (
    manual: boolean,
    onApplied?: () => void,
    mayApply?: () => boolean,
    publish?: (loc: {
      lat: number;
      lng: number;
      label: string;
      capturedAtMs: number;
    }) => boolean,
  ): Promise<boolean> => {
    if (manual) setLocBusy(true);
    const loc = await resolveCurrentLocation();
    if (manual) setLocBusy(false);
    if (!loc) {
      return false;
    }
    /* Publishing this read into the shared location (review
       rounds 4–6): a superseded auto-fit run discards its
       read BEFORE the shared location is rewritten — its
       camera fit is refused by mayApply further down, but
       the writes used to run first, and the スポット tab
       plots its marker — and recomputes its nearest spot
       and frame — from this shared location, so a stale
       read landing after a newer one dragged the スポット
       map back to the old position. The publish callback
       the auto-fit effect passes composes the run-currency
       check (round 4) with the single shared publisher
       (round 6, P2-1), which compares the read's capture
       time against the position already adopted and records
       the adopted time in the same step — a run held across
       a tab switch is still current for its own tab, so
       currency alone would let its older coordinates rewind
       the shared location (round 5). Manual calls pass no
       publish callback and go through the same publisher
       directly, so a manual frame that resolved a stored
       position older than the adopted one cannot rewind it
       either.
       A refused publish no longer stops the framing here
       (round 6, P2-2): the run still owns its initial fit
       while it is valid, so the fit continues on the
       position already adopted instead of leaving the tab
       with no initial frame — returning early also skipped
       the visited-bounds fallback. When nothing is adopted
       yet the run was superseded and the newer run owns the
       framing, so there is nothing to frame on and the run
       still reports located. The camera guard below still
       decides whether the fit may actually land. */
    const published = publish ? publish(loc) : publishSharedLocation(loc);
    const frameLoc = resolveFrameLocation(
      loc,
      published,
      currentLocRef.current,
    );
    if (!frameLoc) return true;
    const hit = findMunicipalityAt(
      frameLoc.lat,
      frameLoc.lng,
      municipalitiesRef.current,
    );
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    withLiveMapRef.current((map) => {
      /* Awaiting the location read can outlive the tab: if the
         reader has moved to the スポット tab meanwhile, the
         record framing must not yank its camera (review round 1,
         finding 6). The marker is redrawn by the spots framing
         effect there. */
      if (variantRef.current === "spots") return;
      /* The read can also outlive the run that started it: the
         reader picked this tab's focus meanwhile, or a newer
         run of this tab superseded this one. The auto-fit
         caller passes mayApply to refuse exactly those late
         landings (review round 3, finding 1); manual calls
         pass none and always frame. */
      if (mayApply && !mayApply()) return;
      try {
        stopCamera(map);
        ensureFocusListenersRef.current(map);
        drawCurrentLocationMarker(map, frameLoc.lat, frameLoc.lng, false);
        const bounds = hit ? geometryBounds(hit.geometry) : null;
        if (bounds) {
          map.fitBounds(bounds, {
            padding: mapFitPadding(),
            maxZoom: 15,
            duration: reduceMotion ? 0 : 1200,
          });
        } else {
          map.fitBounds(
            [
              [frameLoc.lng - 0.04, frameLoc.lat - 0.03],
              [frameLoc.lng + 0.04, frameLoc.lat + 0.03],
            ],
            { padding: mapFitPadding(), maxZoom: 15, duration: reduceMotion ? 0 : 1200 },
          );
        }
        /* The fit landed on the camera (the tab guard above
           passed): the auto-fit caller spends its one shot
           here, never at request time (v89 review round 2,
           finding 1). */
        onApplied?.();
      } catch {
        /* framing is best-effort; a failure leaves the current view */
      }
    });
    return true;
  };
  /* Fit the camera to every visited municipality the reader can
     place (review round 1, finding 4): entering a record tab
     with no Pixel position must still restore the record tabs'
     initial camera instead of leaving the スポット tab's view.
     Falls back to the whole-country camera when nothing is
     placeable. */
  const frameVisitedBounds = (
    onApplied?: () => void,
    mayApply?: () => boolean,
  ) => {
    withLiveMapRef.current((map) => {
      if (variantRef.current === "spots") return;
      /* The fallback belongs to the run that started it: when
         that run's tab is no longer showing — the reader moved
         市区町村 → 路線 and the 路線 fit already landed — or a
         newer run superseded it, or the tab's focus was
         picked, this fit must not fire on the tab now showing
         (review round 3, finding 2). */
      if (mayApply && !mayApply()) return;
      try {
        stopCamera(map);
        let minLng = Infinity;
        let minLat = Infinity;
        let maxLng = -Infinity;
        let maxLat = -Infinity;
        for (const m of municipalitiesRef.current) {
          const point = representativePoint(m);
          if (!point) continue;
          if (point.lng < minLng) minLng = point.lng;
          if (point.lat < minLat) minLat = point.lat;
          if (point.lng > maxLng) maxLng = point.lng;
          if (point.lat > maxLat) maxLat = point.lat;
        }
        const reduceMotion =
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (Number.isFinite(minLng)) {
          if (minLng === maxLng && minLat === maxLat) {
            minLng -= 0.04;
            maxLng += 0.04;
            minLat -= 0.03;
            maxLat += 0.03;
          }
          map.fitBounds(
            [
              [minLng, minLat],
              [maxLng, maxLat],
            ],
            { padding: mapFitPadding(), maxZoom: 15, duration: reduceMotion ? 0 : 1200 },
          );
        } else {
          resetSpotsCamera(map);
        }
        /* The fallback fit landed: same spend-on-apply rule
           as the primary framing (v89 review round 2,
           finding 1). */
        onApplied?.();
      } catch {
        /* framing is best-effort; a failure leaves the current view */
      }
    });
  };
  const frameVisitedBoundsRef = useRef(frameVisitedBounds);
  frameVisitedBoundsRef.current = frameVisitedBounds;
  /* The 路線 tab's default framing (subtask 1483): fit the camera
     to the whole extent of the recorded line nearest the current
     location, so the full line is in view at the tab's default
     scale. With no recorded line to place (no rides, or none
     resolving to a geometry), a small box around the location
     itself is fitted instead — the same box the municipality
     framing uses when no boundary contains the position. Returns
     whether a location was found at all, so the caller can fall
     back to the visited bounds when there is none. Runs only
     while the 路線 tab is showing: a location read that outlives
     a tab switch must not yank the new tab's camera. */
  const frameNearestRiddenLine = async (
    onApplied?: () => void,
    mayApply?: () => boolean,
    publish?: (loc: {
      lat: number;
      lng: number;
      label: string;
      capturedAtMs: number;
    }) => boolean,
  ): Promise<boolean> => {
    const loc = await resolveCurrentLocation();
    if (!loc) {
      return false;
    }
    /* Same publish rule as frameCurrentMunicipality above
       (review rounds 4–6): a superseded run's read — or a
       held read whose capture is older than the position
       already adopted — never reaches the shared location,
       and a refused publish no longer stops the framing:
       the fit continues on the position already adopted
       while the run is still valid (round 6, P2-2). */
    const published = publish ? publish(loc) : publishSharedLocation(loc);
    const frameLoc = resolveFrameLocation(
      loc,
      published,
      currentLocRef.current,
    );
    if (!frameLoc) return true;
    const nearest = nearestRiddenLine(
      { lat: frameLoc.lat, lng: frameLoc.lng },
      riddenRowsRef.current,
      RIDDEN_LINE_GEOMETRIES,
      LINE_KEY_BY_NAME,
    );
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    withLiveMapRef.current((map) => {
      if (variantRef.current !== "lines") return;
      /* Same late-landing refusal as the municipality
         framing: a pick made while the read was out, or a
         newer 路線 run from a tab round trip, retires this
         run before it can move the camera (review round 3,
         finding 1). */
      if (mayApply && !mayApply()) return;
      try {
        stopCamera(map);
        ensureFocusListenersRef.current(map);
        drawCurrentLocationMarker(map, frameLoc.lat, frameLoc.lng, false);
        let [[minLng, minLat], [maxLng, maxLat]] = nearest?.bounds ?? [
          [frameLoc.lng - 0.04, frameLoc.lat - 0.03],
          [frameLoc.lng + 0.04, frameLoc.lat + 0.03],
        ];
        if (minLng === maxLng && minLat === maxLat) {
          minLng -= 0.04;
          maxLng += 0.04;
          minLat -= 0.03;
          maxLat += 0.03;
        }
        map.fitBounds(
          [
            [minLng, minLat],
            [maxLng, maxLat],
          ],
          { padding: mapFitPadding(), maxZoom: 15, duration: reduceMotion ? 0 : 1200 },
        );
        /* The fit landed on the camera (the lines tab guard
           above passed): the auto-fit caller spends its one
           shot here. A run the guard dropped — the reader
           left for 市区町村 while the location read was out —
           never reaches this line, so its shot survives for
           the return visit (v89 review round 2, finding 1). */
        onApplied?.();
      } catch {
        /* framing is best-effort; a failure leaves the current view */
      }
    });
    return true;
  };
  /* The record tabs' one-shot default framing: the 路線 tab fits
     the recorded line nearest the current location (subtask
     1483), the 市区町村 tab fits the municipality the reader is
     in. Returns whether a location was found at all. onApplied
     is forwarded to whichever framing runs: it fires from
     inside the live-map callback, once the fit has actually
     been issued to the camera (v89 review round 2, finding 1).
     mayApply is forwarded the same way: the framing consults
     it inside that callback, at the moment the fit would be
     issued, and drops the fit when the run is no longer valid
     (v89 review round 3, findings 1–2). publish is consulted
     earlier, the moment the location read lands: it is the
     auto-fit effect's composition of the run-currency check
     (a superseded run discards its read before it can
     rewrite the shared location the スポット tab plots
     from, round 4) and the single shared publisher (a held
     read whose capture is older than the position already
     adopted is refused the same way, rounds 5–6). A refused
     publish does not stop the framing: the fit continues on
     the adopted position while the run is still valid
     (round 6, P2-2). */
  const frameRecordDefault = (
    onApplied?: () => void,
    mayApply?: () => boolean,
    publish?: (loc: {
      lat: number;
      lng: number;
      label: string;
      capturedAtMs: number;
    }) => boolean,
  ): Promise<boolean> => {
    if (variantRef.current === "lines")
      return frameNearestRiddenLine(onApplied, mayApply, publish);
    return frameCurrentMunicipality(false, onApplied, mayApply, publish);
  };
  const frameRecordDefaultRef = useRef(frameRecordDefault);
  frameRecordDefaultRef.current = frameRecordDefault;
  /* One-shot default framing state, one shot PER record tab
     (map-framing.ts): the tabs' initializations are independent
     (v89 review round 1, finding 1) — consuming 市区町村's shot
     must not spend 路線's, or 路線 would open on whatever
     camera 市区町村 left behind. */
  const autoFitShotsRef = useRef(createAutoFitShots());
  /* Run tokens for the same framing (map-framing.ts): each
     run the effect starts takes the tab's next token, which
     supersedes the tab's earlier runs — a 路線 run started
     before a 市区町村 round trip can no longer land after
     the run the return visit started (v89 review round 3,
     finding 1). */
  const autoFitRunsRef = useRef(createAutoFitRuns());
  /* The shared location's publisher lives next to the
     spotLoc state above (v89 review round 6, P2-1): every
     adoption route funnels through publishSharedLocation,
     so the framing reads are no longer the only writers
     that move the freshness bar. */
  useEffect(() => {
    /* The スポット tab owns the camera while it is showing
       (unification, subtask 1460): its framing effect fits
       location + nearest, so the record auto-fit stays pending
       — without consuming its one shot — until a record tab is
       entered. This effect is the ONE entry point for the
       record tabs' initial framing (v89 review round 1,
       finding 3): it waits for the map AND for both ledgers
       before framing starts, so a slow ridden-lines ledger
       can no longer let an empty-ledger framing win the race
       through a side path. The variant-change effect below
       therefore does no framing of its own — when the map is
       not ready yet this effect simply stays pending and runs
       when mapReady rises. Whether the shot may run, must
       wait, or is spent without framing is autoFitGate's call
       (map-framing.ts): it reads THIS tab's own picked focus
       only, so a municipality picked on the 市区町村 tab no
       longer spends — or suppresses — the 路線 tab's first
       fit (v89 review round 2, finding 1). */
    if (variant === "spots") return;
    if (autoFitShotsRef.current.used(variant)) return;
    const gate = autoFitGate(variant, {
      mapFailed,
      mapReady: mapReady !== 0,
      visitedPending: visitedQuery.isPending,
      riddenPending: riddenQuery.isPending,
      focusPicked: {
        municipalities: focusedIdRef.current !== null,
        lines: focusedLineIdRef.current !== null,
      },
    });
    if (gate === "wait") return;
    if (gate === "spend-without-framing") {
      autoFitShotsRef.current.consume(variant);
      return;
    }
    /* The shot is spent only when a fit actually lands on the
       camera: spendShot rides into the framing functions and
       fires from inside their live-map callbacks, past their
       tab guards. A run the reader's tab switch drops on the
       way — the 路線 location read landing after a move to
       市区町村 — spends nothing, so the shot is still there
       when the reader comes back and this effect frames the
       tab then (v89 review round 2, finding 1). */
    const shotTab = variant;
    const spendShot = () => autoFitShotsRef.current.consume(shotTab);
    /* This run's token and its apply-time validity (v89
       review round 3, findings 1–2): the framing functions
       consult mayApply inside their live-map callbacks, at
       the moment the fit would be issued, and the fallback
       below consults it before firing at all. The run may
       apply only while its own tab is still showing, it is
       still that tab's latest run, and the tab's own focus
       is unpicked — a pick made while the location read was
       out, a newer run from a tab round trip, or a move to
       the other record tab each retire the run, and a run
       retired without applying spends nothing, so the shot
       survives for the next visit as before. */
    const runToken = autoFitRunsRef.current.begin(shotTab);
    const mayApply = () =>
      autoFitMayApply({
        tabShowing: variantRef.current === shotTab,
        runCurrent: autoFitRunsRef.current.isCurrent(shotTab, runToken),
        focusPicked:
          shotTab === "lines"
            ? focusedLineIdRef.current !== null
            : focusedIdRef.current !== null,
      });
    /* The same run token gates the read's publication into
       the shared location (v89 review round 4), composed
       with the single shared publisher (rounds 5–6): the
       framing functions consult publish the moment their
       location read lands, before the shared writes, so a
       run this round trip superseded discards its stale
       coordinates instead of dragging the スポット tab's
       marker and framing back to the old position — and so
       does a run held across a tab switch whose capture is
       older than the position already adopted (its own
       tab's token still names it current, so currency alone
       would admit it). Currency plus freshness are the only
       conditions: a still-current run's read is the freshest
       position even when its camera fit may not apply. */
    const publish = (loc: {
      lat: number;
      lng: number;
      label: string;
      capturedAtMs: number;
    }): boolean => {
      if (
        !autoFitMayPublishLocation({
          runCurrent: autoFitRunsRef.current.isCurrent(shotTab, runToken),
        })
      )
        return false;
      return publishSharedLocation(loc);
    };
    void frameRecordDefaultRef.current(
      spendShot,
      mayApply,
      publish,
    ).then((located) => {
      /* No Pixel position: the record tabs' initial camera is the
         visited municipalities' bounds, not the スポット tab's
         view left behind (review round 1, finding 4). The
         fallback is this run's second half, so it stands or
         falls with the run: when the reader has moved to the
         other record tab — whose own fit may already have
         landed — or this tab's focus was picked meanwhile,
         mayApply refuses and the visited-bounds fit never
         fires on the wrong tab (review round 3, finding 2).
         frameVisitedBounds re-checks mayApply inside its own
         live-map callback as well. */
      if (located) return;
      if (!mayApply()) return;
      frameVisitedBoundsRef.current(spendShot, mayApply);
    });
  }, [mapReady, visitedQuery.isPending, riddenQuery.isPending, mapFailed, variant]);
  /* Fullscreen needs a pane to own (v89 review round 2,
     finding 2): the shared flag lives in App, but the pane
     block below renders only when a tab has something to
     plot (mapPaneBlockRendered) — with zero records a record
     tab shows the empty state instead, toggle button and
     all. Carrying fullscreen in from スポット would leave
     the flag (and App's scroll lock) on with no map and no
     rendered way out, freezing the record form behind a
     scroll lock touch cannot release, so the section hands
     the flag back the moment its pane is not rendered. The
     その他 tab is App's own effect's business (it exits
     fullscreen there directly). */
  useEffect(() => {
    if (
      fullscreen &&
      !mapPaneBlockRendered(variant, totalVisited, hasRiddenLines)
    ) {
      onToggleFullscreen();
    }
  }, [fullscreen, variant, totalVisited, hasRiddenLines, onToggleFullscreen]);
  /* Follow the Pixel while the reader stays on this tab: the
     location job stores a fresh position about once a minute, so
     re-read it on the same cadence and move ONLY the blue marker
     when the position actually changed. The camera never moves
     here — re-framing stays with the auto-fit above and the
     「今いる市区町村に合わせる」 button, so a municipality the
     reader picked is never yanked away from. (The spot tab's map
     had the same mount-time-only staleness: its marker never
     followed 「Pixelの位置を取り直す」. Both maps now track the
     stored position instead of freezing it at mount.) The poll is
     only the background path now: a re-take on either tab reaches
     this map instantly through the deviceLoc adoption below and
     this tab's own re-take button, exactly like the spot map.
     The fresh position is also adopted into spotLoc, so the
     スポット tab's framing effect re-fits location + nearest
     when the reader has actually moved — the same adopt-and-
     reframe SpotListMap's own poll did (unification, subtask
     1460). On the record tabs the framing effect is gated, so
     there only the marker moves. */
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        const loc = await resolveCurrentLocation();
        if (!loc) return;
        /* Adopted through the single funnel (round 6, P2-1):
           a poll tick that resolved before a re-take adopted
           a newer position must not rewind the shared location
           with its older read either. The funnel also keeps
           the old same-coordinates early-return's effect: an
           unchanged position does not rewrite the state, so
           the spots framing effect does not re-fit its camera
           every minute. The marker is redrawn only for an
           adopted position. */
        if (!publishSharedLocation(loc)) return;
        withLiveMapRef.current((map) => {
          try {
            drawCurrentLocationMarker(map, loc.lat, loc.lng, false);
          } catch {
            /* the marker is a cue only */
          }
        });
      })();
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  /* Resolve the current location once on mount, through the same
     helper the record framing uses. If the maps' shared Pixel
     position (the deviceLoc prop) has already been adopted by
     then, it wins — it is never older than this read. (Moved
     from SpotListMap with the spots framing, unification
     subtask 1460.) */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await resolveCurrentLocation();
      if (cancelled || !resolved) return;
      if (spotLocRef.current) return;
      /* Adopted through the single funnel (round 6, P2-1):
         the first adoption records its capture time with
         the position, so a held read landing afterwards is
         measured against it. */
      publishSharedLocation(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Adopt App's shared Pixel position the moment a re-take changes
     it — the same deviceLoc wiring the spot map has, so pressing
     「Pixelの位置を取り直す」 on either tab moves this map's blue
     marker in the same instant, not up to 60 s later when the poll
     above happens to fire. Marker only, as with the poll: the
     camera stays put and a focused municipality keeps its
     highlight — camera moves on a re-take arrive separately as a
     cameraRequest (see the effect below), and framing otherwise
     belongs to the auto-fit and the
     「今いる市区町村に合わせる」 button. A re-take that returns
     the position already shown changes nothing here. The fresh
     position is also adopted into spotLoc, so the スポット tab's
     framing effect re-fits location + nearest in step with the
     re-sorted list (unification, subtask 1460). */
  const deviceLocLat = deviceLoc?.lat;
  const deviceLocLng = deviceLoc?.lng;
  const deviceLocAt = deviceLoc?.capturedAtMs;
  useEffect(() => {
    if (deviceLocLat === undefined || deviceLocLng === undefined || deviceLocAt === undefined) {
      return;
    }
    /* Adopted through the single funnel (round 6, P2-1): this
       is the re-take's path, and the re-take is exactly the
       route that used to update the shared location WITHOUT
       recording its capture time — so a held framing read
       landing afterwards rewound the スポット marker to the
       old position. The funnel compares and records the
       capture together, and keeps the same-coordinates
       early-return's effect (no state rewrite when the
       position did not move). A refused adoption draws
       nothing: the marker stays on the adopted position. */
    const adopted = {
      lat: deviceLocLat,
      lng: deviceLocLng,
      label: `Pixelの位置（${deviceAgeMinutes(deviceLocAt)}分前）`,
      capturedAtMs: deviceLocAt,
    };
    if (!publishSharedLocation(adopted)) return;
    withLiveMapRef.current((map) => {
      try {
        drawCurrentLocationMarker(map, deviceLocLat, deviceLocLng, false);
      } catch {
        /* the marker is a cue only */
      }
    });
  }, [deviceLocLat, deviceLocLng, deviceLocAt]);
  /* Camera requests for this map: fly to the re-taken position,
     zoom untouched, exactly once per request. This — not the
     marker-only adoption above — is what makes
     「Pixelの位置を取り直す」 visibly answer on this map, even
     when the fresh position is the one already shown (the marker
     adoption early-returns then) or lands off-screen. A request
     that arrives before the map is ready stays unapplied until
     mapReady rises; a municipality row tap afterwards simply
     flies the camera again and wins, as it should. */
  useEffect(() => {
    if (!cameraRequest || cameraRequest.target !== "visited") return;
    if (cameraRequest.seq <= appliedCameraSeqRef.current) return;
    if (mapReady === 0) return;
    /* A request that arrives while the スポット tab is showing
       waits for the return to a record tab (review round 1,
       finding 6): the spots framing effect owns the camera there,
       and this fly-to must not land on it. The request stays
       unapplied, so the variant change re-runs this effect. */
    if (variant === "spots") return;
    /* Keep the スポット tab's location in step (review round 1,
       finding 8): the deviceLoc adoption early-returns when the
       position is already shown, so this is the path that would
       otherwise leave spotLoc stale. The request carries the
       capture time of the re-take read that minted it, so the
       write goes through the single funnel (round 6, P2-1)
       like every other adoption: a request held while another
       route adopted a newer position must not rewind the
       shared location. The label says 0分前 — the re-take
       just read the stored position, and the adoption
       corrects the age whenever it runs. */
    publishSharedLocation({
      lat: cameraRequest.lat,
      lng: cameraRequest.lng,
      label: "Pixelの位置（0分前）",
      capturedAtMs: cameraRequest.capturedAtMs,
    });
    /* A style wait can outlive a tab switch or a newer location
       adoption. Leave requests pending on スポット, and check the
       request and capture time again when the live map will move. */
    withLiveMapRef.current(
      (map) => {
        if (
          !consumeRecordRetakeCameraRequest(
            cameraRequest,
            cameraRequestRef.current?.seq,
            appliedCameraSeqRef,
            sharedLocationPublisherRef.current,
          )
        ) {
          return;
        }
        try {
          drawCurrentLocationMarker(map, cameraRequest.lat, cameraRequest.lng, true);
        } catch {
          /* the camera move is a cue only */
        }
      },
      { when: () => variantRef.current !== "spots" },
    );
  }, [cameraRequest, mapReady, variant]);

  /* Spot sync + framing (unification, subtask 1460 — moved from
     SpotListMap): whenever the filtered set, the resolved
     location, or the live map changes — and whenever the
     スポット tab is entered — re-plot the points, redraw the
     location marker, re-pick the nearest spot (green ring), and
     fit the camera to location + nearest. Without a location the
     camera is left wherever it is (initially the whole country).
     Off the スポット tab this does nothing: the dots are hidden
     there, and the record tabs own the camera. */
  useEffect(() => {
    if (variant !== "spots") return;
    if (mapReady === 0) return;
    const map = liveMapRef.current;
    if (!map) return;
    try {
      map
        .getSource("list-spot-points")
        ?.setData(pointsFeatureCollection(filteredSpotsRef.current));
    } catch {
      /* a failed re-plot leaves the previous dots; the list below
         is unaffected */
    }
    const current = spotLocRef.current;
    if (!current) {
      return;
    }
    /* An unapplied camera request for THIS map whose target is the
       location just adopted: the re-take that minted it also
       re-picked the nearest spot, which is what re-ran this
       effect — fitting to location + nearest here would instantly
       overwrite the fly-to the reader asked for. The request wins:
       the camera pans to the current location instead (the marker
       draw below with pan), and the request is marked applied. */
    const pendingReq = cameraRequestRef.current;
    const cameraReq =
      pendingReq &&
      pendingReq.target === "spots" &&
      pendingReq.seq > appliedCameraSeqRef.current &&
      pendingReq.lat === current.lat &&
      pendingReq.lng === current.lng
        ? pendingReq
        : null;
    let best: { point: SpotMapPoint; km: number } | null = null;
    for (const p of filteredSpotsRef.current) {
      const km = haversineKm(current, p);
      if (!best || km < best.km) best = { point: p, km };
    }
    try {
      drawCurrentLocationMarker(map, current.lat, current.lng, cameraReq !== null);
      if (cameraReq) appliedCameraSeqRef.current = cameraReq.seq;
      if (!map.getSource("list-nearest")) {
        map.addSource("list-nearest", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      }
      if (!map.getLayer("list-nearest-circle")) {
        map.addLayer({
          id: "list-nearest-circle",
          type: "circle",
          source: "list-nearest",
          paint: {
            "circle-radius": 11,
            "circle-color": "#16a34a",
            "circle-opacity": 0,
            "circle-stroke-color": "#16a34a",
            "circle-stroke-width": 3,
            "circle-stroke-opacity": 1,
          },
        });
      }
      map.getSource("list-nearest")?.setData({
        type: "FeatureCollection",
        features: best
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "Point",
                  coordinates: [best.point.lng, best.point.lat],
                },
              },
            ]
          : [],
      });
      if (best && !cameraReq) {
        stopCamera(map);
        map.fitBounds(
          [
            [
              Math.min(current.lng, best.point.lng),
              Math.min(current.lat, best.point.lat),
            ],
            [
              Math.max(current.lng, best.point.lng),
              Math.max(current.lat, best.point.lat),
            ],
          ],
          { padding: mapFitPadding(56), maxZoom: 15 },
        );
      }
    } catch {
      /* framing is a cue; a failure leaves the whole-country view */
    }
    // filteredSpotsKey / spotLoc / mapReady / variant are the
    // triggers; refs carry the current values into the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredSpotsKey, spotLoc, mapReady, variant]);

  /* Camera requests the spots framing effect could not take
     (unification, subtask 1460 — moved from SpotListMap): a
     re-take that lands the SAME coordinates the map already shows
     never changes spotLoc, so the framing effect does not re-run
     — yet the reader pressed the button precisely to be flown
     back to that position after panning away by hand. This effect
     (declared after the framing effect, so a framing run in the
     same commit gets first claim) watches the request itself:
     when an unapplied request for this map matches the location
     already shown, fly to it once. While the map is not ready
     the request simply stays unapplied, and the mapReady change
     re-runs this effect to apply the latest one. A request that
     arrives while a record tab is showing waits for the return
     to the スポット tab — the old spot map would have dropped
     it with its unmount instead. */
  useEffect(() => {
    if (variant !== "spots") return;
    if (!cameraRequest || cameraRequest.target !== "spots") return;
    if (cameraRequest.seq <= appliedCameraSeqRef.current) return;
    if (mapReady === 0) return;
    const current = spotLocRef.current;
    if (
      !current ||
      current.lat !== cameraRequest.lat ||
      current.lng !== cameraRequest.lng
    ) {
      return;
    }
    const map = liveMapRef.current;
    if (!map) return;
    appliedCameraSeqRef.current = cameraRequest.seq;
    try {
      drawCurrentLocationMarker(map, cameraRequest.lat, cameraRequest.lng, true);
    } catch {
      /* the camera move is a cue only */
    }
  }, [cameraRequest, mapReady, variant]);
  /* This tab's own 「Pixelの位置を取り直す」: everything goes
     through App's map-only re-take now. On success the fresh
     position arrives via the deviceLoc prop (marker) and the
     cameraRequest prop (the fly-to above) — no direct read here,
     so the button behaves the same whatever the spot list's sort
     choice is. On failure no camera request is issued: the camera
     stays put, the previous marker stays, and a small notice next
     to the button says what happened (and that the marker on
     screen is the previous position, with its age). */
  const retakeDeviceLocation = async () => {
    setRetakeBusy(true);
    const result = await onRetakeDeviceLocation();
    setRetakeBusy(false);
    if (result.ok) {
      setRetakeNotice(null);
      return;
    }
    if (result.reason === "superseded") return;
    setRetakeNotice(
      result.reason === "stale"
        ? { kind: "stale", at: result.at ?? 0 }
        : result.reason === "none"
          ? { kind: "none" }
          : { kind: "error" },
    );
  };
  /* The municipality the reader just tapped in the ledger: its row is
     emphasized and the map flies to it. The highlight is persistent —
     it stays until another row is tapped, the map's empty area is
     tapped, or the row is deleted. focusedIdRef mirrors the state for
     callbacks (map listeners, mutation handlers) that must not read a
     stale closure. */
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const focusedIdRef = useRef<number | null>(null);
  /* The 路線 counterpart of the municipality focus above: the
     ridden-line row the reader picked (from its ledger row, or from
     a 事業者別 bar via the operator's first row). Its row carries
     the line-colored variant of the map-focused emphasis and its
     track gets the focus highlight on the map, in the line's own
     color. The two focuses are mutually
     exclusive — picking a line clears the municipality focus and
     vice versa — and a line focus is cleared the same ways a
     municipality one is (another pick, a blank map tap, deleting
     the row). */
  const [focusedLineId, setFocusedLineId] = useState<number | null>(null);
  const focusedLineIdRef = useRef<number | null>(null);
  /* The 乗った路線 list's expansion, lifted out of RiddenLinesBlock:
     a 事業者別 bar tap must open the list before its target row can
     be scrolled to. */
  const [linesExpanded, setLinesExpanded] = useState(false);
  /* Ridden-line row elements by ledger id, registered by
     RiddenLinesBlock — the scroll target for a bar tap. */
  const lineRowRefs = useRef(new Map<number, HTMLElement | null>());
  /* Set when a line was focused from a 事業者別 bar: once the list
     has expanded and the row is actually rendered, an effect below
     scrolls it into view (the reverse direction — a row tap —
     flies the map instead and never sets this). */
  const pendingLineScrollRef = useRef<number | null>(null);
  /* Each operator's first ledger row (see firstLineByOperator in
     line-focus.ts): the bar tap's jump target. Names that resolve to
     no operator are never a target. */
  const firstLineRowByOperator = firstLineByOperator(
    riddenQuery.data?.lines ?? [],
    RIDDEN_LINE_GEOMETRIES,
    LINE_KEY_BY_NAME,
  );
  /* A municipality the reader tapped on the map that is NOT in the
     ledger yet: its name is shown under the map and its boundary gets
     the same orange highlight as a visited focus — but no ledger row
     is scrolled (there is none) and nothing is recorded as visited.
     A tap that hits no known boundary is one of three states, told
     apart honestly instead of always claiming "outside the data":
     "loading" while some prefecture files are still on their way,
     "unavailable" when some failed to load, and "unknown" only once
     every prefecture has arrived — the boundary data covers all of
     Japan, so a tap outside it then (e.g. the sea) really is
     outside. */
  type TappedMunicipality =
    | { kind: "unvisited"; name: string; prefecture: string }
    | { kind: "unknown" }
    | { kind: "loading" }
    | { kind: "unavailable" };
  const [tappedMunicipality, setTappedMunicipality] = useState<TappedMunicipality | null>(null);
  /* Mirror of the latest ledger rows for the map tap listeners, which
     are registered once per map instance and must never read a stale
     closure. Kept current on every render, like clearFocusRef below. */
  const municipalitiesRef = useRef<VisitedMunicipality[]>([]);
  municipalitiesRef.current = municipalities;
  /* Set when a municipality was selected by tapping its painted shape
     on the map: once its prefecture group is expanded and the row is
     actually rendered, an effect scrolls the row into view (the
     reverse of a row tap, which flies the map to the shape). */
  const pendingRowScrollRef = useRef<number | null>(null);
  /* Sequence counter for the verify-and-correct row scroll below:
     starting (or cancelling) a scroll bumps it, and a running scroll
     loop stops as soon as its captured sequence is stale. */
  const rowScrollSeqRef = useRef(0);
  /* Ledger groups start collapsed so the page stays short as the
     ledger grows; the reader expands a prefecture to see its rows.
     Collapsed rows stay mounted (hidden) because the map mount syncs
     pin listeners to the row elements — unmounting them would break
     the map. */
  const [expandedPrefectures, setExpandedPrefectures] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const togglePrefecture = (name: string) =>
    setExpandedPrefectures((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  /* The 路線 list's operator groups (tab split, subtask 1439):
     the same lifted expansion state as the prefecture groups
     above, because a 事業者別 bar tap or a map line tap must
     open the target row's group before the row can be scrolled
     to. Owned here, rendered by RiddenLinesBlock. */
  const [expandedOperators, setExpandedOperators] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleOperator = (name: string) =>
    setExpandedOperators((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  const expandOperatorForLine = (line: RiddenLine) => {
    const operator =
      operatorOfLine(line, RIDDEN_LINE_GEOMETRIES, LINE_KEY_BY_NAME) ??
      UNKNOWN_OPERATOR_GROUP;
    setExpandedOperators((prev) =>
      prev.has(operator) ? prev : new Set(prev).add(operator),
    );
  };
  const placesKey = municipalities
    .map((m) => `${m.id}${boundaryGeometryFor(m) ? "g" : ""}`)
    .join(",");

  /* The mount effect's previous dependency snapshot, and whether
     record data arrived while the スポット tab was showing and
     the rebuild was skipped (review round 1, finding 5): the
     next record-tab entry rebuilds, and hands the new mount its
     one-shot auto-fit back. */
  const lastMountKeysRef = useRef<MapMountKeys | null>(null);
  const mapDataStaleRef = useRef(false);

  /* Mount the interactive map once the priority boundary set has
     settled (boundarySettled — until then the static preview
     covers the pane). The mount does NOT wait for the municipality
     ledger's rows: they only feed the runtime's row-selection
     sync, and on the 路線 tab — or for a reader whose only
     records are rides — they do not exist at all, yet the map
     must still come up (integrated review round 1, high: the
     mount used to abort silently when the rows were short, and
     the pane sat on ライブ地図を読み込み中 forever). Missing
     rows are padded with detached placeholders so the runtime's
     index alignment (rows[i] ↔ places[i]) survives; a detached
     element's class toggles, listeners and scrollIntoView are
     harmless no-ops. No numbered pins
     are drawn: zoomed out they piled up over the Kanto cluster and
     buried the painted fills, which are the actual collection. Places
     still register with the runtime (it frames the initial camera on
     them) via markers that render nothing. Selection runs both ways
     without pins: a ledger row tap flies the map to the shape, and a
     tap on a painted shape highlights it and scrolls the ledger to
     its row (see ensureFocusListeners). When the runtime cannot run,
     the stored static map of the same municipalities takes its
     place. The mount also waits for showMapPane (shouldMountLiveMap):
     the container it mounts into only renders under that condition,
     so a mount attempted before it — boundary data settled while
     the only record, an unlinked ride, was still in flight — found
     no container and never retried when the frame appeared
     (integrated review round 2, high). The mount carries the
     スポット tab's dots too (unification, subtask 1460): the
     filtered spot points ride along as one more overlay, hero on
     the スポット tab and hidden on the record tabs by the variant
     paint — one mount, one basemap load, for all three tabs. On
     the スポット tab the mount passes the old spot map's
     whole-country initial camera (an explicit center also skips
     the runtime's place-fit); the spots framing effect below
     owns the first fit from there. */
  useEffect(() => {
    if (!shouldMountLiveMap(mapFailed, boundarySettled, showMapPane)) {
      /* No mount here: drop any live instance instead of leaving
         it attached to a removed container (review round 1,
         finding 1 — the empty record state used to keep the
         instance while its DOM went away, and the next スポット
         visit made a second one). */
      destroyLiveMap();
      lastMountKeysRef.current = null;
      return;
    }
    const nextKeys: MapMountKeys = {
      placesKey,
      riddenLinesKey,
      mapAttempt,
      mapFailed,
      boundarySettled,
      showMapPane,
    };
    /* The mount always mounts when it runs: the record-data
       skip decision lives in the data-watch effect below, not
       here (review round 2, finding 5). */
    lastMountKeysRef.current = nextKeys;
    setBasemapReady(false);
    const container = mapContainerRef.current;
    if (!container) return;
    let cancelled = false;
    let stopWatch: (() => void) | null = null;
    /* The one failure path for this mount — the runtime's
       fatal-error callback and the stall watchdog both land here,
       via the shared control: a pre-load failure destroys the
       mount and remounts on the backoff ladder (a hung style
       request never recovers by waiting, only by starting over);
       a spent ladder shows the static fallback, and a failure
       after the basemap arrived leaves the live map mounted. This
       mount must re-earn "loaded": a remount (retry, or the
       ledger changing under a live map) starts unproven again —
       the control is created fresh per effect run for exactly
       that. */
    const failure = createMapMountFailureControl({
      retryCountRef: mapRetryCountRef,
      isCancelled: () => cancelled,
      destroyMount: () => {
        /* Pending withLiveMap waiters belonged to this mount; the
           remount's own calls re-register what it still needs. */
        cancelMapWaitersRef.current();
        destroyLiveMap();
      },
      remount: () => setMapAttempt((n) => n + 1),
      giveUp: (reason) => {
        setMapFailureReason(reason ?? null);
        setMapFailed(true);
      },
    });
    const failMap = (reason?: string) => {
      stopWatch?.();
      failure.fail(reason);
    };
    void (async () => {
      const ok = await loadHatchMaps();
      if (!ok || cancelled) {
        failMap(MAP_FAIL_NO_RUNTIME);
        return;
      }
      const rows = mappable.map((m) => {
        const el = rowRefs.current[mappableIndex.get(m.id) ?? -1];
        /* Index-aligned placeholder (see the mount comment): a
           row that is not rendered — the 路線 variant renders the
           line ledger instead — must not abort the mount. */
        return el ?? document.createElement("div");
      });
      if (cancelled) return;
      /* The fill: real boundary polygons where a shape is known (stored
         on the row or in the boundary data), and a circle at the
         representative point only for municipalities without one. */
      const overlays = [];
      /* Unvisited boundaries, line-only: every municipality in the
         nationwide boundary data (1747) that is NOT in the
         ledger gets its border drawn, so the reader can see where
         the not-yet-visited places are instead of guessing from
         blank basemap. At mount time only the prefectures loaded
         so far contribute; refreshNationwideBoundarySources keeps
         the layer complete as the background loads land. No fill —
         only a line, so it reads
         as "not visited" next to the dark-green visited fills and
         never competes with them. (Paint order is not push order:
         the overlays are sorted into the boundary hierarchy's
         order just before the mount — see OVERLAY_PAINT_ORDER.)
         The set is
         derived from the same municipalities as placesKey, so the
         mount effect re-runs (and the layer rebuilds) whenever the
         visited set changes — no new effect dependency is needed.
         Filter: a name ending in 「区」 is drawn only when it is a
         Tokyo special ward (prefecture === "東京都"); wards of other
         cities are out of scope. The asset's only 区 entries are
         the 23 Tokyo wards and the twenty designated cities are
         already stored as whole cities. The layer is
         line-only and never added to the tap hit-test layers in
         ensureFocusListeners, so it cannot intercept a tap: visited
         shapes still select, unvisited ground still names itself
         through the geometric lookup. A designated city contributes
         only its outer-boundary segments (outerBoundaryLineFeatures)
         instead of the full polygon: stroking every ward part would
         paint the same gray along the internal ward borders, where
         only the thinner ward lines belong. */
      const visitedKeys = new Set(
        municipalities.map((m) => `${m.prefecture}|${m.name}`),
      );
      /* Designated-city geometries from the boundary data, keyed
         「都道府県|市名」: the ward-line overlays below and the
         outer-boundary outlines (unvisited / visited / focus) all
         read the ward parts from here, never from a ledger row. */
      const designatedGeometries = designatedBoundaryGeometries();
      const unvisitedFeatures = buildUnvisitedAreaFeatures(visitedKeys);
      if (unvisitedFeatures.length > 0) {
        overlays.push({
          id: "unvisited-areas",
          data: {
            type: "FeatureCollection",
            features: unvisitedFeatures,
          },
          layers: [
            {
              /* Boundary hierarchy (2026-11-22): an unvisited
                 municipality's outer boundary is #64748b, ramping
                 in from zoom 7.5 (width 1.0 / opacity 0.55 at
                 zoom 9) to the full width 1.4 / opacity 0.80 at
                 zoom 10 — a solid slate line clearly stronger
                 than the dashed #94a3b8 ward lines inside a
                 designated city, and weaker than the #334155
                 prefecture borders. Below 7.5 it is not drawn at
                 all, so wide views read prefectures first. The
                 spec itself is UNVISITED_AREAS_LAYER, shared with
                 the background refresh that may add this layer
                 after the mount. */
              ...UNVISITED_AREAS_LAYER,
            },
          ],
        });
      }
      if (shaped.length > 0) {
        overlays.push({
          id: "visited-areas",
          data: {
            type: "FeatureCollection",
            features: shaped.map(({ m, geometry }) => ({
              type: "Feature",
              properties: { name: `${m.prefecture} ${m.name}` },
              geometry,
            })),
          },
          layers: [
            {
              id: "visited-areas-fill",
              type: "fill",
              source: "visited-areas",
              paint: {
                "fill-color": "#14532d",
                "fill-opacity": 0.38,
              },
            },
            /* Tap hit target for the fills, kept separate from
               the visual layer (boundary hierarchy, 2026-11-22):
               while a municipality is focused, its visual fill is
               filtered out and the focus fill replaces it, but
               this opacity-0 twin is never filtered, so the shape
               stays tappable. queryRenderedFeatures still reports
               fully transparent fills. */
            {
              id: "visited-areas-hit",
              type: "fill",
              source: "visited-areas",
              paint: {
                "fill-color": "#000000",
                "fill-opacity": 0,
              },
            },
          ],
        });
        /* The visited outline lives in its OWN source: a line layer
           on the fill source would stroke every part of a designated
           city's geometry, painting the thick dark border along the
           internal ward borders too, where the thinner green ward
           lines painted later cannot cover the width difference
           (user report, 2026-11-22). So this source holds the full
           polygon for every non-designated municipality, and for a
           designated city only its outer-boundary segments
           (outerBoundaryLineFeatures, from the boundary data like
           the ward lines; the shaped geometry is the fallback for a
           city the asset does not cover), stroked with the same
           paint as before. The fill above keeps the whole geometry
           either way. */
        const visitedOutlineFeatures: (
          | ReturnType<typeof outerBoundaryLineFeatures>[number]
          | { type: string; properties: { name: string }; geometry: GeoJsonGeometry }
        )[] = [];
        for (const { m, geometry } of shaped) {
          const label = `${m.prefecture} ${m.name}`;
          if (DESIGNATED_CITY_NAMES.has(m.name)) {
            visitedOutlineFeatures.push(
              ...outerBoundaryLineFeatures(
                designatedGeometries.get(`${m.prefecture}|${m.name}`) ?? geometry,
                label,
              ),
            );
          } else {
            visitedOutlineFeatures.push({
              type: "Feature",
              properties: { name: label },
              geometry,
            });
          }
        }
        overlays.push({
          id: "visited-areas-outlines",
          data: {
            type: "FeatureCollection",
            features: visitedOutlineFeatures,
          },
          layers: [
            {
              id: "visited-areas-outline",
              type: "line",
              source: "visited-areas-outlines",
              layout: { "line-cap": "round", "line-join": "round" },
              /* Boundary hierarchy (2026-11-22): a visited
                 municipality's outer boundary is #14532d from
                 zoom 7 (width 1.0 / opacity 0.70), reaching the
                 full width 1.5 / opacity 0.90 at zoom 10. Below
                 zoom 7 only the fills and the prefecture borders
                 show. */
              minzoom: 7,
              paint: {
                "line-color": "#14532d",
                "line-opacity": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  7,
                  0.7,
                  10,
                  0.9,
                ],
                "line-width": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  7,
                  1,
                  10,
                  1.5,
                ],
              },
            },
          ],
        });
      }
      /* Designated-city ward outlines: a designated city counts as a
         single municipality (one fill, one ledger row), but its
         boundary geometry still holds the old ward polygons as
         separate MultiPolygon parts. Stroke only the borders the
         parts share with each other (internalWardLineFeatures) as
         thin lines so the ward divisions read as information
         without thinning the city's outer boundary — pushed after
         visited-areas so it paints above the fill, and
         before the ridden lines and the focus highlight, which still
         paint above it. The line color follows the city's state,
         each in that state's hue family, so the overlay splits in
         two: unvisited cities (not in the ledger) get a slate gray
         (#94a3b8) and visited ones a deep green (#1e7a46, from the
         visited fill's #14532d); the focused state has its own
         deep-orange lines in the focus layers (see
         ensureFocusLayers). Boundary hierarchy (2026-11-22): both
         are DASHED [4, 3] at width 1.05 over the chained
         polylines internalWardLineFeatures emits, with the
         opacity ramping in only at city zoom (0 at zoom 9.5, the
         full 0.76 unvisited / 0.80 visited at zoom 10.5) — the
         dash and the late arrival are what separate a ward border
         from the city's solid outer boundary, after two rounds of
         solid-line strength adjustments (pale tints that vanished
         into the fill, then near-full opacity that floated above
         the map at wide zoom; user reports, 2026-11-22) could not.
         The split is recomputed on every mount,
         and the mount effect re-runs whenever the ledger changes,
         so a city added to or removed from the ledger switches
         color with no extra wiring. The ward-line geometry comes
         ONLY from the boundary data (wardGeometryFor): a ledger
         row's own geometry must never overwrite it, because a row
         can carry the whole city merged into a single Polygon,
         which would collapse the ward parts and leave only the
         city outline the moment the city is visited. Restricted
         to the DESIGNATED_CITY_NAMES set so multi-part
         non-designated cities （船橋市 etc.) are never mistaken for
         wards; a designated city the asset does not cover simply
         draws no ward lines. The whole-city fill keeps using the
         ledger geometry as before (boundaryGeometryFor). Counting,
         the ledger and the tap lookup are untouched: a tap on
         千葉市 still resolves to the whole city, and these layers
         are never in the tap hit-test set, so they cannot
         intercept a tap either. */
      const { visited: visitedWardFeatures, unvisited: unvisitedWardFeatures } =
        buildWardLineFeatures(visitedKeys);
      if (unvisitedWardFeatures.length > 0) {
        overlays.push({
          id: "designated-city-wards-unvisited",
          data: {
            type: "FeatureCollection",
            features: unvisitedWardFeatures,
          },
          layers: [
            {
              /* The spec is DESIGNATED_WARDS_UNVISITED_LAYER,
                 shared with the background refresh that may add
                 this layer after the mount. */
              ...DESIGNATED_WARDS_UNVISITED_LAYER,
            },
          ],
        });
      }
      if (visitedWardFeatures.length > 0) {
        overlays.push({
          id: "designated-city-wards-visited",
          data: {
            type: "FeatureCollection",
            features: visitedWardFeatures,
          },
          layers: [
            {
              id: "designated-city-wards-visited-outline",
              type: "line",
              source: "designated-city-wards-visited",
              layout: { "line-join": "round" },
              paint: {
                "line-dasharray": [4, 3],
                "line-color": "#1e7a46",
                "line-opacity": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  9.5,
                  0,
                  10.5,
                  0.8,
                ],
                "line-width": 1.05,
              },
            },
          ],
        });
      }
      if (circled.length > 0) {
        overlays.push({
          id: "visited-fill",
          data: {
            type: "FeatureCollection",
            features: circled.map((m) => {
              const point = representativePoint(m) ?? { lat: 0, lng: 0 };
              return {
                type: "Feature",
                properties: { name: `${m.prefecture} ${m.name}` },
                geometry: { type: "Point", coordinates: [point.lng, point.lat] },
              };
            }),
          },
          layers: [
            {
              id: "visited-fill-circle",
              type: "circle",
              source: "visited-fill",
              paint: {
                "circle-radius": 30,
                "circle-color": "#14532d",
                "circle-opacity": 0.22,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#14532d",
                "circle-stroke-opacity": 0.5,
              },
            },
            /* The circle twin of visited-areas-hit: the hit
               target stays unfiltered while the visual circle is
               swapped out during a point focus. */
            {
              id: "visited-fill-hit",
              type: "circle",
              source: "visited-fill",
              paint: {
                "circle-radius": 30,
                "circle-color": "#000000",
                "circle-opacity": 0,
                "circle-stroke-width": 2,
                "circle-stroke-color": "#000000",
                "circle-stroke-opacity": 0,
              },
            },
          ],
        });
      }
      /* Ridden lines on top of the fills: a white casing under each
         line's official color, thick enough to read over the grayscale
         basemap and the green fills. The focus highlight layers are
         added later (on the first focus call), so they still paint
         above the lines; the tap hit test only ever queries the
         dedicated hit layers (visited-areas-hit / visited-fill-hit),
         so the lines never intercept a municipality tap. */
      if (riddenLineFeatures.length > 0) {
        overlays.push({
          id: "visited-lines",
          data: {
            type: "FeatureCollection",
            features: riddenLineFeatures,
          },
          layers: [
            {
              id: "visited-lines-casing",
              type: "line",
              source: "visited-lines",
              layout: { "line-cap": "round", "line-join": "round" },
              filter: ["!=", ["get", "unknown"], true],
              paint: {
                "line-color": "#ffffff",
                "line-width": 5.5,
                "line-opacity": 0.55,
              },
            },
            {
              id: "visited-lines-color",
              type: "line",
              source: "visited-lines",
              layout: { "line-cap": "round", "line-join": "round" },
              filter: ["!=", ["get", "unknown"], true],
              paint: {
                "line-color": ["get", "color"],
                "line-width": 3.5,
                "line-opacity": 0.95,
              },
            },
            /* Unknown rides (a row with no section on record):
               the whole path as a thin solid line in the
               service's color — the same look as the unridden
               ghost, never a ridden section's strength. The
               reader's rule: ridden = solid, unridden and
               unknown = thin, no dashes. The layer stays
               separate from the ghost so a tap on the track
               still resolves to the ride's ledger row and a
               line focus can filter it out (see
               setNormalLineExclusion). */
            {
              id: "visited-lines-unknown",
              type: "line",
              source: "visited-lines",
              layout: { "line-cap": "round", "line-join": "round" },
              filter: ["==", ["get", "unknown"], true],
              paint: {
                "line-color": ["get", "color"],
                "line-width": 1.6,
                "line-opacity": 0.25,
              },
            },
          ],
        });
      }
      /* Unridden lines, the 路線 tab's ghost (tab split, subtask
         1439): each formal line's unridden remainder, edge by
         edge (subtask 1456 — a partially painted line keeps
         exactly its unridden stretches as the underlay), in its
         own color at a whisper of the ridden lines' strength,
         BELOW them in the paint order. The focused line's
         remainder at midway strength (subtask 1589) rides its
         OWN source since subtask 1635, filled by a focus call
         with the service's own remainder legs — it no longer
         rides along here, and a focus call trims the focused
         remainder's stretches out of the ghost's source data
         meanwhile (see setUnriddenRemainderFocus).
         The layer rides along on every mount, but its
         visibility starts at "none": the variant paint applied
         right after the mount (and on every tab switch) shows
         it only on the 路線 tab.
         The bake is gated on the result still belonging to THIS
         render's ledger (review round 3, finding 1 — the same
         condition the late-join paths use): a remount that finds
         a ghost computed for an older coverage leaves the layer
         out, and the data effect joins the current one when the
         worker's answer lands. */
      if (
        unriddenGhost &&
        unriddenGhost.coverageKey === lineCoverageKey &&
        unriddenLineFeatures.length > 0
      ) {
        overlays.push({
          id: "unridden-lines",
          data: {
            type: "FeatureCollection",
            features: unriddenLineFeatures,
          },
          layers: [
            {
              id: "unridden-lines-ghost",
              type: "line",
              source: "unridden-lines",
              layout: {
                "line-cap": "round",
                "line-join": "round",
                visibility: "none",
              },
              paint: {
                "line-color": ["get", "color"],
                "line-width": 1.6,
                "line-opacity": 0.25,
              },
            },
          ],
        });
      }
      /* Prefecture borders (boundary hierarchy, 2026-11-22): the
         segments the municipality geometries share with a
         municipality of a DIFFERENT prefecture, extracted into
         their own strongly simplified TopoJSON file (fetched with
         the priority boundary set — see boundary-data.ts) and
         chained into continuous lines — coastlines and coverage
         edges, where only one side has a municipality, are not
         included, so the lines trace land borders between
         prefectures only.
         #334155, the darkest and widest of the border grays:
         width 1.2 / opacity 0.65 at zoom 6 and below (where they
         are the ONLY borders drawn), ramping to 2.2 / 0.85 at
         zoom 10. Never in the tap hit-test set. */
      const prefectureBorderLines = getPrefectureBorderLines();
      if (prefectureBorderLines.length > 0) {
        overlays.push({
          id: "prefecture-borders",
          data: {
            type: "FeatureCollection",
            features: buildPrefectureBorderFeatures(),
          },
          layers: [PREFECTURE_BORDERS_LAYER],
        });
      }
      /* The スポット tab's dots (unification, subtask 1460): the
         filtered set, painted as the hero on the スポット tab
         and hidden on the record tabs by the variant paint (the
         ghost-spots underlay carries the unvisited dots there).
         Top of the paint order so the dots sit above the ghost
         fills and lines on their own tab. The initial visibility
         follows the mounting variant so a record-tab mount never
         flashes the dots before the variant paint lands. */
      overlays.push({
        id: "list-spot-points",
        data: pointsFeatureCollection(filteredSpotsRef.current),
        layers: [
          {
            id: "list-spot-points-circle",
            type: "circle",
            source: "list-spot-points",
            layout: {
              visibility: variantRef.current === "spots" ? "visible" : "none",
            },
            paint: {
              "circle-radius": [
                "interpolate",
                ["linear"],
                ["zoom"],
                3, 3.5,
                6, 4,
                10, 5,
                14, 6,
              ],
              "circle-color": "#ea580c",
              "circle-opacity": 0.6,
            },
          },
        ],
      });
      /* Paint order (boundary hierarchy, 2026-11-22), bottom to
         top: fills → ward lines → municipality outer boundaries →
         prefecture borders → ridden lines → spot dots → (the
         focus layers, added later at runtime, above everything).
         The overlays above were pushed in computation order, so
         they are sorted into paint order here; ids not in the
         list keep their relative order at the end. */
      const OVERLAY_PAINT_ORDER = [
        "visited-areas",
        "visited-fill",
        "designated-city-wards-unvisited",
        "designated-city-wards-visited",
        "unvisited-areas",
        "visited-areas-outlines",
        "prefecture-borders",
        "unridden-lines",
        "visited-lines",
        "list-spot-points",
      ];
      overlays.sort(
        (a, b) =>
          (OVERLAY_PAINT_ORDER.indexOf(a.id) === -1
            ? OVERLAY_PAINT_ORDER.length
            : OVERLAY_PAINT_ORDER.indexOf(a.id)) -
          (OVERLAY_PAINT_ORDER.indexOf(b.id) === -1
            ? OVERLAY_PAINT_ORDER.length
            : OVERLAY_PAINT_ORDER.indexOf(b.id)),
      );
      /* A remount replaces the previous map in this container —
         destroy it first so no detached instance keeps running
         (unification, subtask 1460: the container itself can be a
         fresh node now — e.g. returning to the スポット tab after
         a record tab with no records unmounted it — and the old
         handle would otherwise stay attached to the detached
         node). The mount cleanup already destroyed it on the
         re-run path; this is the plain-remount twin, and the
         failure control's destroyMount does the same on its own
         path. */
      destroyLiveMap();
      focusListenerMapRef.current = null;
      spotTapListenerMapRef.current = null;
      mapHandleRef.current = mountPlaceListMap(
        container,
        {
          places: mappable.map((m) => {
            const point = representativePoint(m) ?? { lat: 0, lng: 0 };
            return {
              label: `${m.prefecture} ${m.name}`,
              lat: point.lat,
              lng: point.lng,
            };
          }),
          rows,
          /* No pins on the map (see the mount comment above). */
          marker: () => "",
          baseStyle: "grayscale",
          /* The スポット tab's whole-country initial camera
             (unification, subtask 1460): without it the runtime
             place-fits the municipalities, or opens on [0,0]
             zoom 2 with none — the old spot map mounted on the
             whole country. An explicit center also skips the
             runtime's place-fit, so the spots framing effect
             owns the first fit from there. Only at mount time:
             tab switches never remount, so the record tabs'
             place-fit is untouched. */
          ...(variantRef.current === "spots"
            ? spotsInitialCamera(container.clientWidth)
            : {}),
          ...(overlays.length > 0 ? { overlays } : {}),
        },
        failMap,
      );
      /* Attach the tap listeners (painted-shape select / blank-tap
         clear, and the spot dots' select) right away, not only
         after the first row tap, so tapping a shape works from
         the start. */
      if (mapHandleRef.current) {
        withLiveMapRef.current((map) => {
          /* The live map for the spots sync + framing effect
             below (unification, subtask 1460). */
          liveMapRef.current = map;
          try {
            ensureFocusListenersRef.current(map);
          } catch {
            /* listeners retry on the next focus call */
          }
          try {
            attachSpotTapRef.current(map);
          } catch {
            /* listeners retry on the next focus call */
          }
          /* The spot list's map-center sort reads the live camera
             through this getter (moved from SpotListMap with the
             map, unification subtask 1460). */
          if (centerGetterRef) {
            centerGetterRef.current = () => {
              try {
                const c = map.getCenter();
                return { lat: c.lat, lng: c.lng };
              } catch {
                return null;
              }
            };
          }
          /* The ghost spot points join the map BEFORE the variant
             paint runs (unification, subtask 1460): the paint
             hides the ghost layer on the スポット tab, and a
             layer added after the paint would arrive visible and
             double the hero dots. */
          try {
            ensureGhostSpotPoints(map, ghostSpotPointFeaturesRef.current);
          } catch {
            /* the ghost is an underlay; its data effect retries */
          }
          /* The unridden-lines ghost joins the same way, before
             the variant paint (subtask 1457, review round 2):
             its geometry is computed off the UI thread, so the
             mount overlays usually ran before it existed — this
             adds the layer with whatever has landed, and the
             data effect below refreshes it as more arrives. A
             layer added after the paint would keep the mount's
             "none" visibility even on the 路線 tab. The result
             is read from the ref at this moment and applied only
             while it belongs to the current ledger (review
             round 3, finding 1 — the same condition the data
             effect's waiter uses). */
          try {
            applyUnriddenLineGhostLatest(
              map,
              unriddenGhostRef.current,
              lineCoverageKeyRef.current,
            );
          } catch {
            /* the ghost is an underlay; its data effect retries */
          }
          /* The mount bakes hero-strength paint for all overlay
             families; the CURRENT variant's hero / ghost split is
             applied over it (tab split, subtask 1439). A remount
             under the 路線 tab must not flash the municipality
             hero first. */
          try {
            applyVariantPaint(map, variantRef.current);
          } catch {
            /* a half-torn-down map may refuse; the variant effect
               re-applies on the next switch */
          }
          /* The rebuilt layers also lost the current selection's
             unridden-remainder emphasis (Codex review batch
             round 1, finding 3): the remainder layer was created
             with its empty source, and when the ghost result
             did not change, the ghost effect never re-runs to
             restore it — the row would stay selected with its
             emphasis gone. Re-apply from the latest selection,
             through the routine the ghost effect shares. */
          try {
            applyUnriddenRemainderFocus(map);
          } catch {
            /* the emphasis is a reading aid; the row emphasis
               still marks the selection */
          }
          /* The map is live: the default framing (fit to the
             municipality the reader is in, or location + nearest
             on the スポット tab) may run now. */
          setMapReady((n) => n + 1);
          /* Anything that asked for a map before this one was
             ready (a boundary refresh that raced the mount, most
             often) is applied to it now, with the latest data. */
          flushMapWaitersRef.current();
        });
        /* Stall watchdog: if the basemap never arrives (a hung style
           request on a flaky connection fires neither load nor error,
           so onUnavailable never runs), the failure path remounts on
           the backoff ladder and only then fails over to the stored
           static map, instead of leaving a blank pane. */
        stopWatch = watchBasemapLoad(
          () => mapHandleRef.current?.getMap() ?? null,
          () => {
            failure.markLoaded();
            setBasemapReady(true);
            /* The basemap arriving is the other "a map is ready"
               signal: wake any waiters whose poll already ran
               out, so late boundary data still reaches this map. */
            flushMapWaitersRef.current();
          },
          () => failMap(MAP_FAIL_TIMEOUT),
        );
      }
    })();
    return () => {
      cancelled = true;
      stopWatch?.();
      cancelMapWaitersRef.current();
      /* The map itself goes away with this effect run — a remount
         rebuilds it, and leaving for the その他 tab (which
         unmounts the section) must not leave a detached instance
         running (review round 1, finding 1). */
      destroyLiveMap();
    };
    // mapAttempt is the automatic-retry nonce: a retry, the
    // record-data watch below, and the stale-flag consumption on
    // record-tab entry all bump it to rebuild. boundarySettled
    // gates the first mount on the priority boundary set; later
    // boundary arrivals do NOT remount (the refresh effect below
    // updates the nationwide sources in place). showMapPane is
    // a gate of the mount itself (see shouldMountLiveMap): when it
    // flips after the boundary set settled — the first ride record
    // arriving, or the first spot points on the スポット tab — the
    // mount must run then, not sit on the earlier no-container
    // pass. placesKey / riddenLinesKey are deliberately NOT
    // dependencies here (review round 2, finding 5): the
    // record-data watch below owns them, so a data arrival never
    // re-runs this effect — and its cleanup never destroys the
    // map the reader is using. Refs, index, shaped and circled
    // are derived from those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapFailed, mapAttempt, boundarySettled, showMapPane]);

  /* Record-data arrivals, watched on their own (review round 2,
     finding 5): a record-data arrival while the スポット tab is
     showing must not rebuild the map the reader is using
     (review round 1, finding 5) — but the old code decided that
     inside the mount effect, and React runs the previous run's
     cleanup first, so the map was destroyed before the new run
     could decide to skip. The decision now lives here, watching
     only placesKey / riddenLinesKey: a record-only arrival on
     the スポット tab marks the data stale and rebuilds on the
     next record-tab entry instead, and any other record-data
     change bumps the retry nonce so the mount effect rebuilds.
     The mount effect no longer watches these keys at all, so a
     data arrival never runs its cleanup. This effect is declared
     after the mount effect, so the mount's first run has already
     established lastMountKeysRef when this first runs. */
  useEffect(() => {
    const nextKeys: MapMountKeys = {
      placesKey,
      riddenLinesKey,
      mapAttempt,
      mapFailed,
      boundarySettled,
      showMapPane,
    };
    const decision = decideSpotDataRemount(
      lastMountKeysRef.current,
      nextKeys,
      variantRef.current,
      mapHandleRef.current?.getMap() != null,
    );
    if (decision === "none") return;
    lastMountKeysRef.current = nextKeys;
    if (decision === "skip") {
      mapDataStaleRef.current = true;
      return;
    }
    setMapAttempt((n) => n + 1);
    // placesKey captures the municipality set plus each one's
    // shape availability; riddenLinesKey captures the path ranges
    // and styles the overlay paints.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey, riddenLinesKey]);

  /* Background boundary arrivals grow the nationwide sources
     (unvisited outlines, unvisited ward lines, prefecture
     borders) in place — no remount, so the camera and the
     visited shapes stay put while the rest of the country fills
     in behind them. */
  useEffect(() => {
    if (boundaryVersion === 0 || !boundarySettled) return;
    withLiveMapRef.current((map) => {
      try {
        refreshNationwideBoundarySources(map, municipalitiesRef.current);
      } catch {
        /* a half-torn-down map may refuse; the next mount rebuilds */
      }
    });
  }, [boundaryVersion, boundarySettled]);

  /* Tab split (subtask 1439) and unification (subtask 1460): a
     switch between the map tabs changes ONLY the variant — the
     section, the map, and every loaded dataset stay exactly
     where they are, and the hero / ghost paint is re-applied to
     the live layers. The mount applies the same paint for its
     own variant, so this effect's first run (mount-time variant)
     is a repeat. The switch also swaps the tab's camera and tap
     ownership: entering a record tab from the スポット tab
     re-frames to that tab's default (the municipality the
     reader is in, or the nearest recorded line on the 路線 tab
     — subtask 1483; the fresh mount used to do that), entering
     the スポット tab hands
     the camera to the spots framing effect below and clears any
     record focus (its ledger is not rendered there), and the
     nearest-spot ring is cleared off the スポット tab. Between
     the two record tabs the camera stays put, as before. The
     map is re-measured too: at xl the record tabs lay the pane
     out inside the grid while the スポット tab keeps it full
     width, so the container's size changes with the variant. */
  useEffect(() => {
    /* This callback closes over the variant of THIS run. A style
       wait can outlive a second switch, and the held variant
       would then paint the wrong tab — a スポット paint landing
       on the 路線 tab shows the hero spot dots there (review
       round 2, finding 7). The guard drops the waiter when the
       reader has already left this variant; the new tab's own
       run re-issues the paint, the resize, and the ring clear. */
    withLiveMapRef.current((map) => {
      try {
        map.resize();
      } catch {
        /* a half-torn-down map may refuse; the mount sizes it */
      }
      try {
        applyVariantPaint(map, variant);
      } catch {
        /* a half-torn-down map may refuse; the next mount
           applies the then-current variant itself */
      }
      if (variant !== "spots") {
        /* The nearest-spot ring belongs to the スポット tab
           alone; leaving it would strand a green ring over the
           record map with no spot framing to explain it. */
        try {
          map
            .getSource("list-nearest")
            ?.setData({ type: "FeatureCollection", features: [] });
        } catch {
          /* the ring is a cue only */
        }
      }
      /* No framing happens here (v89 review round 1,
         finding 3): the auto-fit effect above is the single
         entry point for the record tabs' initial camera, and
         it spends a tab's shot only once the map is live and
         the ledgers it needs have landed. This effect used to
         frame a spots → record switch itself when the map was
         already live — a second entry that never checked the
         ridden-lines ledger, so a slow ledger let the initial
         framing settle on an empty one. */
      /* Dropping this waiter leaves the tab's auto-fit shot
         unconsumed, so the auto-fit effect still frames when
         the map becomes ready — nothing is lost, only deferred. */
    }, { when: () => variantRef.current === variant });
    if (variant === "spots") {
      /* The next record entry gets its one-shot auto-fit back
         (review round 1, finding 4: the flag used to stick after
         the first entry, so re-entering a record tab never
         re-framed). */
      autoFitShotsRef.current.reset();
      /* A record focus would linger highlighted over the ghost
         fills with no ledger row to explain it — the fresh
         mount used to drop it with the map. */
      clearFocusRef.current();
      setTappedMunicipality(null);
      /* Without a Pixel position the spots framing effect leaves
         the camera alone — restore the スポット tab's
         whole-country view instead of keeping the record tab's
         (review round 1, finding 4). With a position the
         framing effect owns the camera and this stays out of its
         way. */
      if (!spotLocRef.current) {
        /* The reset belongs to the スポット tab alone: entering
           the スポット tab during a style load and switching
           straight to 路線 must not let the late reset drag the
           路線 map back to the whole-country view (review round
           2, finding 4). The guard drops the waiter then; the
           路線 tab keeps its camera, and the next スポット
           entry re-issues the reset. */
        withLiveMapRef.current(
          (map) => {
            try {
              resetSpotsCamera(map);
            } catch {
              /* framing is a cue; a failure leaves the current view */
            }
          },
          { when: () => variantRef.current === "spots" },
        );
      }
    }
    /* Record data that arrived while the スポット tab was showing
       left the map stale (review round 1, finding 5): rebuild it
       now that a record tab is showing, and hand the new mount
       its one-shot auto-fit back so it frames the current
       municipality instead of opening on the runtime's default
       place-fit. The auto-fit effect re-runs for the new mount
       (mapReady falls and rises), so the fresh mount frames
       through the single entry point. */
    if (variant !== "spots" && mapDataStaleRef.current) {
      mapDataStaleRef.current = false;
      autoFitShotsRef.current.reset();
      setMapAttempt((n) => n + 1);
    }
  }, [variant]);

  /* Entering the 路線 tab opens its list: the list is that tab's
     main content below the map, and a map line tap needs its
     rows laid out before it can scroll to one. Collapsing it by
     hand afterwards still works — this only runs on the switch. */
  useEffect(() => {
    if (variant === "lines") setLinesExpanded(true);
  }, [variant]);

  /* Ghost spot points arriving after the mount (the shared
     spotPoints query landing, or a visit toggle changing the
     unvisited set) refresh the ghost source in place. */
  useEffect(() => {
    if (!boundarySettled) return;
    withLiveMapRef.current((map) => {
      try {
        ensureGhostSpotPoints(map, ghostSpotPointFeatures);
      } catch {
        /* the ghost is an underlay; a failed refresh leaves the
           previous dots, and the next mount rebuilds them */
      }
    });
  }, [ghostSpotPointFeatures, boundarySettled]);

  /* The unridden-lines ghost is computed in a Web Worker
     (subtask 1457, review round 3), so it normally lands after
     the mount: join the live map here — or refresh the source
     in place when the coverage moved under it — and re-apply
     the variant paint right after, as the mount callback does,
     so a layer joining on the 路線 tab arrives visible and one
     joining elsewhere stays hidden.
     The waiter below deliberately reads the result from the
     ref AT EXECUTION TIME (review round 3, finding 1): the
     round-2 cut captured the features when the effect ran, so
     a waiter registered while the ghost was still empty could
     fire after the real features had been applied and wipe the
     source back to empty. Reading the latest result when the
     waiter fires makes a late run apply the CURRENT ghost, and
     applyUnriddenLineGhostLatest refuses it outright if its
     ledger has already moved on. */
  useEffect(() => {
    if (!boundarySettled) return;
    withLiveMapRef.current((map) => {
      try {
        applyUnriddenLineGhostLatest(
          map,
          unriddenGhostRef.current,
          lineCoverageKeyRef.current,
        );
        applyVariantPaint(map, variantRef.current);
        /* A focus set before the ghost landed found no
           remainder layer to select (subtask 1589): re-apply
           the current focus's remainder emphasis now that the
           layer exists, through the routine the mount
           completion shares. No focus — nothing to re-apply;
           the layer keeps its empty source. */
        applyUnriddenRemainderFocus(map);
      } catch {
        /* the ghost is an underlay; a failed refresh leaves the
           previous shape, and the next mount rebuilds it */
      }
    });
  }, [unriddenGhost, boundarySettled]);

  /* Runs `fn` with the live MapLibre map as soon as it exists. The map
     handle is stored at mount time, but the underlying map only appears
     once the runtime is ready, so poll briefly first. If the poll runs
     out with no map yet, the call is NOT dropped (the pre-2026-11-23
     behavior, which stranded boundary refreshes that raced a slow
     map): the waiter stays registered until flushMapWaiters retries
     it when a map signals readiness, or the mount teardown cancels
     it. A waiter's `fn` always reads the latest state when it finally
     runs, so a late run applies current data, not a stale snapshot.
     The same registration covers the style wait: when the map exists
     but its style is still loading, the delayed run stays
     cancellable and only fires while that map is still the live one
     (review round 1, finding 7) — a remount must not let the old
     map's draw land afterwards.
     A waiter may also carry a `when` guard (review round 2,
     findings 4/6/7): a style wait or a map poll can outlive a tab
     switch, and a stale tab's camera reset, camera move, or paint
     must not land on the tab the reader is looking at now. The
     guard is checked at the moment fn would run — not when the
     waiter is enqueued — so a tab-scoped waiter is dropped
     instead of firing late. A waiter without a guard is
     tab-agnostic (boundary data, ghost points, the mount itself)
     and always runs; the new tab's own effect re-issues whatever
     a dropped waiter would have done. */
  type WithLiveMapOptions = {
    /* Run fn only while this returns true, checked at execution
       time. Typical shape: () => variantRef.current === "spots"
       for work that belongs to one tab. */
    when?: () => boolean;
  };
  const withLiveMap = (
    fn: (map: MapLibreLike) => void,
    options?: WithLiveMapOptions,
  ) => {
    const waiter: MapWaiter = {
      fn,
      cancelled: false,
      timer: null,
      retry: () => {},
    };
    mapWaitersRef.current.add(waiter);
    let attempts = 0;
    /* fn runs at most once per waiter, however many times the
       style wait is armed or the waiter is flushed. */
    let settled = false;
    /* The style wait is armed at most once: a flush while it is
       pending must not register a second delayed run. */
    let styleWaitArmed = false;
    /* The single place fn runs from: the immediate path, the
       style-wait run, and the poll that found a map all land
       here, so the live-map identity check and the tab guard
       apply to every one of them. A dropped waiter is settled
       and forgotten, never retried. */
    const runFn = (map: MapLibreLike) => {
      if (settled || waiter.cancelled) return;
      settled = true;
      mapWaitersRef.current.delete(waiter);
      if (mapHandleRef.current?.getMap() !== map) return;
      if (options?.when && !options.when()) return;
      fn(map);
    };
    const tryOnce = () => {
      if (waiter.cancelled || settled) {
        mapWaitersRef.current.delete(waiter);
        return;
      }
      const map = mapHandleRef.current?.getMap() ?? null;
      if (map) {
        if (map.isStyleLoaded()) {
          runFn(map);
        } else {
          /* The style is still loading: keep the waiter
             registered (review round 1, finding 7) so a teardown
             cancels the delayed run, and only run fn while this
             map is still the live one — a remount in between must
             not let the old map's draw land on the new one, nor
             let the old map be written back into liveMapRef. */
          if (styleWaitArmed) return;
          styleWaitArmed = true;
          const run = () => runFn(map);
          map.once("load", run);
          waiter.timer = setTimeout(run, 2000);
        }
        return;
      }
      attempts += 1;
      if (attempts <= 20) {
        waiter.timer = setTimeout(tryOnce, 150);
      }
      /* Poll exhausted: stay registered (see the header comment). */
    };
    waiter.retry = () => {
      if (waiter.cancelled || settled || styleWaitArmed) return;
      if (waiter.timer) clearTimeout(waiter.timer);
      attempts = 0;
      tryOnce();
    };
    tryOnce();
  };
  /* Refs to the latest withLiveMap / ensureFocusListeners, for the
     mount effect above: it runs with the closure of the render that
     first mounted the map, while these helpers are re-created every
     render. Same pattern as clearFocusRef below. */
  const withLiveMapRef = useRef(withLiveMap);
  withLiveMapRef.current = withLiveMap;

  /* Wake every registered waiter: called when a map signals it is
     ready (the mount's first live callback, the basemap watchdog),
     so calls that arrived before the map existed are applied to it
     now. Waiters whose map still is not there go back to polling. */
  const flushMapWaiters = () => {
    for (const waiter of [...mapWaitersRef.current]) waiter.retry();
  };
  const flushMapWaitersRef = useRef(flushMapWaiters);
  flushMapWaitersRef.current = flushMapWaiters;

  /* Drop every waiter without running it: the mount they were
     waiting for is being torn down, and the remount re-issues
     whatever it still needs against the fresh map. */
  const cancelMapWaiters = () => {
    for (const waiter of mapWaitersRef.current) {
      waiter.cancelled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    mapWaitersRef.current.clear();
  };
  const cancelMapWaitersRef = useRef(cancelMapWaiters);
  cancelMapWaitersRef.current = cancelMapWaiters;

  /* Clears the LINE focus only: the ridden-line row emphasis and
     the track highlight. Used wherever a municipality focus
     takes over, and when the focused line's row is deleted. */
  const clearLineFocus = () => {
    focusedLineIdRef.current = null;
    setFocusedLineId(null);
    pendingLineScrollRef.current = null;
    const map = mapHandleRef.current?.getMap() ?? null;
    if (map) {
      try {
        clearFocusLineGeometry(map, remainderGhostContext());
      } catch {
        /* the map may already be gone; the row emphasis is cleared */
      }
    }
  };
  /* Kept in a ref so callbacks defined earlier (the municipality
     focus paths) always call the latest version. */
  const clearLineFocusRef = useRef(clearLineFocus);
  clearLineFocusRef.current = clearLineFocus;

  /* Clears the focus highlight everywhere: the ledger row emphasis and
     the focus geometry on the map — for BOTH focuses (municipality
     and line). Used by the map blank-tap listener
     and when the focused row is deleted. */
  const clearFocus = () => {
    focusedIdRef.current = null;
    setFocusedId(null);
    setTappedMunicipality(null);
    clearLineFocus();
    /* A row scroll still heading for the cleared row stops too. */
    rowScrollSeqRef.current += 1;
    const map = mapHandleRef.current?.getMap() ?? null;
    if (map) {
      try {
        clearFocusGeometry(map);
      } catch {
        /* the map may already be gone; the row emphasis is cleared */
      }
    }
  };
  /* Kept in a ref so the map listeners below always call the latest
     version without re-registering. */
  const clearFocusRef = useRef(clearFocus);
  clearFocusRef.current = clearFocus;

  /* Map-shape tap: the reverse of a ledger row tap. The tapped
     municipality gets the same persistent highlight (orange geometry
     on the map, emphasized row), its prefecture group expands if
     folded, and the ledger scrolls to its row. The camera also fits
     the whole municipality into the frame, exactly as a row tap
     frames it (subtask 1584, the reader's request of 2026-11-26:
     a tapped feature lands whole and centered on the map); before
     that request the camera deliberately stayed put. The fit needs
     no gate of its own: the pick itself is what the entry
     auto-fit's apply-time check reads (focusPicked), so a framing
     run still in flight when the tap lands refuses its own fit
     instead of overwriting this one, and an auto-fit animation
     already running is stopped by the fit's stopCamera. */
  const focusMunicipalityFromMap = (m: VisitedMunicipality) => {
    focusedIdRef.current = m.id;
    setFocusedId(m.id);
    setTappedMunicipality(null);
    /* The two focuses are mutually exclusive (see the state note). */
    clearLineFocusRef.current();
    setExpandedPrefectures((prev) =>
      prev.has(m.prefecture) ? prev : new Set(prev).add(m.prefecture),
    );
    pendingRowScrollRef.current = m.id;
    /* A map tap supersedes any row scroll still correcting toward
       a previous target: stop that loop now, instead of letting it
       keep dragging the page while this tap's group expansion is
       still rendering (the pending-scroll effect only starts the
       new loop once the row is laid out). The line side's
       focusLineFromMap bumps the same counter for the same
       reason. */
    rowScrollSeqRef.current += 1;
    const geometry = boundaryGeometryFor(m);
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    withLiveMap((map) => {
      /* A later tap — or leaving for the スポット tab, which
         clears the focus — supersedes this one: never paint a
         stale highlight for a row the reader has already left
         (review round 1, finding 6). */
      if (variantRef.current !== "municipalities" || focusedIdRef.current !== m.id) return;
      try {
        setFocusGeometry(map, geometry, m);
        /* Fit the whole municipality into the frame, with the
           row tap's framing (focusMunicipality): same padding,
           same maxZoom, same duration. A municipality with no
           known boundary flies to its representative point
           instead; one with neither keeps the camera where it
           is and lets the highlight speak. */
        const plan = focusCameraPlan(
          boundsForMunicipality(m),
          representativePoint(m),
        );
        if (plan.kind === "fit-bounds") {
          stopCamera(map);
          map.fitBounds(plan.bounds, {
            padding: mapFitPadding(),
            maxZoom: 15,
            duration: reduceMotion ? 0 : 1200,
          });
        } else if (plan.kind === "fly-to-point") {
          stopCamera(map);
          map.flyTo({
            center: [plan.center.lng, plan.center.lat],
            zoom: plan.zoom,
            duration: reduceMotion ? 0 : 1200,
          });
        }
      } catch {
        /* a failed highlight or camera move leaves the row emphasis as the cue */
      }
    });
  };
  /* Kept in a ref so the map listeners below always call the latest
     version without re-registering. */
  const focusFromMapRef = useRef(focusMunicipalityFromMap);
  focusFromMapRef.current = focusMunicipalityFromMap;

  /* Map tap on a municipality that is NOT in the ledger yet: clear
     any visited focus, show its name under the map, and paint its
     boundary with the same orange highlight — the reader is already
     looking at the place, so the camera does not move, and nothing
     is recorded as visited. */
  const showUnvisitedMunicipality = (hit: {
    name: string;
    prefecture: string;
    geometry: GeoJsonGeometry;
  }) => {
    focusedIdRef.current = null;
    setFocusedId(null);
    clearLineFocusRef.current();
    /* A row scroll still heading for a cleared row stops too. */
    rowScrollSeqRef.current += 1;
    setTappedMunicipality({ kind: "unvisited", name: hit.name, prefecture: hit.prefecture });
    withLiveMap((map) => {
      /* The highlight belongs to the 市区町村 tab alone: if the
         reader has switched away while this draw was waiting, it
         must not paint over the new tab (review round 1,
         finding 6). */
      if (variantRef.current !== "municipalities") return;
      try {
        /* A tapped designated city also gets its ward lines in the
           focus color, and its thick focus outline follows the
           outer boundary only; any other focus clears them
           (setFocusPolygon empties the wards source when no
           features are passed). The whole-city highlight uses the
           tapped geometry, but the ward lines and the outer
           boundary come from the boundary data only
           (wardGeometryFor), shared with the visited-focus path —
           a geometry resolved through the ledger can be a merged
           single Polygon with no ward parts left. */
        const wardGeometry = wardGeometryFor(hit.prefecture, hit.name);
        setFocusPolygon(
          map,
          hit.geometry,
          wardGeometry
            ? internalWardLineFeatures(wardGeometry, `${hit.prefecture} ${hit.name}`)
            : undefined,
          wardGeometry
            ? outerBoundaryLineFeatures(wardGeometry, `${hit.prefecture} ${hit.name}`)
            : undefined,
          `${hit.prefecture} ${hit.name}`,
        );
      } catch {
        /* a failed highlight leaves the name label as the cue */
      }
    });
  };
  const showUnvisitedRef = useRef(showUnvisitedMunicipality);
  showUnvisitedRef.current = showUnvisitedMunicipality;

  /* Map tap outside every known boundary: clear the highlight and
     say so under the map instead of leaving the reader guessing.
     Which of the three messages shows depends on the boundary
     store's state at tap time (see the TappedMunicipality comment):
     a prefecture that simply has not loaded yet must not read as
     "outside the data". */
  const showUnknownTap = () => {
    clearFocusRef.current();
    if (isBoundaryCoverageComplete()) {
      setTappedMunicipality({ kind: "unknown" });
    } else if (isBoundaryLoadFailed()) {
      setTappedMunicipality({ kind: "unavailable" });
    } else {
      setTappedMunicipality({ kind: "loading" });
    }
  };
  const showUnknownTapRef = useRef(showUnknownTap);
  showUnknownTapRef.current = showUnknownTap;

  /* Attaches the map tap listeners to a live map, once per map
     instance. A press that turns into a drag also produces a click on
     release, so the press is snapshotted (canvas point + camera
     center) and the click counts only when the POINTER stayed put —
     the camera may still be settling from the tab's own auto-fit
     when a genuine tap lands, and that must not eat the tap
     (tap-guard.ts, subtask 1580). On a tap, the painted layers are hit-tested: a
     tap on a visited shape selects that municipality (highlight +
     scroll to its ledger row); a tap on an unvisited shape names
     that municipality instead (highlight + name label, no row, no
     visit recorded); a tap outside every known boundary clears the
     highlight and says so. */
  const ensureFocusListeners = (map: MapLibreLike) => {
    if (focusListenerMapRef.current === map) return;
    focusListenerMapRef.current = map;
    /* A fresh map instance (remount after the ledger changed) loses
       the current-location marker's source; redraw it from the last
       shown position, without moving the camera this time. */
    const loc = currentLocRef.current;
    if (loc) {
      try {
        drawCurrentLocationMarker(map, loc.lat, loc.lng, false);
      } catch {
        /* the marker is a cue only */
      }
    }
    const rememberPress = (e: unknown) => {
      let center: { lng: number; lat: number } | null = null;
      try {
        center = map.getCenter();
      } catch {
        center = null;
      }
      pressSnapshotRef.current = { point: pointFromMapEvent(e), center };
    };
    map.on("mousedown", rememberPress);
    map.on("touchstart", rememberPress);
    map.on("click", (e) => {
      const press = pressSnapshotRef.current;
      pressSnapshotRef.current = null;
      let center: { lng: number; lat: number } | null = null;
      try {
        center = map.getCenter();
      } catch {
        center = null;
      }
      if (!isTapAfterPress(press, { point: pointFromMapEvent(e), center })) {
        return;
      }
      /* Unification (subtask 1460): on the スポット tab the
         municipality fills and the lines are ghosts, and their
         ledgers are not rendered — a tap there must not focus
         anything. The spot dots' own handler owns the click. */
      if (variantRef.current === "spots") return;
      /* 路線 tab (tab split, subtask 1439): the lines are the
         hero here, so the painted tracks ARE the tap target — a
         tap on a track focuses its ledger row (track highlight +
         the list scrolls to the row + the camera fits the whole
         line, subtasks 1584/1589). Municipality
         shapes stay untappable on this tab: their ledger is not
         rendered here, so focusing one would strand the reader
         with a highlight and no row. The unridden ghost tracks
         are not hit-tested either (they have no row); a tap that
         hits no ridden track is the usual blank tap. */
      if (variantRef.current === "lines") {
        if (e?.point !== undefined && e?.point !== null) {
          try {
            /* The focus highlight layers are hit-tested too: a
               focused line's normal paint is filtered out, so
               without them the highlighted track itself could
               never be tapped again (integrated review round 1,
               medium). */
            const layers = [
              "visited-lines-color",
              "visited-lines-unknown",
              "visited-lines-casing",
              "visited-line-focus-color",
              "visited-line-focus-casing",
              "visited-line-focus-halo",
            ].filter((id) => map.getLayer(id));
            if (layers.length > 0) {
              /* The painted tracks are only a few pixels wide —
                 too thin a target for a finger — so the hit test
                 uses a small box around the tap point, the same
                 allowance the spot map gives its dots. Features
                 come back top-most first; the first that resolves
                 to a ledger row wins. Resolution is by the
                 feature's serviceId (see lineRowForPaintedFeature):
                 services sharing one formal line stay apart. */
              const pt = e.point as { x: number; y: number };
              const R = 12;
              const features = map.queryRenderedFeatures(
                [
                  [pt.x - R, pt.y - R],
                  [pt.x + R, pt.y + R],
                ],
                { layers },
              );
              for (const f of features) {
                const key = f.properties?.key;
                if (typeof key !== "string") continue;
                const rawServiceId = f.properties?.serviceId;
                const row = lineRowForPaintedFeature(
                  riddenRowsRef.current,
                  lineCoverageRef.current.perServiceLegs,
                  {
                    key,
                    serviceId:
                      typeof rawServiceId === "string" ? rawServiceId : null,
                  },
                );
                if (row) {
                  focusLineFromMapRef.current(row);
                  return;
                }
              }
            }
          } catch {
            /* a failed hit test falls through to the blank tap */
          }
        }
        clearFocusRef.current();
        return;
      }
      if (e?.point !== undefined && e?.point !== null) {
        try {
          /* Hit-test the dedicated opacity-0 hit layers, NOT the
             visual fills: while a municipality is focused its
             visual fill is filtered out (focus fill switching),
             and it must stay tappable. */
          const layers = ["visited-areas-hit", "visited-fill-hit"].filter(
            (id) => map.getLayer(id),
          );
          if (layers.length > 0) {
            const features = map.queryRenderedFeatures(e.point, { layers });
            for (const f of features) {
              const name = f.properties?.name;
              if (typeof name !== "string") continue;
              const hit = municipalityRowForPaintedName(
                municipalitiesRef.current,
                name,
              );
              if (hit) {
                focusFromMapRef.current(hit);
                return;
              }
            }
          }
        } catch {
          /* a failed hit test falls through to the boundary lookup */
        }
        /* No visited shape under the tap: test the tapped ground
           coordinate against the known boundaries (ledger shapes
           first, then the nationwide boundary data) — an
           unvisited municipality names itself instead of just
           clearing the highlight. */
        const lngLat = e?.lngLat;
        if (
          lngLat &&
          typeof lngLat.lng === "number" &&
          typeof lngLat.lat === "number"
        ) {
          const hit = findMunicipalityAt(lngLat.lat, lngLat.lng, municipalitiesRef.current);
          if (hit) {
            const visited = municipalitiesRef.current.find(
              (m) => m.prefecture === hit.prefecture && m.name === hit.name,
            );
            if (visited) {
              focusFromMapRef.current(visited);
            } else {
              showUnvisitedRef.current(hit);
            }
            return;
          }
          showUnknownTapRef.current();
          return;
        }
      }
      clearFocusRef.current();
    });
  };
  /* Kept in a ref for the mount effect above (same pattern as
     clearFocusRef). */
  const ensureFocusListenersRef = useRef(ensureFocusListeners);
  ensureFocusListenersRef.current = ensureFocusListeners;

  /* Spot tap selection (unification, subtask 1460 — moved from
     SpotListMap, unchanged except for the variant gate): the
     callback lives in a ref so the map listener (attached once
     per map instance) always calls the latest one, and the
     press is snapshotted so a press that turned into a drag
     does not count as a tap — the same contract as the fill
     map's focus listeners (tap-guard.ts). The handler only acts while
     the スポット tab is showing; on the record tabs the same
     click is the focus listeners' to handle. */
  const onSpotTapRef = useRef(onSpotTap);
  onSpotTapRef.current = onSpotTap;
  const spotTapListenerMapRef = useRef<MapLibreLike | null>(null);
  const spotTapPressSnapshotRef = useRef<PressSnapshot | null>(null);
  const attachSpotTap = (map: MapLibreLike) => {
    if (spotTapListenerMapRef.current === map) return;
    spotTapListenerMapRef.current = map;
    const rememberPress = (e: unknown) => {
      let center: { lng: number; lat: number } | null = null;
      try {
        center = map.getCenter();
      } catch {
        center = null;
      }
      spotTapPressSnapshotRef.current = {
        point: pointFromMapEvent(e),
        center,
      };
    };
    map.on("mousedown", rememberPress);
    map.on("touchstart", rememberPress);
    map.on("click", (e) => {
      const press = spotTapPressSnapshotRef.current;
      spotTapPressSnapshotRef.current = null;
      let center: { lng: number; lat: number } | null = null;
      try {
        center = map.getCenter();
      } catch {
        center = null;
      }
      if (!isTapAfterPress(press, { point: pointFromMapEvent(e), center })) {
        return;
      }
      if (variantRef.current !== "spots") return;
      const handler = onSpotTapRef.current;
      if (!handler) return;
      const pt = e?.point as { x: number; y: number } | undefined;
      if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return;
      try {
        if (!map.getLayer("list-spot-points-circle")) return;
        /* The painted dots are only a few pixels wide — too small a
           target for a finger — so the hit test uses a small box
           around the tap point, and the closest feature inside it
           wins. */
        const R = 14;
        const features = map.queryRenderedFeatures(
          [
            [pt.x - R, pt.y - R],
            [pt.x + R, pt.y + R],
          ],
          { layers: ["list-spot-points-circle"] },
        );
        let best: { point: SpotMapPoint; d2: number } | null = null;
        for (const f of features) {
          const id = f.properties?.id;
          if (typeof id !== "number") continue;
          const point = filteredSpotsRef.current.find((p) => p.id === id);
          if (!point) continue;
          /* Rank by the tap's ground distance to the spot, so a box
             holding several dots picks the one the reader aimed at. */
          const lngLat = e?.lngLat;
          const d2 = lngLat
            ? (point.lng - lngLat.lng) ** 2 + (point.lat - lngLat.lat) ** 2
            : 0;
          if (!best || d2 < best.d2) best = { point, d2 };
        }
        if (best) handler(best.point);
      } catch {
        /* a failed hit test simply selects nothing */
      }
    });
    /* Desktop nicety, same as the old distribution map: the cursor
       flips to a pointer while hovering a dot. Off the スポット
       tab the cursor is reset instead — the dots are hidden there
       and must not keep their pointer. */
    map.on("mousemove", (e) => {
      try {
        if (variantRef.current !== "spots") {
          map.getCanvas().style.cursor = "";
          return;
        }
        const pt = e?.point as { x: number; y: number } | undefined;
        if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return;
        if (!map.getLayer("list-spot-points-circle")) return;
        const features = map.queryRenderedFeatures(pt, {
          layers: ["list-spot-points-circle"],
        });
        map.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";
      } catch {
        /* the cursor is a cue only */
      }
    });
  };
  const attachSpotTapRef = useRef(attachSpotTap);
  attachSpotTapRef.current = attachSpotTap;

  /* The section renders only while its tab is active, so on mount
     the live map is asked to re-measure its container (it may have
     been sized while the tab was hidden) — camera and highlight
     state then render at the right size. Fullscreen toggles
     (subtask 1484) re-size the container the same way, so the
     toggle is a dependency too. */
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      withLiveMapRef.current((map) => {
        try {
          map.resize();
        } catch {
          /* the map may already be gone */
        }
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, fullscreen]);

  /* Scrolls a ledger row fully into view, then keeps verifying and
     correcting until the row is actually there. A single fire-and-
     forget smooth scrollIntoView proved unreliable on device: it
     stopped partway and left the row out of sight (the animation is
     cut short when layout shifts mid-scroll — the tapped group is
     still expanding, the map's focus layers land — and "nearest"
     could park the row at the very bottom edge, half under the
     fixed tab bar). This loop re-measures the row's real rect after
     the scroll settles and scrolls again until the row sits fully
     inside the viewport, above the tab bar. It stops early when the
     reader scrolls by hand, and gives up after ~3 s of corrections. */
  const scrollRowFullyIntoView = (row: HTMLElement) => {
    const seq = ++rowScrollSeqRef.current;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    /* The fixed bottom tab bar overlays the viewport's lower edge;
       the row only counts as in view when it ends above it. */
    const bottomBarAllowance = 96;
    /* At xl the ledger is its own scroll pane beside the map. When
       that pane is what actually scrolls this row, visibility is
       measured against the pane's visible box — still clipped by the
       tab-bar allowance where the pane's lower edge runs under the
       fixed bar — and the pane, not the window, is scrolled. Below
       xl, or when the pane's content fits without scrolling, the
       original window measurement applies unchanged. */
    const pane = ledgerPaneRef.current;
    const paneActive =
      pane !== null && pane.contains(row) && pane.scrollHeight > pane.clientHeight;
    const visibleTop = () => {
      if (paneActive && pane) return Math.max(0, pane.getBoundingClientRect().top);
      /* Window path: once the page has scrolled, the sticky map
         pane overlays the viewport's top (40dvh of it), and a row
         behind it is NOT visible however its raw rect reads — the
         verify loop below could otherwise declare the row "fully
         visible" and never scroll at all, which is exactly how a
         map tap's row stayed out of sight (subtask 1440). */
      const el = mapContainerRef.current;
      return stickyPaneVisibleTop(
        el ? el.getBoundingClientRect() : null,
        window.innerHeight,
        bottomBarAllowance,
      );
    };
    const visibleBottom = () =>
      paneActive && pane
        ? Math.min(
            window.innerHeight - bottomBarAllowance,
            pane.getBoundingClientRect().bottom,
          )
        : window.innerHeight - bottomBarAllowance;
    const fullyVisible = () => {
      const rect = row.getBoundingClientRect();
      return rect.top >= visibleTop() && rect.bottom <= visibleBottom();
    };
    const scrollPos = () => (paneActive && pane ? pane.scrollTop : window.scrollY);
    const scrollOnce = (instant: boolean) => {
      if (paneActive && pane) {
        const rect = row.getBoundingClientRect();
        const paneRect = pane.getBoundingClientRect();
        /* Center the row inside the pane's visible box. */
        const target =
          pane.scrollTop +
          (rect.top - paneRect.top) -
          (pane.clientHeight - rect.height) / 2;
        pane.scrollTo({ top: target, behavior: instant ? "auto" : "smooth" });
      } else {
        /* Center the row inside the HONEST visible range (below
           the stuck map pane, above the tab bar), not the raw
           viewport: scrollIntoView's "center" targets the raw
           viewport center, which the verify loop's range may not
           accept as visible, so the correction could never land. */
        const rect = row.getBoundingClientRect();
        const center = (visibleTop() + visibleBottom()) / 2;
        const target =
          window.scrollY + (rect.top + rect.height / 2) - center;
        window.scrollTo({
          top: Math.max(0, target),
          behavior: instant ? "auto" : "smooth",
        });
      }
    };
    const cancelOnTouch = () => {
      if (rowScrollSeqRef.current === seq) rowScrollSeqRef.current += 1;
    };
    window.addEventListener("touchmove", cancelOnTouch, { passive: true });
    window.addEventListener("wheel", cancelOnTouch, { passive: true });
    const stop = () => {
      window.removeEventListener("touchmove", cancelOnTouch);
      window.removeEventListener("wheel", cancelOnTouch);
    };
    let attempts = 0;
    let lastY = scrollPos();
    let stillTicks = 0;
    const step = () => {
      if (rowScrollSeqRef.current !== seq) {
        stop();
        return;
      }
      if (fullyVisible()) {
        stop();
        return;
      }
      if (attempts > 24) {
        /* The corrections never landed the row in view. On the
           window path that can mean window.scrollTo is not what
           moves the reader's page at all — inside the hosting
           app's WebView the visible scroll can belong to an
           ancestor scroller the window calls cannot reach, in
           which case scrollPos() never changed and every pass
           above was a no-op (subtask 1580). scrollIntoView is
           the one primitive that scrolls EVERY scrollable
           ancestor, the window included, so it lands the row
           either way; it fires only here, after the precise
           loop has had its ~3 s, never instead of it. The pane
           path scrolls its own element directly and does not
           need the fallback. */
        if (!paneActive) {
          try {
            row.scrollIntoView({ block: "center", behavior: "auto" });
          } catch {
            /* a detached row has nothing to scroll to */
          }
        }
        stop();
        return;
      }
      attempts += 1;
      const y = scrollPos();
      if (y === lastY) {
        stillTicks += 1;
      } else {
        stillTicks = 0;
        lastY = y;
      }
      /* Scroll on the first pass, and again whenever the previous
         scroll has settled without landing the row in view. A
         correction jumps instantly: a second smooth animation could
         be cut short the same way the first one was. */
      if (attempts === 1 || stillTicks >= 2) {
        scrollOnce(reduceMotion || stillTicks >= 2);
        stillTicks = 0;
      }
      window.setTimeout(step, 120);
    };
    step();
  };

  /* When a map tap selected a municipality whose prefecture group was
     folded, the row only becomes scrollable once the group has
     expanded and re-rendered. This effect runs after every render
     and starts the pending scroll as soon as the row is actually
     laid out (a folded group's rows have no layout boxes). */
  useEffect(() => {
    const id = pendingRowScrollRef.current;
    if (id === null || id !== focusedId) return;
    const idx = mappableIndex.get(id);
    const row = idx !== undefined ? rowRefs.current[idx] : null;
    if (!row || row.getClientRects().length === 0) return;
    pendingRowScrollRef.current = null;
    scrollRowFullyIntoView(row);
  });

  /* Ledger row tap: fly the map to that municipality's boundary and
     emphasize it (orange fill on the map, highlighted row here). The
     highlight stays until another row is tapped, the map's empty area
     is tapped, or the row is deleted. When the interactive map cannot
     run, the static map image is scrolled into view instead and only
     the row emphasis applies. Delete controls carry data-map-no-fly
     and never reach here (checked in the caller). */
  const focusMunicipality = (m: VisitedMunicipality) => {
    focusedIdRef.current = m.id;
    setFocusedId(m.id);
    setTappedMunicipality(null);
    /* The two focuses are mutually exclusive (see the state note). */
    clearLineFocusRef.current();
    /* A row tap supersedes any map-tap row scroll still running. */
    rowScrollSeqRef.current += 1;

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!mapFailed && mappableIndex.has(m.id)) {
      mapContainerRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      const bounds = boundsForMunicipality(m);
      const geometry = boundaryGeometryFor(m);
      withLiveMap((map) => {
        /* A later tap — or leaving for the スポット tab, which
           clears the focus — supersedes this one (review round 1,
           finding 6). */
        if (variantRef.current !== "municipalities" || focusedIdRef.current !== m.id) return;
        try {
          stopCamera(map);
          ensureFocusListeners(map);
          setFocusGeometry(map, geometry, m);
          if (bounds) {
            map.fitBounds(bounds, {
              padding: mapFitPadding(),
              maxZoom: 15,
              duration: reduceMotion ? 0 : 1200,
            });
          } else if (representativePoint(m)) {
            const point = representativePoint(m) as { lat: number; lng: number };
            map.flyTo({
              center: [point.lng, point.lat],
              zoom: 12,
              duration: reduceMotion ? 0 : 1200,
            });
          }
        } catch {
          /* a failed camera move leaves the row emphasis as the cue */
        }
      });
    } else {
      fallbackMapRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  };

  /* Ridden-line row tap: fly the map to that line's track and
     emphasize it (orange focus highlight on the map, highlighted
     row in the list) — the 路線 counterpart of focusMunicipality
     above, with the same contract: the highlight stays until
     another row is tapped, the map's empty area is tapped, or
     the row is deleted; when the interactive map cannot run, the
     static map image is scrolled into view instead and only the
     row emphasis applies. The highlight is the row's painted
     legs from the line coverage — a partial ride highlights only
     its ridden section, a full ride its whole path, an unknown
     ride its whole path — so a multi-line service (JR埼京線)
     finally has a track to frame. The CAMERA frames more than
     the highlight: the whole formal line, unridden stretches
     included (subtask 1589, the reader's request of 2026-11-26),
     so the reader sees where the line runs beyond the ride —
     and the unridden stretches of the focused line repaint at
     the remainder focus's midway strength while it is focused
     (see setUnriddenRemainderFocus). Delete / context-edit
     controls carry data-map-no-fly and never reach here (they
     are separate buttons, checked in RiddenLinesBlock). */
  const focusRiddenLine = (line: RiddenLine) => {
    if (resolveRiddenService(line).needsReview) return;
    /* The two focuses are mutually exclusive: clear the
       municipality focus (state + geometry) without going through
       clearFocus, which would clear this line focus too. */
    focusedIdRef.current = null;
    setFocusedId(null);
    setTappedMunicipality(null);
    const currentMap = mapHandleRef.current?.getMap() ?? null;
    if (currentMap) {
      try {
        clearFocusGeometry(currentMap);
      } catch {
        /* the map may already be gone; the row emphasis is the cue */
      }
    }
    focusedLineIdRef.current = line.id;
    setFocusedLineId(line.id);
    pendingLineScrollRef.current = null;
    const service = usableRiddenService(line);
    const painted = service
      ? lineCoverage.perServiceLegs.get(service.id)
      : undefined;
    /* A line tap supersedes any row scroll still running. */
    rowScrollSeqRef.current += 1;
    if (!painted || painted.legs.length === 0) {
      /* No track to paint (a row with no service link): the
         previous row's highlight must not linger.
         Clearing runs through the live map, guarded by the
         current selection — a superseded tap must not clear a
         newer row's highlight. */
      if (!mapFailed) {
        withLiveMap((map) => {
          if (focusedLineIdRef.current !== line.id) return;
          try {
            clearFocusLineGeometry(map, remainderGhostContext());
          } catch {
            /* the map may already be gone; the row emphasis is the cue */
          }
        });
      }
      return;
    }

    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!mapFailed && showLiveMap) {
      mapContainerRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
      const bounds = service
        ? wholeLineBounds(service, painted.legs, RIDDEN_LINE_GEOMETRIES)
        : null;
      withLiveMap((map) => {
        /* A later tap supersedes this one: never paint a stale
           highlight (or fly the camera) for a row the reader has
           already left. */
        if (focusedLineIdRef.current !== line.id) return;
        try {
          stopCamera(map);
          ensureFocusListeners(map);
          if (service) setFocusSection(map, service.id, painted.legs);
          if (service) {
            const unriddenLegs =
              lineCoverage.perServiceUnriddenLegs.get(service.id);
            const remainderLegs = unriddenRemainderLegsForRow(
              line,
              painted,
              unriddenLegs,
            );
            setUnriddenRemainderFocus(
              map,
              unriddenRemainderKeysForRow(line, painted),
              remainderLegs,
              service.id,
              {
                ...remainderGhostContext(),
                /* The trim cuts exactly the legs the focus
                   source paints, in their full edge frame. */
                spans:
                  remainderLegs.length > 0 ? (unriddenLegs ?? []) : [],
              },
            );
          }
          if (bounds) {
            map.fitBounds(bounds, {
              padding: mapFitPadding(),
              maxZoom: 15,
              duration: reduceMotion ? 0 : 1200,
            });
          }
        } catch {
          /* a failed camera move leaves the row emphasis as the cue */
        }
      });
    } else {
      fallbackMapRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  };

  /* 事業者別（路線）bar tap: the reverse direction. The operator's
     first ledger row is emphasized, its track gets the same focus
     highlight on the map (no camera move — the reader is looking
     at the chart and the list, and this path's own contract keeps
     the camera where it was, unlike a map tap since subtask
     1584), the list opens if it was folded, and the ledger scrolls
     to the row once it is rendered (see the pending-scroll effect
     below). An operator with no resolved row never reaches here:
     its bar is not rendered (operatorRows only counts resolved
     rows). */
  const focusLineFromOperator = (operator: string) => {
    const row = firstLineRowByOperator.get(operator);
    if (!row) return;
    focusedIdRef.current = null;
    setFocusedId(null);
    setTappedMunicipality(null);
    const currentMap = mapHandleRef.current?.getMap() ?? null;
    if (currentMap) {
      try {
        clearFocusGeometry(currentMap);
      } catch {
        /* the map may already be gone; the row emphasis is the cue */
      }
    }
    focusedLineIdRef.current = row.id;
    setFocusedLineId(row.id);
    const service = usableRiddenService(row);
    const painted = service
      ? lineCoverage.perServiceLegs.get(service.id)
      : undefined;
    setLinesExpanded(true);
    /* The row's operator group opens too (tab split, subtask
       1439): with the list grouped by operator, an unexpanded
       group would leave the row laid out nowhere. */
    expandOperatorForLine(row);
    pendingLineScrollRef.current = row.id;
    /* If the list was already open and the row is already laid
       out, scroll right away: a repeat tap on the same operator
       changes no state, so no re-render would ever run the
       pending-scroll effect. When the row is not laid out yet
       (the list was folded), the effect takes over after the
       expansion renders. */
    const rowEl = lineRowRefs.current.get(row.id) ?? null;
    if (rowEl && rowEl.getClientRects().length > 0) {
      pendingLineScrollRef.current = null;
      scrollRowFullyIntoView(rowEl);
    }
    if (painted && painted.legs.length > 0) {
      withLiveMap((map) => {
        /* A later tap supersedes this one: never paint a stale
           highlight for a row the reader has already left. */
        if (focusedLineIdRef.current !== row.id) return;
        try {
          if (service) setFocusSection(map, service.id, painted.legs);
          if (service) {
            const unriddenLegs =
              lineCoverage.perServiceUnriddenLegs.get(service.id);
            const remainderLegs = unriddenRemainderLegsForRow(
              row,
              painted,
              unriddenLegs,
            );
            setUnriddenRemainderFocus(
              map,
              unriddenRemainderKeysForRow(row, painted),
              remainderLegs,
              service.id,
              {
                ...remainderGhostContext(),
                /* The trim cuts exactly the legs the focus
                   source paints, in their full edge frame. */
                spans:
                  remainderLegs.length > 0 ? (unriddenLegs ?? []) : [],
              },
            );
          }
        } catch {
          /* a failed highlight leaves the row emphasis as the cue */
        }
      });
    } else {
      /* No track to paint (a row with no service link): the
         previous row's highlight must not linger — the bar
         tap still changes the focused row. */
      withLiveMap((map) => {
        if (focusedLineIdRef.current !== row.id) return;
        try {
          clearFocusLineGeometry(map, remainderGhostContext());
        } catch {
          /* a failed clear leaves the row emphasis as the cue */
        }
      });
    }
  };

  /* When a bar tap focused a line whose list was folded, the row
     only becomes scrollable once the list has expanded and
     re-rendered. This effect runs after every render and starts
     the pending scroll as soon as the row is actually laid out —
     the same pattern as the municipality pending-row-scroll effect
     above, reusing its verify-and-correct scroll loop. */
  useEffect(() => {
    const id = pendingLineScrollRef.current;
    if (id === null || id !== focusedLineId) return;
    const row = lineRowRefs.current.get(id) ?? null;
    if (!row || row.getClientRects().length === 0) return;
    pendingLineScrollRef.current = null;
    scrollRowFullyIntoView(row);
  });

  /* Map line tap on the 路線 tab (tab split, subtask 1439): the
     reverse of a ledger row tap, with the municipality map tap's
     contract — the tapped line gets the persistent highlight
     (focus track on the map, emphasized row), its operator group
     expands if folded, and the list scrolls to its row. The
     camera also fits the whole LINE into the frame — unridden
     stretches included, as a row tap frames it (subtask 1584
     added the fit, subtask 1589 widened it from the ridden
     section to the whole line; both the reader's requests of
     2026-11-26. Before the first of them the camera deliberately
     stayed put — see focusRiddenLine for the row tap, and
     focusMunicipalityFromMap for why the fit needs no gate of
     its own). A line with no painted track has nothing to
     frame, so its tap only clears the previous highlight. */
  const focusLineFromMap = (line: RiddenLine) => {
    if (resolveRiddenService(line).needsReview) return;
    /* The two focuses are mutually exclusive, exactly as in
       focusRiddenLine: clear the municipality focus (state +
       geometry) without going through clearFocus, which would
       clear this line focus too. */
    focusedIdRef.current = null;
    setFocusedId(null);
    setTappedMunicipality(null);
    const currentMap = mapHandleRef.current?.getMap() ?? null;
    if (currentMap) {
      try {
        clearFocusGeometry(currentMap);
      } catch {
        /* the map may already be gone; the row emphasis is the cue */
      }
    }
    focusedLineIdRef.current = line.id;
    setFocusedLineId(line.id);
    setLinesExpanded(true);
    expandOperatorForLine(line);
    pendingLineScrollRef.current = line.id;
    /* A map tap supersedes any row scroll still running for a
       municipality row; the line pending scroll starts its own. */
    rowScrollSeqRef.current += 1;
    const service = usableRiddenService(line);
    const painted = service
      ? lineCoverage.perServiceLegs.get(service.id)
      : undefined;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    withLiveMap((map) => {
      /* A later tap supersedes this one: never paint a stale
         highlight for a row the reader has already left. */
      if (focusedLineIdRef.current !== line.id) return;
      try {
        if (painted && painted.legs.length > 0 && service) {
          setFocusSection(map, service.id, painted.legs);
          const unriddenLegs =
            lineCoverage.perServiceUnriddenLegs.get(service.id);
          const remainderLegs = unriddenRemainderLegsForRow(
            line,
            painted,
            unriddenLegs,
          );
          setUnriddenRemainderFocus(
            map,
            unriddenRemainderKeysForRow(line, painted),
            remainderLegs,
            service.id,
            {
              ...remainderGhostContext(),
              /* The trim cuts exactly the legs the focus
                 source paints, in their full edge frame. */
              spans:
                remainderLegs.length > 0 ? (unriddenLegs ?? []) : [],
            },
          );
          /* Fit the whole line into the frame, with the row
             tap's framing (focusRiddenLine): same padding,
             same maxZoom, same duration. */
          const plan = focusCameraPlan(
            wholeLineBounds(service, painted.legs, RIDDEN_LINE_GEOMETRIES),
            null,
          );
          if (plan.kind === "fit-bounds") {
            stopCamera(map);
            map.fitBounds(plan.bounds, {
              padding: mapFitPadding(),
              maxZoom: 15,
              duration: reduceMotion ? 0 : 1200,
            });
          }
        } else {
          /* No track to paint (a row with no service link): the
             previous row's highlight must not linger. */
          clearFocusLineGeometry(map, remainderGhostContext());
        }
      } catch {
        /* a failed highlight or camera move leaves the row emphasis as the cue */
      }
    });
  };
  /* Kept in a ref so the map listeners above always call the
     latest version without re-registering. */
  const focusLineFromMapRef = useRef(focusLineFromMap);
  focusLineFromMapRef.current = focusLineFromMap;

  const invalidateVisited = () =>
    void queryClient.invalidateQueries({ queryKey: ["visitedMunicipalities"] });

  const deleteVisitedMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteVisitedMunicipality({ id }),
    onSuccess: (_res, id) => {
      /* Deleting the highlighted row clears the highlight too — its
         geometry would otherwise linger on the map. */
      if (focusedIdRef.current === id) clearFocusRef.current();
      invalidateVisited();
    },
  });
  const [confirmDeleteVisited, setConfirmDeleteVisited] = useState<number | null>(null);

  /* ----- trip context (行程) inline edit ----- */
  const [contextEditId, setContextEditId] = useState<number | null>(null);
  const [contextDraft, setContextDraft] = useState("");
  const [contextMsg, setContextMsg] = useState<string | null>(null);
  const updateContextMutation = useMutation({
    mutationFn: async (args: { id: number; context: string | null }) =>
      await api.updateVisitedMunicipality(args),
    onSuccess: () => {
      invalidateVisited();
      setContextEditId(null);
      setContextMsg(null);
    },
    onError: () => setContextMsg("行程の保存に失敗しました。もう一度お試しください。"),
  });

  /* ----- manual add ----- */
  const todayLocal = new Date().toLocaleDateString("en-CA");
  const [vName, setVName] = useState("");
  const [vPrefecture, setVPrefecture] = useState("");
  const [vArea, setVArea] = useState("");
  const [vContext, setVContext] = useState("");
  const [vDate, setVDate] = useState(todayLocal);
  const [vMsg, setVMsg] = useState<string | null>(null);
  const [showVisitedForm, setShowVisitedForm] = useState(false);

  const addVisitedMutation = useMutation({
    mutationFn: async () => {
      let lat: number | null = null;
      let lng: number | null = null;
      try {
        const geo = await api.geocode({ query: `${vPrefecture.trim()} ${vName.trim()}` });
        const cand = geo.candidates[0];
        if (cand) {
          lat = cand.lat;
          lng = cand.lng;
        }
      } catch {
        /* coordinates are optional; the row still joins the ledger */
      }
      return await api.addVisitedMunicipality({
        name: vName.trim(),
        prefecture: vPrefecture.trim(),
        area: vArea.trim() || null,
        context: vContext.trim() || null,
        visitedOn: vDate,
        lat,
        lng,
      });
    },
    onSuccess: (res) => {
      invalidateVisited();
      if (res.created) {
        setVMsg("記録しました");
        setVName("");
        setVArea("");
        setVContext("");
      } else {
        setVMsg("その市区町村はすでに記録済みです（最初の日付のまま保持されます）");
      }
    },
    onError: () => setVMsg("記録に失敗しました。もう一度お試しください。"),
  });

  /* Reload after a failed or stalled map load: clearing the failure
     state re-runs the mount effect against a fresh container, the
     automatic-retry budget is restored, and the default framing may
     run again for the new map. */
  const retryVisitedMap = () => {
    autoFitShotsRef.current.reset();
    mapRetryCountRef.current = 0;
    setMapFailureReason(null);
    setMapFailed(false);
  };

  const downloadLedger = () => {
    const md = buildLedgerMarkdown(municipalities, prefectures);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "visited-municipalities.md";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      aria-label={
        variant === "spots"
          ? "スポットの地図"
          : variant === "lines"
            ? "路線の記録"
            : "市区町村の記録"
      }
      className="pt-3"
    >
      {/* Same opening as the スポット tab (pt-3 section, then the
          sticky full-bleed map at the very top with the shared
          MAP_PANE_HEIGHT): no header / intro text, no stats above
          the map, so switching tabs never moves or resizes the map.
          The frame button, the compact stats, the ledger, and the
          record controls all follow below the map. On the
          スポット tab (unification, subtask 1460) only the map
          pane renders here — the spot list and its controls live
          in App's スポット section, passed in as children below
          the map pane (review round 1, finding 3). */}

      {variant !== "spots" && visitedQuery.isPending && <p className="mt-3 text-sm text-[var(--dim)]">読み込み中…</p>}
      {variant !== "spots" && visitedQuery.isError && (
        <p className="mt-3 text-sm text-[var(--signal)]">
          台帳の読み込みに失敗しました{" "}
          <button type="button" className="underline" onClick={() => void visitedQuery.refetch()}>
            再試行
          </button>
        </p>
      )}

      {variant !== "spots" && visitedQuery.data && totalVisited === 0 && !hasRiddenLines && (
        <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-6 text-center">
          <p className="font-[family-name:var(--font-display)] text-lg font-bold">まだ記録がありません</p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            新しい市区町村でトリビアを受け取ると、ここに自動で追加されます。下のフォームから手動で記録することもできます。
          </p>
        </div>
      )}

      {/* Phase-2 layout: at xl this becomes a two-column grid via
          placement classes on the same DOM children — map, frame
          button, compact stats, and the record buttons/form in the
          main column; the prefecture ledger and the ridden lines in
          the side column. Below xl nothing is a grid and the children
          stack in DOM order (map first, exactly like the スポット
          tab), and no element remounts on resize. The ledger spans
          the map-side rows and scrolls independently there
          (overflow-y-auto); scrollRowFullyIntoView measures against
          that pane. */}
      <div
        className={
          (totalVisited > 0 || hasRiddenLines) && variant !== "spots"
            ? "xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-6"
            : undefined
        }
      >
      {(mapPaneBlockRendered(variant, totalVisited, hasRiddenLines)) && (
        <>
          {/* Sticky map first — the exact same wrapper as the
              スポット tab's pinned map (sticky, -mx-4 full-bleed,
              mt-2 under the section's pt-3, shared MAP_PANE_HEIGHT),
              so the map sits at the identical position and size on
              all three tabs. The grid placement lives on the wrapper;
              the map container inside keeps its own ref. On the
              スポット tab the grid is off (see above), so the pane
              stays full width exactly as the old spot map did. */}
          {/* Fullscreen (subtask 1484): the wrapper goes fixed
              inset-0 at z-30 — below the bottom tab bar's z-40, so
              the bar stays on top of the map and tabs can still be
              switched while fullscreen. The toggle button is a
              direct child of this wrapper, so it stays visible in
              the fallback / failure states too. */}
          <div
            className={
              fullscreen
                ? "fixed inset-0 z-30 bg-[var(--bg)]"
                : "sticky top-0 z-20 -mx-4 mt-2 bg-[var(--bg)] pb-2 pt-1 xl:col-start-1 xl:row-start-1"
            }
          >
          {/* showMapPane already includes the スポット tab
              (showLiveMap || variant === "spots"), so no extra
              variant term belongs here. */}
          {!mapFailed && showMapPane && (
            <div className={fullscreen ? "relative h-full" : "relative"}>
              <div
                ref={mapContainerRef}
                className={`${fullscreen ? "h-full" : MAP_PANE_HEIGHT} w-full overflow-hidden bg-[var(--surface-alt)]`}
                role="img"
                aria-label={
                  variant === "spots"
                    ? "絞り込み中のスポットをプロットした地図"
                    : mappable.length > 0
                      ? `通った市区町村${mappable.length}件の地図`
                      : "乗った路線の地図"
                }
                aria-hidden={!basemapReady}
              />
              {showMapPane && fallbackPhase !== "gone" && (
                <div
                  className={`pointer-events-none absolute inset-0 z-10 bg-[var(--surface-alt)] motion-safe:transition-opacity motion-safe:duration-500 ${
                    fallbackPhase === "fading" ? "opacity-0" : "opacity-100"
                  }`}
                >
                  {/* The static record map only covers the load when
                      there are records to show (review round 1,
                      finding 9): with no spots and no records it
                      would present the stored 35-municipality image
                      as if it were the reader's own record. The
                      loading text below stays either way. The image
                      itself only belongs on the 市区町村 tab
                      (subtask 1465, reader report 2026-11-25): it
                      paints the municipalities at full hero
                      strength, which is that tab's presentation —
                      on the スポット and 路線 tabs the same
                      municipalities are a faint ghost underlay on
                      the live map, so the cover showed them far
                      darker than the tab's own design for the whole
                      first load. Those tabs keep the plain cover
                      (background + loading text) instead. */}
                  {variant === "municipalities" &&
                    (totalVisited > 0 || hasRiddenLines) && (
                    <img
                      src={visitedMapFallbackUrl}
                      alt=""
                      className="h-full w-full object-contain"
                    />
                  )}
                  <p role="status" className="absolute left-2 top-2 rounded bg-[var(--bg)] px-2 py-1 text-xs">
                    ライブ地図を読み込み中
                  </p>
                  <a
                    href="https://www.facebook.com/maps/attribution_terms"
                    target="_blank"
                    rel="noopener"
                    className="pointer-events-auto absolute bottom-0 right-0 bg-[var(--bg)] px-1 text-[10px]"
                    style={
                      fullscreen
                        ? { bottom: bottomTabBarHeightPx() }
                        : undefined
                    }
                  >
                    © OpenStreetMap contributors, Map Data Legal Notices
                  </a>
                </div>
              )}
            </div>
          )}
          {/* The static record map is only a fallback for a map
              that has records to show (review round 1, finding 9):
              with no spots and no records it would present the
              stored 35-municipality image as if it were the
              reader's own record. The empty state above covers
              that case instead. */}
          {(mapFailed || !showMapPane) &&
            variant !== "spots" &&
            (totalVisited > 0 || hasRiddenLines) && (
            <figure
              className="map-fade-in"
              ref={(el) => {
                fallbackMapRef.current = el;
              }}
              onClick={() => clearFocus()}
            >
              <img
                src={visitedMapFallbackUrl}
                alt="通った市区町村を実際の行政区域の形で緑に塗った関東の地図（生成時点の35市区町村）"
                width={1600}
                height={1000}
                className="w-full"
              />
              <figcaption className="mt-1 px-4 text-xs text-[var(--dim)]">
                <a
                  href="https://www.facebook.com/maps/attribution_terms"
                  target="_blank"
                  rel="noopener"
                >
                  © OpenStreetMap contributors, Map Data Legal Notices
                </a>
              </figcaption>
            </figure>
          )}
          {/* The スポット tab's failure note (unification, subtask
              1460 — the old SpotListMap's wording): the list below
              stays usable, and the static record-map image would
              be the wrong fallback here, so the text note takes
              the pane's place instead. */}
          {mapFailed && variant === "spots" && (
            <div className="px-4 pt-1">
              <p className="text-sm text-[var(--dim)]">
                地図を表示できませんでした。スポット一覧は下のまま使えます。通信が戻れば自動で地図に切り替わります。
              </p>
              {describeMapFailure(mapFailureReason) !== null && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  理由: {describeMapFailure(mapFailureReason)}
                </p>
              )}
              <button
                type="button"
                onClick={retryVisitedMap}
                className="mt-0.5 text-sm font-medium text-[var(--accent)] underline"
              >
                地図を再読み込み
              </button>
            </div>
          )}
          {mapFailed && showLiveMap && variant !== "spots" && (
            <div className="px-4 pt-1">
              <p className="text-xs text-[var(--dim)]">
                地図を読み込めなかったため、静止画で表示しています。通信が戻れば自動で地図に切り替わります。
              </p>
              {describeMapFailure(mapFailureReason) !== null && (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  理由: {describeMapFailure(mapFailureReason)}
                </p>
              )}
              <button
                type="button"
                onClick={retryVisitedMap}
                className="mt-0.5 text-sm font-medium text-[var(--accent)] underline"
              >
                地図を再読み込み
              </button>
            </div>
          )}
          {/* Boundary data failure (see boundary-data.ts): the map
              itself is live, but some boundary files never arrived,
              so the affected prefectures show without their
              boundary lines. Discreet, like the map-failure note
              above; the console carries the detail. Record tabs
              only — the スポット tab's dots do not need the
              boundary lines. */}
          {variant !== "spots" && boundaryFailed && !mapFailed && showLiveMap && (
            <p className="px-4 pt-1 text-xs text-[var(--dim)]">
              境界データの一部を読み込めなかったため、地図の境界線が一部欠けています。
            </p>
          )}
          {/* The same failure while only the static fallback can be
              shown (or nothing is mappable yet): the reason still
              gets its line — it must not fall out of the display
              conditions just because the live map is not up. The
              store retries on its own, and again when the browser
              reports the connection is back. */}
          {variant !== "spots" && boundaryFailed && (mapFailed || !showLiveMap) && (
            <p className="px-4 pt-1 text-xs text-[var(--dim)]">
              境界データの一部を読み込めませんでした。通信が戻れば自動で再取得します。
            </p>
          )}
          <MapFullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
          </div>

          {/* The スポット tab's list and controls (passed in as
              children from App): they render inside this grid div —
              the sticky map pane's parent — so on the スポット tab
              the pane stays pinned while the list scrolls beneath
              it (review round 1, finding 3). On the record tabs no
              children are passed, so this renders nothing. */}
          {children}

          {/* Right under the map: the frame button, then the stats
              in one compact block (prefecture counts, progress, and
              the one-line counting note). No caption about the
              fills — same cleanup as the スポット tab's map.
              Record tabs only: the スポット tab keeps its own
              buttons and stats in App's スポット section below
              the map (unification, subtask 1460). */}
          {variant !== "spots" && showLiveMap && !mapFailed && (
            <div className="mt-2 flex flex-wrap items-center gap-2 xl:col-start-1 xl:row-start-2">
              {/* Fitting the camera to the current municipality is
                  the 市区町村 tab's move; on the 路線 tab the row
                  keeps only the shared re-take. */}
              {variant === "municipalities" && (
              <button
                type="button"
                onClick={() => void frameCurrentMunicipality(true)}
                disabled={locBusy}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium disabled:opacity-40"
              >
                {locBusy ? "確認中…" : "今いる市区町村に合わせる"}
              </button>
              )}
              {/* Same re-take as the スポット tab: pressing it reads
                  the fresh Pixel position through App's map-only
                  re-take, and on success the marker moves AND the
                  camera flies to it (via the deviceLoc /
                  cameraRequest props). On failure nothing moves —
                  the notice below the buttons explains, and the
                  marker on screen stays the previous position. */}
              <button
                type="button"
                onClick={() => void retakeDeviceLocation()}
                disabled={retakeBusy}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium disabled:opacity-40"
              >
                {retakeBusy ? "確認中…" : "Pixelの位置を取り直す"}
              </button>
              {retakeNotice && (
                <p className="basis-full text-xs text-[var(--dim)]" role="alert">
                  {retakeNotice.kind === "stale"
                    ? `Pixelの位置が古いため（${new Date(retakeNotice.at).toLocaleString("ja-JP")}に取得）、地図は移動していません。`
                    : retakeNotice.kind === "error"
                      ? "Pixelの位置を確認できませんでした。地図は移動していません。"
                      : "Pixelの位置がまだ保存されていません。地図は移動していません。"}
                  {deviceLoc &&
                    `表示中のマーカーは前回取得した位置（${deviceAgeMinutes(deviceLoc.capturedAtMs)}分前）です。`}
                </p>
              )}
              {/* Tapped municipality name: a tap on an unvisited
                  blank area names the place here (its boundary is
                  highlighted orange on the map, same as a visited
                  focus) — and says so when the tap falls outside
                  the fetched boundary data. Cleared by the next
                  visited tap, row tap, or blank tap elsewhere. */}
              {tappedMunicipality && (
                <p className="basis-full text-sm" role="status">
                  {tappedMunicipality.kind === "unvisited" ? (
                    <>
                      ここは{" "}
                      <strong>
                        {tappedMunicipality.prefecture} {tappedMunicipality.name}
                      </strong>{" "}
                      です（まだ訪問していません）
                    </>
                  ) : tappedMunicipality.kind === "loading" ? (
                    "この場所の市区町村はまだ分かりません（境界データを読み込み中です）"
                  ) : tappedMunicipality.kind === "unavailable" ? (
                    "この場所の市区町村は分かりませんでした（境界データの一部を読み込めなかったため、まだ読み込めていない地域があります）"
                  ) : (
                    "この場所の市区町村は分かりませんでした（境界データの範囲外です）"
                  )}
                </p>
              )}
            </div>
          )}

          {variant !== "spots" && (
          <div className="mt-2 xl:col-start-1 xl:row-start-3">
            {/* The stats under the map are split per tab (subtask
                1482), like the 制覇グラフ below: the 市区町村 tab
                shows only the municipality headline, the 路線 tab
                only the line headline and its distance note. The
                legend underneath is split per tab too (subtask
                1564): each tab explains its own hero family's
                paint, not the other family's. */}
            {variant === "municipalities" && prefectures.length > 0 && (
              <p className="text-sm">
                {prefectures.map((p) => `${p.name} ${p.total}`).join(" ・ ")}
              </p>
            )}
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {variant === "municipalities" && (
                <span>
                  市区町村 {totalVisited.toLocaleString()} /{" "}
                  {JAPAN_MUNICIPALITY_TOTAL.toLocaleString()}（{municipalityProgressPct}%）
                </span>
              )}
              {variant === "lines" && (
                <span>
                  路線 {networkRiddenKmText} /{" "}
                  {JAPAN_LINE_TOTAL_KM.toLocaleString()}km（{lineProgressPct}%）
                </span>
              )}
            </p>
            {variant === "lines" && (
              <p className="mt-1 text-xs text-[var(--dim)]">
                路線は乗った区間の距離です。分母は全国の全路線の総延長（国土数値情報の形状から計算・26,903.9km）で、区間が分からない記録は薄い線で描き、距離には数えません
              </p>
            )}
            {/* Legend, split per tab (subtask 1564): one shared
                legend used to sit under both record tabs, so the
                路線 tab explained borders its map only ghosts and
                the 市区町村 tab carried a line item — the reader
                reported it never changed with the tab. Each tab
                now explains its own hero family's paint. The old
                「乗った区間（区間不明は破線）」 item leaves with
                the dashed-segment legend (the reader's rule for
                the line paint: ridden = solid, unridden = thin,
                no dashes). */}
            {variant === "municipalities" ? (
            /* Border legend: the map's line hierarchy (prefecture
                borders strongest, then municipality boundaries,
                ward borders dashed and lightest) is not
                self-evident from the shapes alone, so the swatches
                sit with the stats under the map. */
            <div
              className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--dim)]"
              aria-label="地図の境界線の凡例"
            >
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-[3px] border-[#334155]" />
                都道府県境
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-2 border-[#64748b]" />
                市区町村境（未訪問）
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-2 border-[#14532d]" />
                訪問済みの境
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-2 border-dashed border-[#94a3b8]" />
                政令市の区境
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-2 border-[#ea580c]" />
                選択中
              </span>
            </div>
            ) : (
            /* Line legend: ridden sections are solid in each
                service's own color (hence the multi-color swatch)
                over a white casing; the unridden remainder is the
                same colors at a whisper (the ghost) — except the
                FOCUSED line's remainder, which rises to a midway
                strength so its unridden stretches stand out from
                the other lines' (subtask 1589). A focused line
                keeps its own color, so there is no orange
                選択中 item here — that swatch is the municipality
                focus, on the other tab's legend. */
            <div
              className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--dim)]"
              aria-label="地図の路線の凡例"
            >
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-[linear-gradient(90deg,#e60012,#f39800,#009944,#0284c7)]" />
                乗った区間（路線ごとの色）
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[2px] w-6 rounded-full bg-[linear-gradient(90deg,#e60012,#f39800,#009944,#0284c7)] opacity-60" />
                選択中の路線の乗っていない区間
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-0 w-6 border-t-2 border-[#64748b] opacity-40" />
                乗っていない区間・区間不明（薄く表示）
              </span>
            </div>
            )}
            <ConquestCharts
              variant={variant}
              municipalities={municipalities}
              prefectures={prefectures}
              totalVisited={totalVisited}
              riddenLines={riddenQuery.data?.lines ?? []}
              networkRiddenKm={networkRiddenKm}
              completeServiceCount={completeServiceCount}
              unpreparedLines={unpreparedLines}
              operatorKm={lineCoverage.perOperatorKm}
              municipalityProgressPct={municipalityProgressPct}
              lineProgressPct={lineProgressPct}
              onOperatorSelect={focusLineFromOperator}
            />
          </div>
          )}

          {/* The municipality ledger belongs to the 市区町村 tab
              (tab split, subtask 1439); the 路線 tab renders the
              grouped ridden-lines list in this column instead. */}
          {variant === "municipalities" && (
          <>
          <div
            ref={ledgerPaneRef}
            className="mt-3 space-y-4 xl:col-start-2 xl:row-start-1 xl:row-span-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1"
          >
            {prefectures.map((p) => {
              const expanded = expandedPrefectures.has(p.name);
              return (
              <div key={p.name}>
                <h3>
                  <button
                    type="button"
                    onClick={() => togglePrefecture(p.name)}
                    aria-expanded={expanded}
                    aria-label={`${p.name}の市区町村一覧を${expanded ? "閉じる" : "開く"}`}
                    className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm font-medium text-[var(--dim)]"
                  >
                    <span>
                      {p.name}（{p.total}）
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-xs">
                      {expanded ? "▾" : "▸"}
                    </span>
                  </button>
                </h3>
                <ul
                  className={`mt-1.5 divide-y divide-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] ${
                    expanded ? "" : "hidden"
                  }`}
                >
                  {municipalities
                    .filter((m) => m.prefecture === p.name)
                    .map((m) => {
                      const idx = mappableIndex.get(m.id);
                      const ledgerNo = (ledgerIndex.get(m.id) ?? 0) + 1;
                      const editingContext = contextEditId === m.id;
                      return (
                        <li
                          key={m.id}
                          ref={
                            idx !== undefined
                              ? (el) => {
                                  rowRefs.current[idx] = el;
                                }
                              : undefined
                          }
                          className={`px-3 py-2.5 ${
                            focusedId === m.id ? "map-focused" : ""
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span
                              aria-hidden="true"
                              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                                focusedId === m.id
                                  ? "bg-[var(--signal)] text-white"
                                  : "bg-[var(--accent)] text-[var(--accent-ink)]"
                              }`}
                            >
                              {ledgerNo}
                            </span>
                            <button
                              type="button"
                              onClick={() => focusMunicipality(m)}
                              aria-label={`${m.name}を地図で見る`}
                              className="min-w-0 flex-1 cursor-pointer text-left"
                            >
                              <span className="block truncate text-sm font-medium">{m.name}</span>
                              {m.area && (
                                <span className="block truncate text-xs text-[var(--dim)]">{m.area}</span>
                              )}
                            </button>
                            <span className="shrink-0 text-xs text-[var(--dim)]">
                              {m.visitedOn.replaceAll("-", "/")}
                            </span>
                            {confirmDeleteVisited === m.id ? (
                              <span data-map-no-fly="" className="flex shrink-0 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => deleteVisitedMutation.mutate(m.id)}
                                  disabled={deleteVisitedMutation.isPending}
                                  className="rounded-lg bg-[var(--signal)] px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                                >
                                  削除する
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteVisited(null)}
                                  className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs"
                                >
                                  やめる
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                data-map-no-fly=""
                                onClick={() => setConfirmDeleteVisited(m.id)}
                                aria-label={`${m.name}の記録を削除`}
                                className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-[var(--dim)]"
                              >
                                削除
                              </button>
                            )}
                          </div>
                          {/* Trip context (行程): what this visit was for /
                              on the way back from, when the recording
                              side said so. Editable in place; rows
                              recorded without one just offer the button. */}
                          {!editingContext && (
                            <div className="mt-1 flex items-baseline gap-2 pl-9">
                              {m.context ? (
                                <span className="min-w-0 flex-1 text-xs">
                                  <span className="text-[var(--dim)]">行程：</span>
                                  {m.context}
                                </span>
                              ) : (
                                <span className="flex-1" />
                              )}
                              <button
                                type="button"
                                data-map-no-fly=""
                                onClick={() => {
                                  setContextMsg(null);
                                  setContextDraft(m.context ?? "");
                                  setContextEditId(m.id);
                                }}
                                aria-label={`${m.name}の行程を${m.context ? "編集" : "記録"}`}
                                className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--dim)] underline"
                              >
                                {m.context ? "行程を編集" : "行程を記録"}
                              </button>
                            </div>
                          )}
                          {editingContext && (
                            <div data-map-no-fly="" className="mt-1.5 pl-9">
                              <label htmlFor={`visited-context-${m.id}`} className="sr-only">
                                {m.name}の行程
                              </label>
                              <input
                                id={`visited-context-${m.id}`}
                                {...FIELDS.updateVisitedMunicipality.context}
                                value={contextDraft}
                                onChange={(e) => setContextDraft(e.target.value)}
                                placeholder="例: 面接の行き／実習先からの帰り"
                                className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                              />
                              <div className="mt-1.5 flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateContextMutation.mutate({
                                      id: m.id,
                                      context: contextDraft.trim() || null,
                                    })
                                  }
                                  disabled={updateContextMutation.isPending}
                                  className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                                >
                                  {updateContextMutation.isPending ? "保存中…" : "保存する"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setContextEditId(null);
                                    setContextMsg(null);
                                  }}
                                  className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs"
                                >
                                  やめる
                                </button>
                              </div>
                              {contextMsg && (
                                <p className="mt-1 text-xs text-[var(--signal)]">{contextMsg}</p>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
              );
            })}
          </div>
          {deleteVisitedMutation.isError && (
            <p className="mt-2 text-sm text-[var(--signal)] xl:col-start-2 xl:row-start-5">削除に失敗しました</p>
          )}
          </>
          )}
        </>
      )}

      {variant === "municipalities" && (
      <>
      <div className="mt-3 flex gap-2 xl:col-start-1 xl:row-start-4">
        <button
          type="button"
          onClick={() => setShowVisitedForm((v) => !v)}
          aria-expanded={showVisitedForm}
          className="flex-1 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent)]"
        >
          市区町村を記録する
        </button>
        <button
          type="button"
          onClick={downloadLedger}
          disabled={totalVisited === 0}
          className="flex-1 rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5 font-medium disabled:opacity-40"
        >
          台帳MDをダウンロード
        </button>
      </div>

      {showVisitedForm && (
        <form
          className="mt-3 space-y-3 rounded-[var(--radius)] bg-[var(--surface)] p-4 xl:col-start-1 xl:row-start-5"
          onSubmit={(e) => {
            e.preventDefault();
            setVMsg(null);
            addVisitedMutation.mutate();
          }}
        >
          <div>
            <label htmlFor="visited-date" className="mb-1 block text-sm font-medium">
              日付 *
            </label>
            <input
              id="visited-date"
              {...FIELDS.addVisitedMunicipality.visitedOn}
              type="date"
              required
              value={vDate}
              onChange={(e) => setVDate(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <div>
            <label htmlFor="visited-prefecture" className="mb-1 block text-sm font-medium">
              都道府県 *
            </label>
            <input
              id="visited-prefecture"
              {...FIELDS.addVisitedMunicipality.prefecture}
              value={vPrefecture}
              onChange={(e) => setVPrefecture(e.target.value)}
              list="visited-prefecture-names"
              placeholder="例: 東京都"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
            <datalist id="visited-prefecture-names">
              {["東京都", "埼玉県", "千葉県", "神奈川県", ...prefectures.map((p) => p.name)]
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .map((n) => (
                  <option key={n} value={n} />
                ))}
            </datalist>
          </div>
          <div>
            <label htmlFor="visited-name" className="mb-1 block text-sm font-medium">
              市区町村 *
            </label>
            <input
              id="visited-name"
              {...FIELDS.addVisitedMunicipality.name}
              value={vName}
              onChange={(e) => setVName(e.target.value)}
              placeholder="例: 府中市"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <div>
            <label htmlFor="visited-area" className="mb-1 block text-sm font-medium">
              エリア名
            </label>
            <input
              id="visited-area"
              {...FIELDS.addVisitedMunicipality.area}
              value={vArea}
              onChange={(e) => setVArea(e.target.value)}
              placeholder="例: 天神町（府中駅周辺）"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
            <p className="mt-1 text-xs text-[var(--dim)]">
              座標は市区町村名から自動で探します（見つからない場合は地図に載らず、台帳にだけ残ります）
            </p>
          </div>
          <div>
            <label htmlFor="visited-context" className="mb-1 block text-sm font-medium">
              行程（何で行ったか・何の帰りか）
            </label>
            <input
              id="visited-context"
              {...FIELDS.addVisitedMunicipality.context}
              value={vContext}
              onChange={(e) => setVContext(e.target.value)}
              placeholder="例: 面接の行き／実習先からの帰り"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <button
            type="submit"
            disabled={addVisitedMutation.isPending || !vName.trim() || !vPrefecture.trim() || !vDate}
            className="w-full rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] disabled:opacity-50"
          >
            {addVisitedMutation.isPending ? "記録中…" : "記録する"}
          </button>
          {vMsg && <p className="text-sm text-[var(--dim)]">{vMsg}</p>}
        </form>
      )}
      </>
      )}

      {/* The ridden-lines list belongs to the 路線 tab (tab
          split, subtask 1439): there it takes the side column
          from the top, where the municipality ledger sits on
          the other tab. */}
      {variant === "lines" && (
      <div className="xl:col-start-2 xl:row-start-1 xl:row-span-6">
        <RiddenLinesBlock
          lines={riddenQuery.data?.lines ?? []}
          totalLines={riddenQuery.data?.total ?? 0}
          linesPending={riddenQuery.isPending}
          linesError={riddenQuery.isError}
          linesLoaded={riddenQuery.data !== undefined}
          onRetryLines={() => void riddenQuery.refetch()}
          focusedLineId={focusedLineId}
          linesExpanded={linesExpanded}
          expandedOperators={expandedOperators}
          onToggleOperator={toggleOperator}
          lineCoverage={lineCoverage}
          onToggleLines={() => setLinesExpanded((v) => !v)}
          onLineTap={focusRiddenLine}
          onLineDeleted={(id) => {
            /* Deleting the highlighted row clears the line focus
               too — its track would otherwise linger highlighted. */
            if (focusedLineIdRef.current === id) clearLineFocusRef.current();
          }}
          registerLineRow={(id, el) => {
            lineRowRefs.current.set(id, el);
          }}
        />
      </div>
      )}
      </div>
    </section>
  );
}

/* The ridden-lines collection shown under the fill map: lines the user
   rode and got a line-trivia delivery for, with the first-ride date. */
function RiddenLinesBlock({
  lines,
  totalLines,
  linesPending,
  linesError,
  linesLoaded,
  onRetryLines,
  focusedLineId,
  linesExpanded,
  expandedOperators,
  onToggleOperator,
  lineCoverage,
  onToggleLines,
  onLineTap,
  onLineDeleted,
  registerLineRow,
}: {
  /* The ledger rows and their fetch state, owned by
     VisitedMapSection (integrated review round 1, medium): the
     block used to run its own useQuery on the same key, so a tab
     switch re-ran the query and the list flickered through a
     refetch. The parent's single fetch serves both the map and
     this list; the block's mutations still invalidate the key,
     which refetches the parent's query and flows back down. */
  lines: RiddenLine[];
  totalLines: number;
  linesPending: boolean;
  linesError: boolean;
  /* True once a fetch has landed (the "no records yet" note must
     not show while the first load is still in flight). */
  linesLoaded: boolean;
  onRetryLines: () => void;
  /* The focused line's ledger id (row emphasis), owned by
     VisitedMapSection — the same focus the map highlight and the
     事業者別 bar jumps share. */
  focusedLineId: number | null;
  /* The list starts collapsed so the section stays short as the
     collection grows; the header shows the count and toggles it
     open. The state lives in VisitedMapSection because a
     事業者別 bar tap must open the list before scrolling to its
     target row. */
  linesExpanded: boolean;
  /* The operator groups' expansion (tab split, subtask 1439):
     the list is grouped by operator like the municipality
     ledger is grouped by prefecture, and the expansion state
     lives in VisitedMapSection for the same reason as
     linesExpanded — a bar tap or a map line tap must open the
     target row's group before the row can be scrolled to. */
  expandedOperators: ReadonlySet<string>;
  onToggleOperator: (operator: string) => void;
  /* The stage-2 line coverage (owned by VisitedMapSection): each
     row's ridden distance and completeness, and the painted legs
     the block picker marks covered. */
  lineCoverage: LineCoverage;
  onToggleLines: () => void;
  /* Row tap: fly the map to the line and highlight it (the delete
     and context-edit controls below are separate buttons carrying
     data-map-no-fly, so they never trigger this). */
  onLineTap: (line: RiddenLine) => void;
  /* A row was deleted; the owner clears the focus if it was the
     focused row. */
  onLineDeleted: (id: number) => void;
  /* Registers each rendered row element by ledger id, so the
     owner can scroll a bar tap's target row into view. */
  registerLineRow: (id: number, el: HTMLElement | null) => void;
}) {
  const queryClient = useQueryClient();
  /* Grouped by operator (tab split, subtask 1439), the same
     shape as the municipality ledger's prefecture groups:
     groups in first-appearance order, rows in ledger order,
     unresolved rows under 事業者不明. */
  const lineGroups = groupLinesByOperator(
    lines,
    RIDDEN_LINE_GEOMETRIES,
    LINE_KEY_BY_NAME,
  );

  const invalidateLines = () =>
    void queryClient.invalidateQueries({ queryKey: ["riddenLines"] });

  const [lineDeleteError, setLineDeleteError] = useState<string | null>(null);
  const deleteLineMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteRiddenLine({ id }),
    onSuccess: (_res, id) => {
      setLineDeleteError(null);
      onLineDeleted(id);
      invalidateLines();
    },
    onError: () => setLineDeleteError("削除に失敗しました"),
  });
  const [confirmDeleteLine, setConfirmDeleteLine] = useState<number | null>(null);

  const todayLocal = new Date().toLocaleDateString("en-CA");
  const [showLineForm, setShowLineForm] = useState(false);
  const [lName, setLName] = useState("");
  const [lDate, setLDate] = useState(todayLocal);
  const [lNote, setLNote] = useState("");
  const [lContext, setLContext] = useState("");
  const [lMsg, setLMsg] = useState<string | null>(null);

  const addLineMutation = useMutation({
    mutationFn: async () =>
      await api.addRiddenLine({
        name: lName.trim(),
        firstRiddenOn: lDate,
        note: lNote.trim() || null,
        context: lContext.trim() || null,
      }),
    onSuccess: (res) => {
      invalidateLines();
      if (res.created) {
        setLMsg("記録しました");
        setLName("");
        setLNote("");
        setLContext("");
      } else {
        setLMsg("その路線はすでに記録済みです（最初の日付のまま保持されます）");
      }
    },
    onError: () => setLMsg("記録に失敗しました。もう一度お試しください。"),
  });

  /* Trip context (行程) inline edit, same pattern as the municipality
     ledger rows. */
  const [lineContextEditId, setLineContextEditId] = useState<number | null>(null);
  const [lineContextDraft, setLineContextDraft] = useState("");
  const [lineContextMsg, setLineContextMsg] = useState<string | null>(null);
  const updateLineContextMutation = useMutation({
    mutationFn: async (args: { id: number; context: string | null }) =>
      await api.updateRiddenLine(args),
    onSuccess: () => {
      invalidateLines();
      setLineContextEditId(null);
      setLineContextMsg(null);
    },
    onError: () => setLineContextMsg("行程の保存に失敗しました。もう一度お試しください。"),
  });

  /* Block picker (stage 2): one toggle per master block of the
     row's service. Toggling a block on adds it as a section
     (addRiddenSection, with the block id so the toggle can find
     it again); toggling off deletes that section. A block covered
     by a bigger section (the row's primary section, or a section
     spanning several blocks) shows checked but disabled — no
     single section represents it, so it cannot be unticked on
     its own. Full rides have nothing to pick: the whole service
     is already covered. */
  const [blockPickerLineId, setBlockPickerLineId] = useState<number | null>(null);
  const [blockPickerError, setBlockPickerError] = useState<string | null>(null);
  /* Hand-entered section (stage 3, subtask 1455): the stations
     of a mid-block section the block list cannot offer — the
     form lives in the same picker panel, and only one picker is
     open at a time, so one set of drafts is enough. */
  const [handSectionFrom, setHandSectionFrom] = useState("");
  const [handSectionTo, setHandSectionTo] = useState("");
  const [handSectionDirection, setHandSectionDirection] = useState<
    "inner" | "outer" | ""
  >("");
  const addSectionMutation = useMutation({
    mutationFn: async (args: {
      riddenLineId: number;
      fromStationId: string;
      fromStationName: string;
      toStationId: string;
      toStationName: string;
      direction: "inner" | "outer" | null;
      blockId: string | null;
    }) => await api.addRiddenSection(args),
    onSuccess: (_data, variables) => {
      setBlockPickerError(null);
      /* A hand-entered add clears the form for the next one; a
         block pick leaves the drafts alone. */
      if (variables.blockId == null) {
        setHandSectionFrom("");
        setHandSectionTo("");
        setHandSectionDirection("");
      }
      invalidateLines();
    },
    onError: () => setBlockPickerError("区間の追加に失敗しました"),
  });
  const deleteSectionMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteRiddenSection({ id }),
    onSuccess: () => {
      setBlockPickerError(null);
      invalidateLines();
    },
    onError: () => setBlockPickerError("区間の削除に失敗しました"),
  });

  /* Link confirmation (subtask 1435): a row whose saved service
     link disagrees with the current name rule shows 「系統の連携
     を要確認」 and offers this panel, where the human picks the
     service actually ridden — the saved one, a different one, or
     none. The choice is stored explicit by
     confirmRiddenServiceLink; an explicit unlink stays reviewable
     so it can be undone. */
  const [linkReviewLineId, setLinkReviewLineId] = useState<number | null>(null);
  const [linkReviewChoice, setLinkReviewChoice] = useState("");
  const [linkReviewMsg, setLinkReviewMsg] = useState<string | null>(null);
  const confirmLinkMutation = useMutation({
    mutationFn: async (args: { id: number; serviceId: string | null }) =>
      await api.confirmRiddenServiceLink(args),
    onSuccess: () => {
      invalidateLines();
      setLinkReviewLineId(null);
      setLinkReviewMsg(null);
    },
    onError: () =>
      setLinkReviewMsg("連携の確定に失敗しました。もう一度お試しください。"),
  });

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={onToggleLines}
        aria-expanded={linesExpanded}
        aria-label={`乗った路線の一覧を${linesExpanded ? "閉じる" : "開く"}`}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <span className="font-[family-name:var(--font-display)] text-base font-bold">
          乗った路線
        </span>
        <span className="flex shrink-0 items-baseline gap-2 text-sm text-[var(--dim)]">
          {totalLines > 0 && <span>{totalLines}路線</span>}
          <span aria-hidden="true" className="text-xs">
            {linesExpanded ? "▾" : "▸"}
          </span>
        </span>
      </button>
      <p className="mt-1 text-sm text-[var(--dim)]">
        電車トリビアを受け取った路線を、初めて乗った日と一緒に記録しています。
      </p>

      {linesPending && <p className="mt-3 text-sm text-[var(--dim)]">読み込み中…</p>}
      {linesError && (
        <p className="mt-3 text-sm text-[var(--signal)]">
          路線の記録の読み込みに失敗しました{" "}
          <button type="button" className="underline" onClick={onRetryLines}>
            再試行
          </button>
        </p>
      )}
      {linesExpanded && linesLoaded && totalLines === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          まだ記録がありません。新しい路線でトリビアを受け取ると、ここに自動で追加されます。
        </p>
      )}

      {linesExpanded && totalLines > 0 && (
        <div className="mt-3 space-y-4">
          {lineGroups.map((group) => {
            const groupExpanded = expandedOperators.has(group.operator);
            return (
            <div key={group.operator}>
              <h4>
                <button
                  type="button"
                  onClick={() => onToggleOperator(group.operator)}
                  aria-expanded={groupExpanded}
                  aria-label={`${group.operator}の路線一覧を${groupExpanded ? "閉じる" : "開く"}`}
                  className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm font-medium text-[var(--dim)]"
                >
                  <span>
                    {group.operator}（{group.rows.length}）
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-xs">
                    {groupExpanded ? "▾" : "▸"}
                  </span>
                </button>
              </h4>
              {/* Collapsed groups keep their rows mounted
                  (hidden), the municipality ledger's rule: the
                  map focus paths register row elements and a
                  group that unmounted its rows would break the
                  scroll-to-row bookkeeping. */}
              <ul
                className={`mt-1.5 divide-y divide-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] ${
                  groupExpanded ? "" : "hidden"
                }`}
              >
          {group.rows.map((line) => {
            const editingLineContext = lineContextEditId === line.id;
            const rideLabel = riddenLineRideLabel(line);
            const linkResolution = resolveRiddenService(line);
            const { service, needsReview } = linkResolution;
            const historicalVersions = linkResolution.needsReview
              ? linkResolution.historicalAutoMatchVersions
              : [];
            const explicitlyUnlinked =
              line.serviceId == null && line.serviceLinkSource === "explicit";
            const reviewable = isRiddenServiceLinkReviewable(line);
            /* The chosen service's known stations, for the hint
               when the row's recorded section does not fit it:
               such a choice cannot be confirmed (the server
               refuses it — integrated review round 1, high), so
               the hint says so before the reader tries. The
               yardstick is the server's own — the stations the
               service is known to serve (serviceStationIds, via
               sectionEndpointsKnownToService), NOT just its block
               boundaries: a restored section can end at a
               mid-segment station （京王線's 府中→聖蹟桜ヶ丘）,
               which the server accepts and the boundary-only
               check wrongly refused (integrated review round 2,
               medium). */
            const sectionEndpointsMismatch =
              linkReviewLineId === line.id &&
              linkReviewChoice !== "" &&
              line.rideState === "partial" &&
              line.fromStationId != null &&
              line.toStationId != null &&
              !sectionEndpointsKnownToService(
                linkReviewChoice,
                line.fromStationId,
                line.toStationId,
              );
            const displayName = service?.displayName ?? line.name;
            const key = resolveRiddenLineKey(
              line,
              RIDDEN_LINE_GEOMETRIES,
              LINE_KEY_BY_NAME,
            );
            /* A multi-line service (埼京線 spans 山手線・赤羽線・
               東北線・川越線) has no single key, so the key lookup
               above yields no color and the row fell back to the
               default orange (integrated review round 1,
               medium). The service's own color is the color of
               the first leg it paints. */
            const paintedLegs = service
              ? lineCoverage.perServiceLegs.get(service.id)
              : undefined;
            /* A paint-unified service (山手線, subtask 1680)
               chips in its representative color too — the
               first-leg fallback below would otherwise depend
               on which section's clip happens to come first.
               The representative color is evaluated FIRST, the
               same priority the map's features use (subtask
               1680, review round 1): a future single-key
               service with a paintColorKey would otherwise chip
               in its formal line's color while the map paints
               the representative one. Null falls back to the
               resolved key's color, then the first leg's. */
            const color =
              (service
                ? servicePaintColor(service.id, RIDDEN_LINE_GEOMETRIES)
                : null) ??
              (key ? RIDDEN_LINE_GEOMETRIES[key]?.color : undefined) ??
              (paintedLegs && paintedLegs.legs.length > 0
                ? RIDDEN_LINE_GEOMETRIES[paintedLegs.legs[0]!.key]?.color
                : undefined);
            const usableService = usableRiddenService(line);
            const coverage = usableService
              ? lineCoverage.perService.get(usableService.id)
              : undefined;
            const blocks = usableService && line.rideState !== "full"
              ? blocksForService(usableService.id)
              : [];
            const coveredBlocks = usableService && blocks.length > 0
              ? coveredBlockIds(
                  usableService.id,
                  riddenLineIntervals(line, usableService.id),
                )
              : null;
            const pickerOpen = blockPickerLineId === line.id;
            /* Sections added by hand or by API (no blockId), for
               the picker panel's own delete buttons — a block
               pick's section is deleted from its block toggle
               instead (stage 3, subtask 1455). */
            const handSections = (line.sections ?? []).filter(
              (s) => s.blockId == null,
            );
            /* Either section mutation running blocks both the
               hand-entry add and the per-section deletes: an
               add and a delete overlapping can leave the row's
               saved state disagreeing with the ledger (review
               round 2, medium). The block toggles already
               disable on either mutation. */
            const sectionBusy =
              addSectionMutation.isPending ||
              deleteSectionMutation.isPending;
            /* Stations a hand-entered section may name for this
               row's service: boundaries plus the stations listed
               on its blocks (stage 3), de-duplicated — a loop
               closes on its first station, so it appears twice
               in the ordered list. */
            const handStations = usableService
              ? serviceOrderedStations(usableService.id).filter(
                  (s, i, all) =>
                    all.findIndex((t) => t.id === s.id) === i,
                )
              : [];
            return (
            <li
              key={line.id}
              ref={(el) => {
                registerLineRow(line.id, el);
              }}
              className={`px-3 py-2.5 ${
                focusedLineId === line.id ? "map-focused-line" : ""
              }`}
              /* The focused row is emphasized in the line's OWN
                 color (see .map-focused-line in theme.css): the
                 resolved asset color rides in as a custom
                 property, and an unresolved row sets none and
                 falls back to the signal color. */
              style={
                focusedLineId === line.id && color
                  ? ({ "--line-focus-color": color } as CSSProperties)
                  : undefined
              }
            >
              <div className="flex items-center gap-3">
                {color && (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                )}
                {/* Row tap: fly the map to this line and highlight
                    it — the same shape as a municipality ledger row
                    (the name block is the button; delete and
                    context-edit controls sit outside it and carry
                    data-map-no-fly). */}
                <button
                  type="button"
                  onClick={() => onLineTap(line)}
                  disabled={needsReview}
                  aria-label={needsReview ? undefined : `${displayName}を地図で見る`}
                  className="min-w-0 flex-1 text-left enabled:cursor-pointer"
                >
                  <span className="block truncate text-sm font-medium">{displayName}</span>
                  {needsReview && (
                    <span className="block text-xs font-medium text-[var(--signal)]">
                      系統の連携を要確認
                    </span>
                  )}
                  {rideLabel && (
                    <span className="block text-xs text-[var(--dim)]">{rideLabel}</span>
                  )}
                  {coverage && line.rideState !== "unknown" && (
                    <span className="block text-xs text-[var(--dim)]">
                      {coverage.riddenKm.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}
                      km /{" "}
                      {coverage.totalKm.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}
                      km{coverage.complete ? " ・ 完乗" : ""}
                    </span>
                  )}
                  {/* An unknown ride's distance is unknowable
                      whether or not a service link resolves —
                      unlinked and held-for-review rows show it
                      too (integrated review round 1, M-4
                      remainder: they used to show 区間不明 only). */}
                  {line.rideState === "unknown" && (
                    <span className="block text-xs text-[var(--dim)]">
                      距離不明（区間が分からないため）
                    </span>
                  )}
                  {line.note && (
                    <span className="block text-xs text-[var(--dim)]">{line.note}</span>
                  )}
                </button>
                <span className="shrink-0 text-xs text-[var(--dim)]">
                  {line.firstRiddenOn.replaceAll("-", "/")}
                </span>
                {confirmDeleteLine === line.id ? (
                  <span data-map-no-fly="" className="flex shrink-0 gap-1.5">
                    <button
                      type="button"
                      onClick={() => deleteLineMutation.mutate(line.id)}
                      disabled={deleteLineMutation.isPending}
                      className="rounded-lg bg-[var(--signal)] px-2.5 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                    >
                      削除する
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteLine(null)}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs"
                    >
                      やめる
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    data-map-no-fly=""
                    onClick={() => setConfirmDeleteLine(line.id)}
                    aria-label={`${line.name}の記録を削除`}
                    className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-[var(--dim)]"
                  >
                    削除
                  </button>
                )}
              </div>
              {/* Trip context (行程), same as the municipality rows. */}
              {!editingLineContext && (
                <div className="mt-1 flex items-baseline gap-2">
                  {line.context ? (
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="text-[var(--dim)]">行程：</span>
                      {line.context}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <button
                    type="button"
                    data-map-no-fly=""
                    onClick={() => {
                      setLineContextMsg(null);
                      setLineContextDraft(line.context ?? "");
                      setLineContextEditId(line.id);
                    }}
                    aria-label={`${line.name}の行程を${line.context ? "編集" : "記録"}`}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--dim)] underline"
                  >
                    {line.context ? "行程を編集" : "行程を記録"}
                  </button>
                </div>
              )}
              {editingLineContext && (
                <div data-map-no-fly="" className="mt-1.5">
                  <label htmlFor={`line-context-${line.id}`} className="sr-only">
                    {line.name}の行程
                  </label>
                  <input
                    id={`line-context-${line.id}`}
                    {...FIELDS.updateRiddenLine.context}
                    value={lineContextDraft}
                    onChange={(e) => setLineContextDraft(e.target.value)}
                    placeholder="例: 面接の行き／実習先からの帰り"
                    className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)]"
                  />
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        updateLineContextMutation.mutate({
                          id: line.id,
                          context: lineContextDraft.trim() || null,
                        })
                      }
                      disabled={updateLineContextMutation.isPending}
                      className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                    >
                      {updateLineContextMutation.isPending ? "保存中…" : "保存する"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setLineContextEditId(null);
                        setLineContextMsg(null);
                      }}
                      className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs"
                    >
                      やめる
                    </button>
                  </div>
                  {lineContextMsg && (
                    <p className="mt-1 text-xs text-[var(--signal)]">{lineContextMsg}</p>
                  )}
                </div>
              )}
              {/* Link confirmation (subtask 1435): only rows whose
                  saved link is under review — or rows a human
                  already unlinked — offer it. The panel sits
                  outside the row's map button (buttons cannot
                  nest), next to the context edit and block
                  picker. */}
              {reviewable && (
                <div data-map-no-fly="" className="mt-1.5">
                  {explicitlyUnlinked && (
                    <p className="text-xs text-[var(--dim)]">
                      系統の連携なし（確認済み）
                    </p>
                  )}
                  {linkReviewLineId !== line.id && (
                    <button
                      type="button"
                      onClick={() => {
                        setLinkReviewMsg(null);
                        setLinkReviewChoice(
                          line.serviceId && serviceById(line.serviceId)
                            ? line.serviceId
                            : "",
                        );
                        setLinkReviewLineId(line.id);
                      }}
                      className="rounded-lg px-2 py-1 text-xs text-[var(--dim)] underline"
                    >
                      {needsReview ? "連携を確認する" : "連携を確認し直す"}
                    </button>
                  )}
                  {linkReviewLineId === line.id && (
                    <div className="mt-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
                      <p className="text-xs text-[var(--dim)]">
                        以前の自動連携ルールでは、この記録がどの系統か確定できませんでした。実際に乗った系統を選んでください。記録された名前・区間・日付は変わりません。
                      </p>
                      {line.serviceId && (
                        <p className="mt-1 text-xs">
                          保存されている連携：
                          {serviceById(line.serviceId)?.displayName ??
                            line.serviceId}
                        </p>
                      )}
                      {needsReview && historicalVersions.length > 0 && (
                        <p className="mt-1 text-xs text-[var(--dim)]">
                          旧ルール v{historicalVersions.join("・v")}
                          では、保存されている系統に自動で連携されていました。
                        </p>
                      )}
                      {needsReview && historicalVersions.length === 0 && (
                        <p className="mt-1 text-xs text-[var(--dim)]">
                          保存されている連携は、どの自動連携ルールでも説明できません。
                        </p>
                      )}
                      <ul className="mt-2 space-y-1">
                        {SERVICE_MASTER.map((entry) => (
                          <li
                            key={entry.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            <input
                              type="radio"
                              id={`link-${line.id}-${entry.id}`}
                              name={`link-${line.id}`}
                              checked={linkReviewChoice === entry.id}
                              onChange={() => setLinkReviewChoice(entry.id)}
                            />
                            <label htmlFor={`link-${line.id}-${entry.id}`}>
                              {entry.displayName}（{entry.operator}）
                            </label>
                          </li>
                        ))}
                        <li className="flex items-center gap-2 text-xs">
                          <input
                            type="radio"
                            id={`link-${line.id}-none`}
                            name={`link-${line.id}`}
                            checked={linkReviewChoice === ""}
                            onChange={() => setLinkReviewChoice("")}
                          />
                          <label htmlFor={`link-${line.id}-none`}>
                            どの系統にも当てはまらない（連携しない）
                          </label>
                        </li>
                      </ul>
                      {sectionEndpointsMismatch && (
                        <p className="mt-2 text-xs text-[var(--dim)]">
                          記録されている区間（
                          {line.fromStationName ?? line.fromStationId}→
                          {line.toStationName ?? line.toStationId}
                          ）の端点は、この系統の駅ではありません。この組み合わせでは確定できません。
                        </p>
                      )}
                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            confirmLinkMutation.mutate({
                              id: line.id,
                              serviceId: linkReviewChoice || null,
                            })
                          }
                          disabled={confirmLinkMutation.isPending}
                          className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                        >
                          {confirmLinkMutation.isPending ? "確定中…" : "確定する"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setLinkReviewLineId(null);
                            setLinkReviewMsg(null);
                          }}
                          className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs"
                        >
                          やめる
                        </button>
                      </div>
                      {linkReviewMsg && (
                        <p className="mt-1 text-xs text-[var(--signal)]">
                          {linkReviewMsg}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
              {coveredBlocks && (
                <div data-map-no-fly="" className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      if (pickerOpen) {
                        setBlockPickerLineId(null);
                      } else {
                        /* Opening a picker starts a fresh hand
                           entry for this row. */
                        setBlockPickerError(null);
                        setHandSectionFrom("");
                        setHandSectionTo("");
                        setHandSectionDirection("");
                        setBlockPickerLineId(line.id);
                      }
                    }}
                    aria-expanded={pickerOpen}
                    className="rounded-lg px-2 py-1 text-xs text-[var(--dim)] underline"
                  >
                    区間を選ぶ{pickerOpen ? "（閉じる）" : ""}
                  </button>
                  {pickerOpen && usableService && (
                    <>
                    <ul className="mt-1 space-y-1">
                      {blocks.map((block) => {
                        const covered = coveredBlocks.has(block.id);
                        const exactSection = (line.sections ?? []).find(
                          (s) => s.blockId === block.id,
                        );
                        /* Covered by a bigger section (no exact
                           section for this block): checked but
                           disabled — unticking it alone would mean
                           splitting that section, which is stage 3. */
                        const disabled = covered && !exactSection;
                        const busy =
                          addSectionMutation.isPending ||
                          deleteSectionMutation.isPending;
                        return (
                          <li key={block.id} className="flex items-center gap-2 text-xs">
                            <input
                              type="checkbox"
                              id={`block-${line.id}-${block.id}`}
                              checked={covered}
                              disabled={disabled || busy}
                              onChange={() => {
                                if (covered) {
                                  if (exactSection) {
                                    deleteSectionMutation.mutate(exactSection.id);
                                  }
                                } else {
                                  addSectionMutation.mutate({
                                    riddenLineId: line.id,
                                    fromStationId: block.from.id,
                                    fromStationName: block.from.name,
                                    toStationId: block.to.id,
                                    toStationName: block.to.name,
                                    direction: block.direction ?? null,
                                    blockId: block.id,
                                  });
                                }
                              }}
                            />
                            <label htmlFor={`block-${line.id}-${block.id}`}>
                              {block.from.name}→{block.to.name}
                              {disabled ? "（区間の一部として記録済み）" : ""}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                    {/* Hand-entered sections (stage 3, subtask
                        1455): the block list above only offers
                        whole blocks, so a section between listed
                        mid-block stations （東松戸→北府中) is added
                        here — and sections added this way, or by
                        API, are listed here with their own delete
                        button, so they can be removed one by one
                        instead of only through the block toggles
                        (review round 1, medium). */}
                    {handSections.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {handSections.map((section) => (
                          <li
                            key={section.id}
                            className="flex items-center gap-2 text-xs"
                          >
                            <span className="min-w-0 flex-1">
                              {section.fromStationName ??
                                section.fromStationId}
                              →
                              {section.toStationName ??
                                section.toStationId}
                              {section.direction === "inner"
                                ? "（内回り）"
                                : section.direction === "outer"
                                  ? "（外回り）"
                                  : ""}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                deleteSectionMutation.mutate(section.id)
                              }
                              disabled={sectionBusy}
                              className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--dim)] underline disabled:opacity-50"
                            >
                              削除
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-2">
                      <p className="text-xs text-[var(--dim)]">
                        区間を手入力で追加
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <label
                          className="sr-only"
                          htmlFor={`hand-from-${line.id}`}
                        >
                          出発駅
                        </label>
                        <select
                          id={`hand-from-${line.id}`}
                          value={handSectionFrom}
                          onChange={(e) =>
                            setHandSectionFrom(e.target.value)
                          }
                          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)]"
                        >
                          <option value="">出発駅</option>
                          {handStations.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <span aria-hidden="true" className="text-xs">
                          →
                        </span>
                        <label
                          className="sr-only"
                          htmlFor={`hand-to-${line.id}`}
                        >
                          到着駅
                        </label>
                        <select
                          id={`hand-to-${line.id}`}
                          value={handSectionTo}
                          onChange={(e) =>
                            setHandSectionTo(e.target.value)
                          }
                          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)]"
                        >
                          <option value="">到着駅</option>
                          {handStations.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        {serviceIsLoop(usableService.id) && (
                          <select
                            value={handSectionDirection}
                            onChange={(e) =>
                              setHandSectionDirection(
                                e.target.value as "inner" | "outer" | "",
                              )
                            }
                            aria-label="方向"
                            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs text-[var(--text)]"
                          >
                            <option value="">方向</option>
                            <option value="inner">内回り</option>
                            <option value="outer">外回り</option>
                          </select>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (!handSectionFrom || !handSectionTo) {
                              setBlockPickerError(
                                "出発駅と到着駅を選んでください",
                              );
                              return;
                            }
                            /* The server enforces the same rule;
                               checking first keeps a bad pick from
                               ever leaving the page. */
                            const problem = validateSectionEndpoints(
                              usableService.id,
                              handSectionFrom,
                              handSectionTo,
                              handSectionDirection || null,
                            );
                            if (problem) {
                              setBlockPickerError(problem);
                              return;
                            }
                            const from = handStations.find(
                              (s) => s.id === handSectionFrom,
                            )!;
                            const to = handStations.find(
                              (s) => s.id === handSectionTo,
                            )!;
                            addSectionMutation.mutate({
                              riddenLineId: line.id,
                              fromStationId: from.id,
                              fromStationName: from.name,
                              toStationId: to.id,
                              toStationName: to.name,
                              direction: serviceIsLoop(usableService.id)
                                ? handSectionDirection === ""
                                  ? null
                                  : handSectionDirection
                                : null,
                              blockId: null,
                            });
                          }}
                          disabled={sectionBusy}
                          className="rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-xs font-bold text-[var(--accent-ink)] disabled:opacity-50"
                        >
                          {addSectionMutation.isPending
                            ? "追加中…"
                            : "追加する"}
                        </button>
                      </div>
                    </div>
                    </>
                  )}
                  {blockPickerError && pickerOpen && (
                    <p className="mt-1 text-xs text-[var(--signal)]">{blockPickerError}</p>
                  )}
                </div>
              )}
            </li>
            );
          })}
              </ul>
            </div>
            );
          })}
        </div>
      )}
      {lineDeleteError && (
        <p className="mt-2 text-sm text-[var(--signal)]">{lineDeleteError}</p>
      )}

      <button
        type="button"
        onClick={() => setShowLineForm((v) => !v)}
        aria-expanded={showLineForm}
        className="mt-3 w-full rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent)]"
      >
        路線を記録する
      </button>

      {showLineForm && (
        <form
          className="mt-3 space-y-3 rounded-[var(--radius)] bg-[var(--surface)] p-4"
          onSubmit={(e) => {
            e.preventDefault();
            setLMsg(null);
            addLineMutation.mutate();
          }}
        >
          <div>
            <label htmlFor="line-date" className="mb-1 block text-sm font-medium">
              初めて乗った日 *
            </label>
            <input
              id="line-date"
              {...FIELDS.addRiddenLine.firstRiddenOn}
              type="date"
              required
              value={lDate}
              onChange={(e) => setLDate(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <div>
            <label htmlFor="line-name" className="mb-1 block text-sm font-medium">
              路線名 *
            </label>
            <input
              id="line-name"
              {...FIELDS.addRiddenLine.name}
              value={lName}
              onChange={(e) => setLName(e.target.value)}
              placeholder="例: JR武蔵野線"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <div>
            <label htmlFor="line-note" className="mb-1 block text-sm font-medium">
              メモ
            </label>
            <input
              id="line-note"
              {...FIELDS.addRiddenLine.note}
              value={lNote}
              onChange={(e) => setLNote(e.target.value)}
              placeholder="例: 東松戸駅付近で乗車中に初回配信"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <div>
            <label htmlFor="line-context" className="mb-1 block text-sm font-medium">
              行程（何で行ったか・何の帰りか）
            </label>
            <input
              id="line-context"
              {...FIELDS.addRiddenLine.context}
              value={lContext}
              onChange={(e) => setLContext(e.target.value)}
              placeholder="例: 面接の行き／実習先からの帰り"
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
            />
          </div>
          <button
            type="submit"
            disabled={addLineMutation.isPending || !lName.trim() || !lDate}
            className="w-full rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)] disabled:opacity-50"
          >
            {addLineMutation.isPending ? "記録中…" : "記録する"}
          </button>
          {lMsg && <p className="text-sm text-[var(--dim)]">{lMsg}</p>}
        </form>
      )}
    </div>
  );
}

/* ---------------- app ---------------- */

const PAGE_SIZE = 50;
const RADIUS_OPTIONS = [100, 200, 300, 500, 1000, 2000];

export function App() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "unvisited" | "visited">("unvisited");
  const [memoOnly, setMemoOnly] = useState(false);
  const [expandedNotes, setExpandedNotes] = useState<ReadonlySet<number>>(new Set());
  const [templateDraft, setTemplateDraft] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  /* Distance sort (subtask 680). sortChoice is what the reader picked
     in the 並び替え select; sortOrigin is the FIXED reference point
     the current distance order is computed from, and originKind says
     where it came from. The origin is captured once — when the choice
     is made, or when Pixelの位置を取り直す is pressed — and is then held
     across page turns and filter changes; it is only re-captured when
     the sort choice changes or the reader explicitly re-takes it.
     Nothing here is persisted: the coordinates live in component
     state for this session only and are sent per listSpots request.
     The position source is the stored Pixel position alone:
     browser geolocation (「現在地から近い順」) was removed entirely,
     because the Muse in-app browser cannot geolocate and the dead
     option only confused. */
  /* The initial choice is the Pixel route (the reader asked for it
     as the default after confirming it works on device): on mount
     the stored position is read once, and while it is fresh the list
     opens already sorted by distance from it. With no fresh stored
     position the list simply keeps the standard order and the
     device notice + fallbacks explain why — nothing is forced. Any
     manual change of the select wins over the initial read via the
     same sequence guards as every other route. */
  const [sortChoice, setSortChoice] = useState<"default" | "map" | "device">("device");
  const [sortOrigin, setSortOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [originKind, setOriginKind] = useState<"map" | "device" | null>(null);
  /* Pixel-position sort (the stored-location route): the capture time
     of the origin in use (for the 「○分前の位置」 label), whether the
     stored position is being read, and the notice shown when it
     cannot be used — stale (with its capture time), absent, or
     unreadable. */
  const [deviceOriginAt, setDeviceOriginAt] = useState<number | null>(null);
  const [devicePending, setDevicePending] = useState(false);
  const [deviceNotice, setDeviceNotice] = useState<
    { kind: "stale"; at: number } | { kind: "none" } | { kind: "error" } | null
  >(null);
  /* Race guard for the asynchronous origin route. Every request
     takes the next sequence number, and its answer applies only
     while it is still the newest request AND the reader's current
     choice is still that route — a slow answer can never overwrite
     a sort picked afterwards, and re-tapping the re-take button
     cannot let an older answer beat a newer one. sortChoiceRef
     mirrors the choice for those callbacks (they are registered
     before the state settles). */
  const deviceRequestSeqRef = useRef(0);
  const sortChoiceRef = useRef(sortChoice);
  sortChoiceRef.current = sortChoice;
  /* The maps' Pixel position, kept SEPARATE from sortOrigin on
     purpose. The maps used to receive the sort origin itself as
     their deviceLoc, which chained them to the sort choice: with
     any other sort selected, a re-take never reached the maps at
     all (the reader's report — 「Pixelの位置を取り直す」 left both
     maps unchanged). Now every successful stored-position read —
     the sort route's, or a map's own re-take — updates this state
     whatever the sort choice is, and both maps always receive it.
     sortOrigin still changes only when the distance sort itself is
     picked or re-taken. A failed read never touches this state, so
     the maps keep showing the previous position. */
  const [deviceLocation, setDeviceLocation] = useState<{
    lat: number;
    lng: number;
    capturedAtMs: number;
  } | null>(null);
  /* Explicit camera moves for the maps (see MapCameraRequest):
     minted only by an explicit re-take press, never by the initial
     read, a sort pick, or the maps' 60 s background follow. */
  const [mapCameraRequest, setMapCameraRequest] =
    useState<MapCameraRequest | null>(null);
  const mapCameraSeqRef = useRef(0);
  const refreshDeviceLocation = useCallback(async (): Promise<DeviceLocationData | null> => {
    try {
      return await api.getDeviceLocation({});
    } catch {
      return null;
    }
  }, []);
  /* The unified map registers a getter for its live center here
     (see VisitedMapSection). Until a live map exists — or if
     reading it fails — the map-center sort falls back to that map's
     initial center, the same whole-country framing it mounts with. */
  const spotMapCenterGetterRef = useRef<
    (() => { lat: number; lng: number } | null) | null
  >(null);
  const SPOT_MAP_INITIAL_CENTER = { lat: 37.6, lng: 138.4 };
  const readSpotMapCenter = (): { lat: number; lng: number } => {
    try {
      return spotMapCenterGetterRef.current?.() ?? SPOT_MAP_INITIAL_CENTER;
    } catch {
      return SPOT_MAP_INITIAL_CENTER;
    }
  };
  /* Adopts a fresh stored Pixel position as the sort origin. */
  const applyDeviceOrigin = (coords: { lat: number; lng: number; capturedAtMs: number }) => {
    setSortOrigin({ lat: coords.lat, lng: coords.lng });
    setOriginKind("device");
    setDeviceOriginAt(coords.capturedAtMs);
    setDeviceNotice(null);
  };
  /* The stored-position route: read the Pixel's last position and
     adopt it only while it is fresh (30 minutes). A stale or absent
     position sorts nothing and says so in a notice (with the capture
     time when there is one). Race-guarded (see the sequence ref
     above), with two hard rules so 「Pixelの位置を確認中…」
     can never stick: the read is capped at DEVICE_READ_TIMEOUT_MS
     (a timeout reads as an error, same as a failed read), and a
     response that is still the newest device request ALWAYS
     releases devicePending before anything else — the old guard
     returned early without clearing it whenever the choice check
     failed (the render that was supposed to sync sortChoiceRef
     could lose that race on device), leaving the pending note on
     screen forever even though the position itself was fresh. */
  const acquireDeviceOrigin = useCallback(
    (cameraTarget?: "spots") => {
      setPage(0);
      const requestId = ++deviceRequestSeqRef.current;
      setDevicePending(true);
      setDeviceNotice(null);
      void (async () => {
        const data = await Promise.race([
          refreshDeviceLocation(),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), DEVICE_READ_TIMEOUT_MS),
          ),
        ]);
        if (deviceRequestSeqRef.current !== requestId) return;
        setDevicePending(false);
        const fresh = freshDeviceCoords(data);
        /* The maps' shared position follows EVERY successful read,
           whatever the sort choice is now — the sort route below
           still applies its own choice guard, but the maps must
           not lose a position the reader explicitly re-took just
           because the sort was changed while the read was in
           flight. */
        if (fresh) setDeviceLocation(fresh);
        if (sortChoiceRef.current !== "device") return;
        if (fresh) {
          applyDeviceOrigin(fresh);
          /* An explicit re-take from the スポット tab's buttons
             (the sort-status row / the notice block) also asks the
             spot map to fly to the fresh position. The mount-time
             initial read and selectSort("device") pass no target:
             their framing stays with each map's own initial
             handling. */
          if (cameraTarget === "spots") {
            setMapCameraRequest({
              seq: ++mapCameraSeqRef.current,
              target: "spots",
              lat: fresh.lat,
              lng: fresh.lng,
              capturedAtMs: fresh.capturedAtMs,
            });
          }
          return;
        }
        setSortOrigin(null);
        setOriginKind(null);
        setDeviceOriginAt(null);
        setDeviceNotice(
          data === null
            ? { kind: "error" }
            : data.capturedAtMs !== null
              ? { kind: "stale", at: data.capturedAtMs }
              : { kind: "none" },
        );
      })();
      // applyDeviceOrigin only sets state; it is stable in effect.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [refreshDeviceLocation],
  );
  /* The map-only re-take behind the maps' own
     「Pixelの位置を取り直す」 buttons. It reads the same stored
     position through the same freshness rule and the same sequence
     guard as the sort route, but touches NOTHING on the sort side —
     no sortOrigin, originKind, deviceOriginAt, deviceNotice, page,
     or list order — so a map button works identically whatever the
     list's sort choice is. On success it updates the maps' shared
     deviceLocation and mints a camera request for the target map,
     so the marker moves AND the camera flies to it. The outcome is
     returned to the caller: on failure no camera request is issued
     (the camera stays put, the previous marker stays) and the
     button reports the reason next to itself. When this request is
     still the newest when it lands, it also releases devicePending
     — it may have overtaken the sort route's own read, whose
     pending flag would otherwise be left behind. */
  const retakeMapDeviceLocation = useCallback(
    async (target: "spots" | "visited"): Promise<RetakeDeviceResult> => {
      const requestId = ++deviceRequestSeqRef.current;
      const data = await Promise.race([
        refreshDeviceLocation(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), DEVICE_READ_TIMEOUT_MS),
        ),
      ]);
      if (deviceRequestSeqRef.current !== requestId) {
        return { ok: false, reason: "superseded", at: null };
      }
      setDevicePending(false);
      const fresh = freshDeviceCoords(data);
      if (fresh) {
        setDeviceLocation(fresh);
        setMapCameraRequest({
          seq: ++mapCameraSeqRef.current,
          target,
          lat: fresh.lat,
          lng: fresh.lng,
          capturedAtMs: fresh.capturedAtMs,
        });
        return { ok: true };
      }
      if (data === null) return { ok: false, reason: "error", at: null };
      if (data.capturedAtMs !== null) {
        return { ok: false, reason: "stale", at: data.capturedAtMs };
      }
      return { ok: false, reason: "none", at: null };
    },
    [refreshDeviceLocation],
  );
  const selectSort = (choice: "default" | "map" | "device") => {
    /* Any in-flight position request belongs to the previous choice;
       bumping the sequence retires it before the new route starts. */
    deviceRequestSeqRef.current += 1;
    /* Sync the ref in the same breath: sortChoiceRef is also written
       during render, but a position answer can land before that
       render commits (and a discarded concurrent render loses the
       write entirely), which used to make the fresh answer fail the
       choice check and stick the pending note. The render-time
       write stays as the backstop for state set elsewhere. */
    sortChoiceRef.current = choice;
    setSortChoice(choice);
    setPage(0);
    if (choice === "default") {
      setSortOrigin(null);
      setOriginKind(null);
      setDeviceOriginAt(null);
      setDevicePending(false);
      setDeviceNotice(null);
    } else if (choice === "map") {
      setSortOrigin(readSpotMapCenter());
      setOriginKind("map");
      setDeviceOriginAt(null);
      setDevicePending(false);
      setDeviceNotice(null);
    } else {
      acquireDeviceOrigin();
    }
  };
  /* The distance order is active only once an origin exists; while
     the Pixel position is being read or cannot be used, the list
     keeps the default order rather than sorting around a point the
     reader never gave. */
  const distanceActive =
    sortChoice !== "default" && sortOrigin !== null && originKind !== null;
  /* Initial Pixel read for the default sort: exactly once on mount.
     It goes through acquireDeviceOrigin itself, so the read carries
     the same 12 s cap and sequence guards as a manual pick — and if
     the reader changes the sort before the answer lands, the answer
     is dropped by those guards and the manual choice stands. A
     stale / absent / unreadable stored position leaves sortOrigin
     null, so the list renders in the standard order under the
     device notice with its existing fallback buttons. */
  const initialDeviceSortRef = useRef(false);
  useEffect(() => {
    if (initialDeviceSortRef.current) return;
    initialDeviceSortRef.current = true;
    acquireDeviceOrigin();
  }, [acquireDeviceOrigin]);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState<Spot | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Spot | null>(null);
  /* Phase 3 — spot detail. selectedId is the row the reader picked;
     selectedSnapshot keeps the last known copy of that spot so the
     detail stays usable even when a change (e.g. marking it visited
     under the 未訪問 filter) drops the row out of the current page. */
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Spot | null>(null);
  /* Shared selection number for the detail pane (subtask 1216,
     review medium): every selection-changing operation — row tap,
     map tap, closing the detail — takes the next number, and the
     async getSpot behind a map tap applies its response only while
     its number is still the latest, so a slow response can never
     overwrite a newer pick or reopen a closed detail. Deleting a
     spot does not take the next number (re-review medium): it only
     invalidates an in-flight fetch for that same spot, so a delete
     landing mid-fetch can never drop another spot's response. */
  const selectionSeqRef = useRef(createSelectionSequencer());
  /* Short notice for a map tap whose full row could not be fetched
     (request failed, or the spot is gone): without it the tap looks
     exactly like the old "tap does nothing" bug. It dismisses
     itself after a few seconds, like the save-success pill. */
  const [spotFetchNotice, setSpotFetchNotice] = useState<string | null>(null);
  const spotFetchNoticeTimerRef = useRef<number | null>(null);
  const showSpotFetchNotice = useCallback((message: string) => {
    setSpotFetchNotice(message);
    if (spotFetchNoticeTimerRef.current !== null) {
      window.clearTimeout(spotFetchNoticeTimerRef.current);
    }
    spotFetchNoticeTimerRef.current = window.setTimeout(
      () => setSpotFetchNotice(null),
      4000,
    );
  }, []);
  const clearSpotFetchNotice = useCallback(() => {
    if (spotFetchNoticeTimerRef.current !== null) {
      window.clearTimeout(spotFetchNoticeTimerRef.current);
      spotFetchNoticeTimerRef.current = null;
    }
    setSpotFetchNotice(null);
  }, []);
  const sheetRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const listRef = useRef<HTMLUListElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const lastRowIndexRef = useRef(0);
  /* Wide layout (xl, 1280px+): the detail is a side pane; below that
     it is a modal bottom sheet with a focus trap. This boolean only
     steers focus behavior — the pane/sheet itself is one element
     whose look switches purely by responsive classes, so a resize or
     rotation never remounts it and form input survives. */
  const [isWide, setIsWide] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1280px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setIsWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const [showAllLists, setShowAllLists] = useState(false);
  /* Bottom tab bar: スポット (spot list), 市区町村 (the fill
     map + ledger), 路線 (the same fill map, lines as the hero +
     the operator-grouped ridden-lines list), その他 (dashboard /
     add-import / settings). All state lives in this component, so
     switching tabs never loses filters or form input. The second
     tab IS the fill map (the reader's request): it opens straight
     onto the pinned fill map — the old 訪問記録 / スポット分布
     toggle is gone, and the all-spots distribution map that used
     to follow below the fill map was removed at the reader's
     request. The 市区町村 / 路線 split (2026-11-25, subtask
     1439) shares ONE VisitedMapSection between the two tabs, and
     the unification (2026-11-25, subtask 1460) extends that one
     mount to the スポット tab too: the section, its map, and
     every loaded dataset mount once, and a switch only flips
     which family is the hero and which is the ghost underlay —
     see RecordMapVariant in map-variant.ts. */
  const [tab, setTab] = useState<"spots" | "map" | "lines" | "more">("spots");
  /* Map fullscreen (subtask 1484): one shared flag for the shared
     map section, so switching tabs while fullscreen keeps the
     newly shown map fullscreen too — the bottom tab bar stays on
     top of the map (z-40 over the map pane's z-30) precisely so
     the reader can switch tabs without leaving fullscreen. */
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const toggleMapFullscreen = useCallback(() => {
    setMapFullscreen((v) => !v);
  }, []);
  /* Esc leaves fullscreen (the CSS fullscreen has no browser
     chrome to do it), and the page behind the fixed map must not
     scroll while the map owns the viewport. The scroll lock is
     the shared one (scroll-lock.ts): the spot detail sheet can
     hold it at the same time, and the page unlocks only when
     the last holder leaves. Escape is NOT consumed here when a
     foreground layer already handled it: the detail sheet and
     the delete dialog listen on document — ahead of this
     window listener — and stop the event's propagation when
     they close, so one Esc press closes only the front layer
     (v89 review round 1, finding 5). */
  useEffect(() => {
    if (!mapFullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMapFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const releaseScrollLock = acquireScrollLock();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      releaseScrollLock();
    };
  }, [mapFullscreen]);
  /* Fullscreen is carried between the MAP tabs only (v89 review
     round 1, finding 4): the その他 tab has no map, so moving
     there exits fullscreen — otherwise the map and its exit
     button unmount while the flag (and the scroll lock above)
     stay on, freezing the dashboard's scroll until the reader
     happens back onto a map tab. */
  useEffect(() => {
    if (tab === "more") setMapFullscreen(false);
  }, [tab]);
  /* Save-failure messages rendered next to the control that failed.
     Each mutation below reports through onError into one of these, so
     the SDK's bottom failure notice never duplicates an in-page error. */
  const [addError, setAddError] = useState<string | null>(null);
  const [listActionError, setListActionError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [radiusError, setRadiusError] = useState<string | null>(null);
  const [memoTeaseError, setMemoTeaseError] = useState<string | null>(null);

  /* Phase 5 — one shared save-success notice. Every successful save
     (spot add / edit, visit toggle, radius, memo-tease switch and
     template) raises the same 「保存しました」 pill the radius setting
     pioneered, rendered once at the root; it dismisses itself after
     a few seconds. A failed save clears it in the mutation's onError,
     so the success pill and an inline failure message never appear
     together. */
  const [savedAt, setSavedAt] = useState(0);
  const savedTimerRef = useRef<number | null>(null);
  const notifySaved = useCallback(() => {
    setSavedAt(Date.now());
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => setSavedAt(0), 2500);
  }, []);
  const clearSaved = useCallback(() => {
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = null;
    setSavedAt(0);
  }, []);
  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    },
    [],
  );

  /* Phase 5 — manual theme preference. "system" (the default) leaves
     <html> without a data-theme attribute so the prefers-color-scheme
     media query in theme.css decides; "light" / "dark" set the
     attribute, whose rules outrank the media query. The switch only
     flips an attribute on the root element — nothing remounts, so
     in-progress form input, the selected spot, and the list filters
     all survive it. The choice persists in localStorage. */
  const [theme, setTheme] = useState<"system" | "light" | "dark">(() => {
    try {
      const v = window.localStorage.getItem("spots-theme");
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("spots-theme", theme);
    } catch {
      /* storage unavailable (private mode etc.) — the in-page
         switch still applies for this session. */
    }
  }, [theme]);

  /* Debounce the search box so typing doesn't fire a query per keystroke. */
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  /* Dashboard auto-refresh: poll the aggregate numbers every 15s while the
     page is visible, so geocoding-batch progress shows up without a manual
     reload. The spot list itself is deliberately NOT polled — it must not
     change under the user while they browse or edit. */
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const dashboardPoll = pageVisible ? 15_000 : false;

  /* Phase 4 polling bookkeeping. Every dashboard fetch (the 15s poll,
     a manual retry, an edit-triggered refetch) is stamped with a
     sequence number when it starts. Two guards build on the stamps:
       - the 最終更新 clock (pollSuccessAt) advances only when a fetch
         succeeds, and the failure note next to it comes from the
         queries' refetch-error state — both live in their own strip
         under the dashboard heading, so a poll can update them
         without the aggregates or the list rows moving;
       - invalidate() (below, run by every completed edit) records
         editSeq; the snapshot guard under the queries then refuses
         to display data from a fetch that started before that edit,
         so a slow poll response can never roll the dashboard back
         over a save that finished while it was in flight. */
  const pollRef = useRef({ seq: 0, lastOkAt: 0, lastSuccessAt: 0, editSeq: 0 });
  const [pollSuccessAt, setPollSuccessAt] = useState(0);
  const statsFetchSeqRef = useRef(0);
  const listsFetchSeqRef = useRef(0);
  const tagsFetchSeqRef = useRef(0);
  const beginPoll = useCallback(() => ++pollRef.current.seq, []);
  const notePollSuccess = useCallback((seq: number) => {
    const s = pollRef.current;
    if (seq < s.lastOkAt) return;
    s.lastOkAt = seq;
    s.lastSuccessAt = Date.now();
    setPollSuccessAt((prev) => (prev === s.lastSuccessAt ? prev : s.lastSuccessAt));
  }, []);

  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: async () => {
      const seq = beginPoll();
      statsFetchSeqRef.current = seq;
      const data = await api.getStats({});
      notePollSuccess(seq);
      return data;
    },
    refetchInterval: dashboardPoll,
    structuralSharing: (oldData, newData) => shareJson(oldData, newData),
  });
  const listsQuery = useQuery({
    queryKey: ["lists"],
    queryFn: async () => {
      const seq = beginPoll();
      listsFetchSeqRef.current = seq;
      const data = await api.listLists({});
      notePollSuccess(seq);
      return data;
    },
    refetchInterval: dashboardPoll,
    structuralSharing: (oldData, newData) =>
      shareLists(oldData as ListsData | undefined, newData as ListsData),
  });
  const tagsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: async () => {
      const seq = beginPoll();
      tagsFetchSeqRef.current = seq;
      const data = await api.listTags({});
      notePollSuccess(seq);
      return data;
    },
    refetchInterval: dashboardPoll,
    structuralSharing: (oldData, newData) => shareJson(oldData, newData),
  });

  /* Edit guard: each aggregate's display snapshot is accepted only
     from a fetch that started after the last completed edit. A
     pre-edit poll response that lands late stays in the query cache
     but never becomes the snapshot, so what the dashboard shows is
     never rolled back over a finished save. */
  const statsSnapRef = useRef<StatsData | null>(null);
  if (stats.data && statsFetchSeqRef.current > pollRef.current.editSeq) {
    statsSnapRef.current = stats.data;
  }
  const displayStats: StatsData | null = statsSnapRef.current ?? stats.data ?? null;
  const listsSnapRef = useRef<ListsData | null>(null);
  if (listsQuery.data && listsFetchSeqRef.current > pollRef.current.editSeq) {
    listsSnapRef.current = listsQuery.data;
  }
  const displayLists: ListsData | null = listsSnapRef.current ?? listsQuery.data ?? null;
  const listNames = displayLists?.lists.map((l) => l.name) ?? [];
  const tagsSnapRef = useRef<TagsData | null>(null);
  if (tagsQuery.data && tagsFetchSeqRef.current > pollRef.current.editSeq) {
    tagsSnapRef.current = tagsQuery.data;
  }
  const displayTags: TagsData | null = tagsSnapRef.current ?? tagsQuery.data ?? null;
  const allTags = displayTags?.tags ?? [];
  /* A background poll that failed while cached data is on screen:
     the aggregates keep showing the last good numbers, the clock
     keeps the last success time, and the heading strip adds the
     failure note. */
  const pollFailed = stats.isRefetchError || listsQuery.isRefetchError || tagsQuery.isRefetchError;
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.getSettings({}) });
  const radiusM = settings.data?.radiusM ?? 500;

  /* The listSpots query key, shared with the stagger key below: the
     stagger's notion of "the same display" must always match the
     query's — sort order included, and null kept apart from "null"
     by JSON (a template string would collapse both to "null"). */
  const spotsQueryKey = [
    "spots",
    {
      filter,
      search,
      listFilter,
      tagFilter,
      memoOnly,
      page,
      /* The origin is part of the key so a re-taken position starts
         a fresh distance order, while page turns and filter changes
         reuse the SAME fixed origin. */
      sort: distanceActive && sortOrigin
        ? `distance:${originKind}:${sortOrigin.lat},${sortOrigin.lng}`
        : "default",
    },
  ];

  const spotsQuery = useQuery({
    queryKey: spotsQueryKey,
    queryFn: () =>
      api.listSpots({
        filter,
        query: search,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        list: listFilter,
        tag: tagFilter,
        memoOnly,
        ...(distanceActive && sortOrigin
          ? {
              sort: "distance" as const,
              originLat: sortOrigin.lat,
              originLng: sortOrigin.lng,
            }
          : {}),
      }),
    placeholderData: (prev) => prev,
  });

  /* Subtask 450 — first-render stagger for the spot list (design
     memo: stagger only the first display's top rows, to lead the
     eye). Round-1 re-review fix: the first non-empty display pins
     its top six row ids, so paging, filtering, and tab changes
     never re-animate; the view key (tab / page / filters) ends the
     stagger as soon as it changes, and the 800ms end timer lives
     in its own effect, independent of list-data updates — a data
     change inside the window used to clear the timer while the
     class stayed on, replaying the stagger on every later
     display. Reduced motion removes the travel in theme.css. */
  const [staggerIds, setStaggerIds] = useState<number[] | null>(null);
  const staggerArmedRef = useRef(false);
  /* Round-2 re-review fix: the display key is the shared query key
     (tab + every listSpots parameter, sort order included) via JSON,
     so switching to distance order ends the stagger at once, and a
     list literally named "null" no longer collides with no list
     selected — JSON keeps null and "null" apart, where a template
     string collapsed both to "null". */
  const staggerKey = JSON.stringify([tab, spotsQueryKey]);
  const staggerKeyRef = useRef(staggerKey);
  /* Arm once: the first non-empty スポット list pins its top six
     ids. Later data updates (polls, edits) never re-arm it. */
  useEffect(() => {
    if (tab !== "spots" || !spotsQuery.data || staggerArmedRef.current) return;
    const ids = (spotsQuery.data.spots ?? []).slice(0, 6).map((s) => s.id);
    if (ids.length === 0) return;
    staggerArmedRef.current = true;
    staggerKeyRef.current = staggerKey;
    setStaggerIds(ids);
  }, [tab, spotsQuery.data, staggerKey]);
  /* End the stagger when the view changes (page, filter, tab) —
     the pinned ids belong to the first display only. */
  useEffect(() => {
    if (!staggerArmedRef.current) return;
    if (staggerKey === staggerKeyRef.current) return;
    setStaggerIds(null);
  }, [staggerKey]);
  /* End timer, independent of list-data updates: its only
     dependency is the pinned ids, so a refresh inside the window
     cannot cancel the timer while the class stays on. */
  useEffect(() => {
    if (staggerIds === null) return;
    const t = window.setTimeout(() => setStaggerIds(null), 800);
    return () => window.clearTimeout(t);
  }, [staggerIds]);

  const invalidate = () => {
    /* Stamp the edit: fetches that started before this moment must
       not become the dashboard display anymore (see the snapshot
       guard above), even if their responses land after the refetch
       this invalidation triggers. */
    pollRef.current.editSeq = pollRef.current.seq;
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["lists"] });
    void queryClient.invalidateQueries({ queryKey: ["tags"] });
    void queryClient.invalidateQueries({ queryKey: ["spots"] });
    /* The spot list map's plotted points come from the same query;
       a spot edit / visit toggle / delete must not leave them stale. */
    void queryClient.invalidateQueries({ queryKey: ["spotPoints"] });
  };

  const addMutation = useMutation({
    mutationFn: async (row: ImportRow & { name: string }) => await api.addSpot(row),
    onSuccess: () => { setAddError(null); notifySaved(); invalidate(); setShowAdd(false); },
    onError: () => { clearSaved(); setAddError("追加に失敗しました。もう一度お試しください。"); },
  });
  const updateMutation = useMutation({
    mutationFn: async (args: { id: number; row: ImportRow & { name: string } }) =>
      await api.updateSpot({ id: args.id, ...args.row }),
    onSuccess: (_data, variables) => {
      setListActionError(null);
      notifySaved();
      /* Keep the detail's snapshot in step with the saved values —
         the edited spot may not be on the current page afterwards. */
      setSelectedSnapshot((prev) =>
        prev && prev.id === variables.id
          ? {
              ...prev,
              name: variables.row.name,
              note: variables.row.note ?? null,
              url: variables.row.url ?? null,
              address: variables.row.address ?? null,
              category: variables.row.category ?? prev.category,
              tags: variables.row.tags ?? [],
              lat: variables.row.lat ?? null,
              lng: variables.row.lng ?? null,
            }
          : prev,
      );
      invalidate();
      setEditing(null);
    },
    onError: () => { clearSaved(); setListActionError("保存に失敗しました。もう一度お試しください。"); },
  });
  const visitedMutation = useMutation({
    mutationFn: async (args: { id: number; visited: boolean }) => await api.setVisited(args),
    onSuccess: (_data, variables) => {
      setListActionError(null);
      notifySaved();
      setSelectedSnapshot((prev) =>
        prev && prev.id === variables.id
          ? {
              ...prev,
              visited: variables.visited,
              visited_at: variables.visited ? new Date().toISOString() : null,
            }
          : prev,
      );
      invalidate();
    },
    onError: () => { clearSaved(); setListActionError("訪問状態の変更に失敗しました。もう一度お試しください。"); },
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteSpot({ id }),
    onSuccess: (_data, variables) => {
      setDeleteError(null);
      invalidate();
      setConfirmDelete(null);
      /* Two separate steps (re-review of subtask 1216, medium):
         (1) invalidate an in-flight getSpot for the deleted spot
         itself, so its response can never open a spot that is
         gone; (2) if the detail is showing the deleted spot, close
         it — a purely local step that takes no selection number.
         A global next() here would also kill an unrelated fetch
         already in flight for the next spot the reader tapped. */
      selectionSeqRef.current.invalidateFor(variables);
      /* Deleting the spot whose detail is open closes the detail;
         the focus-restore effect then lands on a nearby row. */
      if (selectedId === variables) {
        setSelectedId(null);
        setSelectedSnapshot(null);
      }
      if (editing?.id === variables) setEditing(null);
    },
    onError: () => setDeleteError("削除に失敗しました"),
  });
  const radiusMutation = useMutation({
    mutationFn: async (r: number) => await api.updateSettings({ radiusM: r }),
    onSuccess: () => {
      setRadiusError(null);
      notifySaved();
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: () => { clearSaved(); setRadiusError("設定の保存に失敗しました"); },
  });
  const memoTeaseMutation = useMutation({
    mutationFn: async (args: { memoTeaseEnabled?: boolean; memoTeaseTemplate?: string }) =>
      await api.updateSettings(args),
    onSuccess: () => {
      setMemoTeaseError(null);
      notifySaved();
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      setTemplateDraft(null);
    },
    onError: () => { clearSaved(); setMemoTeaseError("呼びかけ設定の保存に失敗しました"); },
  });

  /* ----- import ----- */
  const fileRef = useRef<HTMLInputElement>(null);
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importCategory, setImportCategory] = useState("行ってみたい");
  const [importState, setImportState] = useState<
    | { phase: "idle" }
    | { phase: "working"; done: number; total: number }
    | { phase: "done"; inserted: number; updated: number; tagsUpdated: number; skipped: number }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const handleFile = async (file: File) => {
    setImportState({ phase: "idle" });
    setImportRows(null);
    try {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      const rows = lower.endsWith(".csv")
        ? csvToSpots(text, importCategory)
        : geoJsonToSpots(text, importCategory);
      setImportFileName(file.name);
      setImportRows(rows);
      if (rows.length === 0) {
        setImportState({ phase: "error", message: "このファイルからスポットを読み取れませんでした" });
      }
    } catch {
      setImportState({ phase: "error", message: "ファイルの読み込みに失敗しました" });
    }
  };

  const runImport = async () => {
    if (!importRows) return;
    setImportState({ phase: "working", done: 0, total: importRows.length });
    let inserted = 0;
    let updated = 0;
    let tagsUpdated = 0;
    let skipped = 0;
    try {
      const CHUNK = 300;
      for (let i = 0; i < importRows.length; i += CHUNK) {
        const chunk = importRows.slice(i, i + CHUNK);
        const res = await api.bulkImportSpots({ spots: chunk });
        inserted += res.inserted;
        updated += res.updated;
        tagsUpdated += res.tagsUpdated;
        skipped += res.skipped;
        setImportState({ phase: "working", done: Math.min(i + CHUNK, importRows.length), total: importRows.length });
      }
      setImportState({ phase: "done", inserted, updated, tagsUpdated, skipped });
      setImportRows(null);
      invalidate();
    } catch {
      setImportState({ phase: "error", message: "取り込みの途中で失敗しました（取り込み済みの分は保存されています）" });
      invalidate();
    }
  };

  const total = displayStats?.total ?? 0;
  const visitedCount = displayStats?.visited ?? 0;
  const remaining = displayStats?.remaining ?? 0;
  const withCoords = displayStats?.withCoords ?? 0;
  const withMemo = displayStats?.withMemo ?? 0;
  const completionPct = total > 0 ? Math.round((visitedCount / total) * 100) : 0;

  const memoTeaseEnabled = settings.data?.memoTeaseEnabled ?? true;
  const memoTeaseTemplate =
    templateDraft ??
    settings.data?.memoTeaseTemplate ??
    "「{メモ}」って書いてあったけど、こんなの気になっちゃってるの〜？ざぁこ♡";

  const pageSpots = spotsQuery.data?.spots ?? [];
  const previewSpot = pageSpots.find((s) => s.note?.trim());
  const previewName = previewSpot?.name ?? "スポット名";
  const previewMemo = previewSpot?.note ?? "ここにメモの内容が入ります";
  const previewCallout = memoTeaseTemplate
    .replaceAll("{メモ}", previewMemo)
    .replaceAll("{スポット名}", previewName);
  const pageTotal = spotsQuery.data?.total ?? 0;

  /* The spot shown in the detail pane / bottom sheet: the live row
     when it is on the current page, else the last known snapshot (the
     row can leave the page when a filter change or a visit toggle
     drops it, but the detail must not lose its subject). */
  const selectedSpot =
    (selectedId !== null ? pageSpots.find((s) => s.id === selectedId) : undefined) ??
    (selectedSnapshot && selectedSnapshot.id === selectedId ? selectedSnapshot : null);
  const selectedMapsHref = selectedSpot ? spotMapsHref(selectedSpot) : null;

  /* Keep the snapshot fresh from the live page whenever the selected
     spot is on it, so outside changes show up in the detail too. */
  useEffect(() => {
    if (selectedId === null) return;
    const live = pageSpots.find((s) => s.id === selectedId);
    if (live) setSelectedSnapshot(live);
  }, [pageSpots, selectedId]);
  const pageCount = Math.max(1, Math.ceil(pageTotal / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);

  const allLists = displayLists?.lists ?? [];
  const visibleLists = showAllLists ? allLists : allLists.slice(0, 8);

  const pickList = (name: string | null) => {
    setListFilter(name);
    setPage(0);
    /* List rows also live on the dashboard (その他 tab): picking one
       there should land the user on the filtered spot list. */
    setTab("spots");
  };

  const pickTag = (name: string | null) => {
    setTagFilter(name);
    setPage(0);
  };

  /* ----- spot detail (phase 3) ----- */

  const openDetail = (spot: Spot, index: number) => {
    selectionSeqRef.current.next();
    clearSpotFetchNotice();
    lastRowIndexRef.current = index;
    setSelectedId(spot.id);
    setSelectedSnapshot(spot);
    /* Picking a different row abandons an edit of the previous one —
       the form lives in the detail now, never inside a row. */
    if (editing && editing.id !== spot.id) setEditing(null);
  };

  /* A tap on a spot plotted on the pinned map opens the same detail
     as a row tap. When the spot is on the current page its row is
     the source, exactly as openDetail. Otherwise the full row is
     fetched by id first: the map's point payload truncates the memo
     at 200 chars and carries no visited_at, so it must never seed
     the detail (or, worse, an edit) itself. */
  const openDetailFromMap = (point: SpotMapPoint) => {
    const onPage = pageSpots.find((s) => s.id === point.id);
    if (onPage) {
      openDetail(onPage, pageSpots.indexOf(onPage));
      return;
    }
    /* Take this tap's selection number before the fetch starts,
       tagged with the spot id so deleting that one spot can
       invalidate this request on its own; any later selection
       (another tap, a row pick, closing the detail) supersedes it,
       and a superseded response is dropped instead of overwriting
       the newer state. */
    const seq = selectionSeqRef.current.nextFor(point.id);
    clearSpotFetchNotice();
    void (async () => {
      try {
        const res = await api.getSpot({ id: point.id });
        if (!selectionSeqRef.current.isCurrent(seq)) return;
        if (!res.spot) {
          showSpotFetchNotice(
            "そのスポットは見つかりませんでした（削除された可能性があります）",
          );
          return;
        }
        setSelectedId(res.spot.id);
        setSelectedSnapshot(res.spot);
        if (editing && editing.id !== res.spot.id) setEditing(null);
      } catch {
        if (!selectionSeqRef.current.isCurrent(seq)) return;
        showSpotFetchNotice(
          "スポットの詳細を取得できませんでした。通信状態を確認してもう一度タップしてください",
        );
      }
    })();
  };

  const closeDetail = () => {
    selectionSeqRef.current.next();
    setSelectedId(null);
    setEditing(null);
  };

  /* When the detail closes, focus returns to the row that opened it.
     If that row has left the list meanwhile (e.g. it was marked
     visited under the 未訪問 filter, or deleted), focus lands on the
     row now at the same position, or on the list heading when the
     page is empty — never on a dead element or the body. */
  const prevSelectedIdRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevSelectedIdRef.current;
    prevSelectedIdRef.current = selectedId;
    if (prev === null || selectedId !== null) return;
    requestAnimationFrame(() => {
      const row = rowRefs.current.get(prev);
      if (row && document.contains(row)) {
        row.focus();
        return;
      }
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-spot-row]");
      const target =
        rows && rows.length > 0
          ? rows[Math.min(lastRowIndexRef.current, rows.length - 1)]
          : undefined;
      if (target) target.focus();
      else headingRef.current?.focus();
    });
  }, [selectedId]);

  /* Escape closes the detail — or, while editing, first cancels the
     edit back to the detail view. The delete dialog, when open, owns
     the key instead. The event's propagation stops here: this
     handler sits on document, ahead of the fullscreen map's window
     listener, so one Esc press closes only this front layer and
     leaves fullscreen for the next press (v89 review round 1,
     finding 5). The handler lives only while the detail itself
     is on screen — the スポット tab: the selection can outlive
     its pane when the reader carries it into a record tab (and
     into fullscreen there), and an invisible detail must not
     sit in front of the fullscreen map's own Esc (v89 review
     round 2, finding 3). */
  useEffect(() => {
    if (selectedId === null || confirmDelete || tab !== "spots") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (editing) {
        setEditing(null);
        requestAnimationFrame(() => {
          sheetRef.current?.querySelector<HTMLElement>("[data-detail-close]")?.focus();
        });
      } else {
        closeDetail();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId, confirmDelete, editing, tab]);

  /* The delete confirmation dialog owns Escape while it is open
     (phase 5): it closes exactly like its キャンセル button and the
     backdrop click do — the detail sheet's handler above stays out
     of the way because it returns early while confirmDelete is set,
     and focus after the close is untouched, as with those paths. */
  useEffect(() => {
    if (!confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setConfirmDelete(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDelete]);

  /* Bottom-sheet behavior (below xl only): focus starts inside the
     sheet, Tab is trapped within it, and the list behind it does not
     scroll. At xl the same element is a plain side pane and none of
     this applies. The initial focus move happens only on a fresh
     open (selectedId null → non-null): sheetOpenMobile also flips
     true when the viewport crosses below xl with the detail already
     open, and that resize must not steal focus back from whatever
     the user is doing (e.g. editing the memo) — the trap and the
     scroll lock still engage, only the focus grab is skipped. The
     tracking effect below is declared after this one so that, in a
     commit where both run, this effect still reads the previous
     selectedId. */
  const sheetPrevSelectedRef = useRef<number | null>(null);
  const sheetOpenMobile = selectedId !== null && !isWide && tab === "spots";
  useEffect(() => {
    if (!sheetOpenMobile) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const freshOpen = sheetPrevSelectedRef.current === null;
    const FOCUSABLE =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = () =>
      Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
    if (freshOpen) focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    /* The shared scroll lock (scroll-lock.ts), not a private
       save/restore: over the fullscreen map this sheet is the
       second holder, and the page unlocks only when both have
       released (v89 review round 1, finding 5). */
    const releaseScrollLock = acquireScrollLock();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      releaseScrollLock();
    };
  }, [sheetOpenMobile]);

  /* Keeps sheetPrevSelectedRef in step with selectedId on every
     change (open, switch, close), so the sheet effect above can
     tell a fresh open apart from a resize-driven re-entry. */
  useEffect(() => {
    sheetPrevSelectedRef.current = selectedId;
  }, [selectedId]);

  /* Wide layout (xl+): the detail is a side pane rather than a
     modal, but opening it from a row still moves focus into the
     pane — onto its close button (phase 4 fix for the phase 3
     review). Only the open transition does this: resizing into xl
     with the pane already open must not steal focus, and below xl
     the bottom-sheet effect above owns focus entirely. */
  const prevSelectedWideRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevSelectedWideRef.current;
    prevSelectedWideRef.current = selectedId;
    if (!isWide || tab !== "spots") return;
    if (prev !== null || selectedId === null) return;
    requestAnimationFrame(() => {
      sheetRef.current?.querySelector<HTMLElement>("[data-detail-close]")?.focus();
    });
  }, [selectedId, isWide, tab]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      {/* Widening: on wide screens every tab gets the wider column
          (max-w-5xl from 1280px up) — the spot list so long memos
          and card actions have room (phase 1), the map tab so the
          visited view can run two columns (phase 2), and the その他
          tab so the dashboard and the management sections can sit
          side by side (phase 4). The width is a plain class switch
          on the same element, and nothing remounts on resize or
          theme change. On the その他 tab the same <main> also
          becomes the two-column grid at xl; the sections (and the
          right-column wrapper) carry the placement classes, so below
          xl they stack in the exact
          previous reading order (dashboard → add/import → settings),
          with the tab's top padding moved onto <main> so the two
          columns start at the same height. Subtask 450: from 1536px
          up the column widens again (2xl:max-w-7xl, 1280px of
          content) so the dashboard's stats strip can span the full
          width and the スポット tab can run its controls as a left
          rail beside the list; below 2xl nothing changes. Round-1
          re-review fix: the 2xl widening applies to the スポット
          and その他 tabs only — on the map tab the wider column
          also stretched the fallback image (385px → 545px tall)
          and pushed the 「地図を再読み込み」 button off-screen at
          1600×600, so the map tab keeps the xl width. */}
      <main className={`mx-auto w-full max-w-3xl px-4 pb-28 xl:max-w-5xl ${tab === "spots" || tab === "more" ? "2xl:max-w-7xl" : ""} ${tab === "more" ? "pt-5 xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-x-6" : ""}`}>
        {/* ===== dashboard (その他 tab) =====
            Subtask 450: the stats + progress strip spans the full
            width at xl (col 1 / -1), so the five stat cells get
            room instead of squeezing into the left column; the
            リスト別 block below is its own section in the left
            column. Below xl both sections stack in the previous
            reading order (stats → progress → lists). */}
        {tab === "more" && (
        <section aria-label="ダッシュボード" className="xl:col-start-1 xl:col-end-3 xl:row-start-1">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-bold">ダッシュボード</h2>
          {/* 最終更新 lives in its own strip under the heading: a
              successful poll updates only this strip (and a failed
              one adds its note here), never the aggregates or the
              list rows below, so nothing on the page moves. */}
          <div className="mt-1 flex min-h-5 flex-wrap items-baseline gap-x-2 text-xs text-[var(--dim)]">
            {pollSuccessAt > 0 && (
              <span>
                最終更新 {new Date(pollSuccessAt).toLocaleTimeString("ja-JP", { hour12: false })}
                {pageVisible ? "（15秒ごとに自動更新）" : "（自動更新は一時停止中）"}
              </span>
            )}
            {pollFailed && <span className="font-medium text-[var(--signal)]">更新に失敗しました</span>}
          </div>
          {/* First load only (nothing displayable yet): the layout
              skeleton of the stats grid and the progress bars. Once
              data exists, polls keep showing it — the skeleton never
              comes back. */}
          {stats.isPending && (
            <div className="mt-3" role="status" aria-label="集計を読み込み中">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3">
                    <div className="h-3 w-12 rounded bg-[var(--surface-alt)]" />
                    <div className="mt-2 h-7 w-16 motion-safe:animate-pulse rounded bg-[var(--surface-alt)]" />
                  </div>
                ))}
              </div>
              <div className="mt-3 space-y-3 rounded-[var(--radius)] bg-[var(--surface)] p-3" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i}>
                    <div className="h-4 w-40 max-w-full rounded bg-[var(--surface-alt)]" />
                    <div className="mt-1 h-2 motion-safe:animate-pulse rounded-full bg-[var(--surface-alt)]" />
                  </div>
                ))}
              </div>
              <span className="sr-only">読み込み中…</span>
            </div>
          )}
          {stats.isError && (
            <p className="mt-3 text-sm text-[var(--signal)]">
              集計の読み込みに失敗しました{" "}
              <button type="button" className="underline" onClick={() => void stats.refetch()}>再試行</button>
            </p>
          )}
          {displayStats && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <StatCell label="総スポット" value={total.toLocaleString()} />
                <StatCell label="訪問済み" value={visitedCount.toLocaleString()} sub={`制覇率 ${completionPct}%`} accent />
                <StatCell label="未訪問" value={remaining.toLocaleString()} />
                <StatCell
                  label="座標付き"
                  value={withCoords.toLocaleString()}
                  sub={total > 0 ? `全体の ${Math.round((withCoords / total) * 100)}%` : undefined}
                />
                <StatCell
                  label="メモ付き"
                  value={withMemo.toLocaleString()}
                  sub={total > 0 ? `全体の ${Math.round((withMemo / total) * 100)}%` : undefined}
                />
              </div>
              <div className="mt-3 space-y-3 rounded-[var(--radius)] bg-[var(--surface)] p-3">
                <ProgressBar value={visitedCount} total={total} label="訪問の進み具合" />
                <ProgressBar value={withCoords} total={total} label="座標の付き具合（通知対象）" />
                <ProgressBar value={withMemo} total={total} label="メモの付き具合（通知で引用される）" />
              </div>
            </>
          )}
        </section>
        )}

        {/* Subtask 450 — the リスト別 block is its own section so
            the stats + progress strip above can span the full width
            at xl: the two sections stay adjacent in DOM order, so
            below xl the reading order is unchanged (stats → progress
            → lists → add/import → settings). The リスト別 section
            keeps its own {tab === "more"} conditional; the add/import
            and settings sections share one, inside their right-column
            wrapper (round-1 re-review fix). */}
        {tab === "more" && (
        <section aria-label="リスト別" className="xl:col-start-1 xl:row-start-2">
          {/* リスト別 loading: a plain 読み込み中… line (plus the
              rows' skeleton) on the first load only; polls with data
              on screen never swap back to it. */}
          {listsQuery.isPending && (
            <div className="mt-4" role="status" aria-label="リスト別件数を読み込み中">
              <p className="text-sm text-[var(--dim)]">読み込み中…</p>
              <div className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)] px-3" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="py-2.5">
                    <div className="h-4 w-32 max-w-full motion-safe:animate-pulse rounded bg-[var(--surface-alt)]" />
                    <div className="mt-1.5 h-1.5 rounded-full bg-[var(--surface-alt)]" />
                  </div>
                ))}
              </div>
            </div>
          )}
          {listsQuery.isError && (
            <p className="mt-3 text-sm text-[var(--signal)]">
              リスト一覧の読み込みに失敗しました{" "}
              <button type="button" className="underline" onClick={() => void listsQuery.refetch()}>再試行</button>
            </p>
          )}
          {allLists.length > 0 && (
            <div className="mt-4">
              <h3 className="text-sm font-medium text-[var(--dim)]">リスト別（{allLists.length}リスト）</h3>
              <ul className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)]">
                {visibleLists.map((l) => {
                  const pct = l.total > 0 ? Math.round((l.visited / l.total) * 100) : 0;
                  const active = listFilter === l.name;
                  return (
                    <li key={l.name}>
                      <button
                        type="button"
                        onClick={() => pickList(active ? null : l.name)}
                        aria-pressed={active}
                        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${active ? "bg-[var(--surface-alt)]" : ""}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{l.name}</span>
                          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-[var(--surface-alt)]">
                            <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-[var(--dim)]">
                          訪問 {l.visited.toLocaleString()} / {l.total.toLocaleString()}
                        </span>
                        <span className={`shrink-0 text-xs font-medium ${active ? "text-[var(--accent)]" : "text-[var(--dim)]"}`}>
                          {active ? "絞り込み中" : "絞り込む"}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {allLists.length > 8 && (
                <button
                  type="button"
                  onClick={() => setShowAllLists((v) => !v)}
                  className="mt-2 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium"
                >
                  {showAllLists ? "リストを折りたたむ" : `すべてのリストを見る（残り ${allLists.length - 8}件）`}
                </button>
              )}
            </div>
          )}
        </section>

        )}

        {/* ===== map tabs: ONE map serves all three =====
            The map section is the whole tab and opens directly
            (its map is pinned to the top of the viewport, fitted by
            default to the municipality the reader is in, or to
            location + nearest spot on the スポット tab). The old
            all-spots distribution map that followed below it was
            removed at the reader's request. The section renders
            while ANY map tab is active (the split, subtask 1439;
            the unification, subtask 1460): one mount serves all
            three, and `variant` alone decides which family is the
            hero — switching tabs never remounts the map or
            refetches a dataset. The スポット tab's controls and
            list ride inside it as children, so the pinned map
            stays put while the list scrolls (review round 1,
            finding 3). */}
        {(tab === "map" || tab === "lines" || tab === "spots") && (
          <VisitedMapSection
            active
            variant={tab === "spots" ? "spots" : tab === "lines" ? "lines" : "municipalities"}
            deviceLoc={deviceLocation}
            cameraRequest={mapCameraRequest}
            onRetakeDeviceLocation={() => retakeMapDeviceLocation("visited")}
            visitFilter={filter}
            listFilter={listFilter}
            tagFilter={tagFilter}
            search={search}
            centerGetterRef={spotMapCenterGetterRef}
            onSpotTap={openDetailFromMap}
            fullscreen={mapFullscreen}
            onToggleFullscreen={toggleMapFullscreen}
          >
            {/* ===== spot management (スポット tab) ===== */}
            {tab === "spots" && (
            <section aria-label="スポット管理" className="pt-3">
              {/* No visible heading row on this tab (the reader asked
                  for it gone, count line included); the sr-only h2 only
                  remains as the detail-close focus fallback target. The
                  map itself is the shared VisitedMapSection this
                  section renders inside as children (unification,
                  subtask 1460; review round 1, finding 3): the sticky
                  pane sits at the same position and size as before,
                  and this section holds only the controls and the list
                  below it. */}
              <h2 ref={headingRef} tabIndex={-1} className="sr-only">スポット管理</h2>

              {spotFetchNotice !== null && (
                <p className="mt-2 text-sm text-[var(--signal)]" role="alert">
                  {spotFetchNotice}
                </p>
              )}

              {/* Subtask 450 — wide layout (2xl only): below the sticky
                  map, the controls become a left rail and the list (+ the
                  phase-3 detail pane) takes the right column. Below 2xl
                  this wrapper is a plain div and everything stacks
                  exactly as before; only classes arrange it, so the
                  inputs never remount and focus, text, filters, and page
                  survive resizes. Round-1 re-review fix: the rail is no
                  longer sticky — with 34 tags it runs taller than the
                  viewport, and the sticky pin left the lower tags
                  unreachable even after 2500px of page scroll at
                  1536×600; as a normal in-flow column the whole rail
                  scrolls with the page. */}
              <div className="2xl:grid 2xl:grid-cols-[20rem_minmax(0,1fr)] 2xl:items-start 2xl:gap-x-6">
              {/* Management controls under the map, tidied into one
                  compact stack (DOM order stays search → visit state →
                  memo-only → sort → list → tags): the search box gets
                  its own full-width row; the visit-state chips and the
                  memo-only chip share one tighter row; the two selects
                  sit side by side in a two-column grid at every width,
                  each with its small label above it instead of a wide
                  label + full-width select row; the tag label rides
                  inline with its chips. Only classes arrange them — the
                  inputs never remount, so focus, text, filters, and page
                  survive resizes. */}
              <div className="mt-3 space-y-2 2xl:col-start-1 2xl:row-span-2">
                <div>
                  <label htmlFor="spot-search" className="sr-only">スポットを検索</label>
                  <input
                    id="spot-search"
                    className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5"
                    placeholder="名前・メモ・住所・タグで検索"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="flex gap-1.5" role="tablist" aria-label="訪問状態で絞り込む">
                  {(
                    [
                      ["unvisited", "未訪問"],
                      ["visited", "訪問済み"],
                      ["all", "すべて"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={filter === key}
                      onClick={() => { setFilter(key); setPage(0); }}
                      className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                        filter === key
                          ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                          : "bg-[var(--surface)] text-[var(--dim)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  </div>

                  <button
                    type="button"
                    aria-pressed={memoOnly}
                    onClick={() => { setMemoOnly((v) => !v); setPage(0); }}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                      memoOnly
                        ? "bg-[var(--signal)] text-white"
                        : "bg-[var(--surface)] text-[var(--dim)]"
                    }`}
                  >
                    メモありだけ
                  </button>
                </div>

                {/* Sort order (subtask 680): 「地図の中心から近い順」
                    snapshots the spot list map's center at the moment
                    it is chosen; the captured point is then fixed for
                    paging and filter changes. 「Pixelの位置から近い順」
                    reads the position the external location job stores
                    server-side and adopts it only while it is fresh
                    (30 minutes). Browser geolocation is not offered:
                    it cannot work in the in-app browser. */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label htmlFor="sort-order" className="mb-1 block text-xs text-[var(--dim)]">並び替え</label>
                    <select
                      id="sort-order"
                      value={sortChoice}
                      onChange={(e) =>
                        selectSort(e.target.value as "default" | "map" | "device")
                      }
                      className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                    >
                      <option value="default">標準（未訪問が先・名前順）</option>
                      <option value="device">Pixelの位置から近い順</option>
                      <option value="map">地図の中心から近い順</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="list-filter" className="mb-1 block text-xs text-[var(--dim)]">リスト</label>
                    <div className="flex items-center gap-1.5">
                      <select
                        id="list-filter"
                        value={listFilter ?? ""}
                        onChange={(e) => pickList(e.target.value === "" ? null : e.target.value)}
                        className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                      >
                        <option value="">すべてのリスト</option>
                        {listNames.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                      {listFilter && (
                        <button
                          type="button"
                          onClick={() => pickList(null)}
                          className="shrink-0 rounded-[var(--radius)] border border-[var(--border)] px-2.5 py-2 text-sm"
                        >
                          解除
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {allTags.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-[var(--dim)]">タグで絞り込む</span>
                    {allTags.map((t) => {
                      const active = tagFilter === t.name;
                      return (
                        <button
                          key={t.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => pickTag(active ? null : t.name)}
                          className={`rounded-full px-3 py-1.5 text-sm font-medium ${
                            active
                              ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                              : "bg-[var(--surface)] text-[var(--text)]"
                          }`}
                        >
                          {t.name}
                          <span className={`ml-1 text-xs ${active ? "" : "text-[var(--dim)]"}`}>{t.total}</span>
                        </button>
                      );
                    })}
                    {tagFilter && (
                      <button
                        type="button"
                        onClick={() => pickTag(null)}
                        className="rounded-full border border-[var(--border)] px-3 py-1.5 text-sm"
                      >
                        タグ絞り込みを解除
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Distance-sort status (subtask 680): while a distance
                  order is on screen, name its basis next to the list.
                  The standard order shows nothing here. */}
              {/* Subtask 450: one wrapper so the (mutually exclusive)
                  status blocks share a single 2xl grid cell above the
                  list — the wrapper is a plain div below 2xl. */}
              <div className="2xl:col-start-2 2xl:row-start-1">
              {distanceActive && originKind && (
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium text-[var(--accent)]">
                    {originKind === "device"
                      ? "Pixelの位置から近い順"
                      : "地図の中心から近い順"}
                    で表示中
                    {originKind === "device" && deviceOriginAt !== null && (
                      <>（{deviceAgeMinutes(deviceOriginAt)}分前の位置）</>
                    )}
                  </span>
                  {originKind === "device" && (
                    <button
                      type="button"
                      onClick={() => acquireDeviceOrigin("spots")}
                      disabled={devicePending}
                      className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm disabled:opacity-40"
                    >
                      {devicePending ? "確認中…" : "Pixelの位置を取り直す"}
                    </button>
                  )}
                </p>
              )}
              {sortChoice === "device" && devicePending && !distanceActive && (
                <p className="mt-2 text-sm text-[var(--dim)]">Pixelの位置を確認中…</p>
              )}
              {sortChoice === "device" && deviceNotice && !distanceActive && (
                <div className="mt-2 rounded-[var(--radius)] bg-[var(--signal-bg)] p-3 text-sm" role="alert">
                  <p>
                    {deviceNotice.kind === "stale"
                      ? `Pixelの位置が古いため（${new Date(deviceNotice.at).toLocaleString("ja-JP")}に取得）、並び替えは行っていません。`
                      : deviceNotice.kind === "error"
                        ? "Pixelの位置を確認できませんでした。並び替えは行っていません。"
                        : "Pixelの位置がまだ保存されていません。並び替えは行っていません。"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => acquireDeviceOrigin("spots")}
                      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-medium"
                    >
                      もう一度確認する
                    </button>
                    <button
                      type="button"
                      onClick={() => selectSort("map")}
                      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-medium"
                    >
                      地図の中心から近い順で並べ替える
                    </button>
                  </div>
                </div>
              )}
              </div>

              {/* Phase 3 layout: at xl the list and the detail pane sit
                  side by side; below xl this is a plain block and the
                  detail element renders as a fixed bottom sheet instead.
                  The grid is a class switch on wrapper divs — nothing
                  remounts on resize. Subtask 450: at 2xl this grid nests
                  in the right column of the wide layout (see above), so
                  the list keeps its detail pane beside it while the
                  controls sit in the left rail. */}
              <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-x-6 2xl:col-start-2 2xl:row-start-2">
              <div className="min-w-0">
              {spotsQuery.isPending && <p className="mt-6 text-center text-sm text-[var(--dim)]">読み込み中…</p>}
              {spotsQuery.isError && (
                <p className="mt-6 text-center text-sm text-[var(--signal)]">
                  一覧の読み込みに失敗しました{" "}
                  <button type="button" className="underline" onClick={() => void spotsQuery.refetch()}>再試行</button>
                </p>
              )}
              {spotsQuery.data && total === 0 && !listFilter && !tagFilter && !search && !memoOnly && (
                <div className="mt-6 rounded-[var(--radius)] bg-[var(--surface)] p-6 text-center">
                  <p className="font-[family-name:var(--font-display)] text-lg font-bold">まだスポットがありません</p>
                  <p className="mt-2 text-sm text-[var(--dim)]">
                    「その他」タブの「スポットを追加」か「取り込み」から登録を始められます。
                  </p>
                </div>
              )}
              {spotsQuery.data && pageSpots.length === 0 && (total > 0 || listFilter || tagFilter || search || memoOnly) && (
                <p className="mt-6 text-center text-sm text-[var(--dim)]">この条件のスポットはありません</p>
              )}

              {listActionError && (
                <p className="mt-3 text-sm text-[var(--signal)]" role="alert">{listActionError}</p>
              )}

              <ul ref={listRef} className="mt-3 space-y-2">
                {pageSpots.map((spot, index) => {
                  const isSelected = selectedId === spot.id;
                  /* Round-1 re-review fix: animate only the pinned
                     first-display ids, at their pinned position — a
                     row keeps its delay even if its page index shifts,
                     and rows outside the pinned set never animate.
                     Round-2: the class applies only while the current
                     display still matches the pinned first display — a
                     sort switch drops it synchronously, in the same
                     render, instead of waiting for the end effect to
                     clear the pinned ids. */
                  const staggerIndex =
                    staggerIds === null || staggerKey !== staggerKeyRef.current
                      ? -1
                      : staggerIds.indexOf(spot.id);
                  return (
                    <li
                      key={spot.id}
                      style={staggerIndex >= 0 ? { animationDelay: `${staggerIndex * 30}ms` } : undefined}
                      className={`rounded-[var(--radius)] p-3 ${
                        isSelected
                          ? "bg-[var(--surface-alt)] shadow-[inset_3px_0_0_var(--accent)]"
                          : "bg-[var(--surface)]"
                      }${staggerIndex >= 0 ? " row-stagger" : ""}`}
                    >
                      {/* Compact row: name, list chip, visit state, memo
                          excerpt, address, tags. The row itself is the
                          selection button (keyboard-operable); the tag
                          chips are sibling buttons, never nested inside
                          it, and filter exactly as before. All editing
                          and actions live in the detail pane / sheet. */}
                      <button
                        type="button"
                        data-spot-row={spot.id}
                        aria-pressed={isSelected}
                        aria-label={`${spot.name}の詳細を開く`}
                        ref={(el) => {
                          if (el) rowRefs.current.set(spot.id, el);
                          else rowRefs.current.delete(spot.id);
                        }}
                        onClick={() => openDetail(spot, index)}
                        className="block w-full text-left"
                      >
                        <span className="block font-medium leading-snug">
                          {spot.visited && (
                            <span className="mr-2 inline-block rotate-[-8deg] rounded border-2 border-[var(--signal)] px-1 text-xs font-black text-[var(--signal)]">済</span>
                          )}
                          {spot.name}
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className={`rounded-full px-2 py-0.5 text-[var(--text)] ${isSelected ? "bg-[var(--surface)]" : "bg-[var(--surface-alt)]"}`}>{spot.category}</span>
                          <span className={spot.visited ? "font-medium text-[var(--accent)]" : "text-[var(--dim)]"}>
                            {spot.visited ? "訪問済み" : "未訪問"}
                          </span>
                          {/* Distance from the sort's fixed origin — only
                              present on rows the server measured (spots
                              without coordinates carry none and sit at
                              the end of the distance order). */}
                          {typeof spot.distance_km === "number" && (
                            <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-[var(--accent-ink)]">
                              {formatDistanceKm(spot.distance_km)}
                            </span>
                          )}
                          {spot.note?.trim() && (
                            <span className="rounded-full bg-[var(--signal-bg)] px-2 py-0.5 font-medium text-[var(--signal)]">メモあり</span>
                          )}
                        </span>
                        {spot.note && (
                          <span className="mt-1.5 block whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text)]">
                            {spot.note.length > 160 ? `${spot.note.slice(0, 160)}…` : spot.note}
                          </span>
                        )}
                        {spot.address && (
                          <span className="mt-0.5 block truncate text-sm text-[var(--dim)]">{spot.address}</span>
                        )}
                      </button>
                      {spot.tags.length > 0 && (
                        <span className="mt-2 flex flex-wrap gap-1.5">
                          {spot.tags.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => pickTag(tag)}
                              aria-label={`タグ「${tag}」で絞り込む`}
                              className="rounded-full border border-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
                            >
                              {tag}
                            </button>
                          ))}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>

              {pageCount > 1 && (
                <nav aria-label="ページ送り" className="mt-4 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={safePage <= 0}
                    onClick={() => setPage(safePage - 1)}
                    className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 font-medium disabled:opacity-40"
                  >
                    前のページ
                  </button>
                  <span className="text-sm text-[var(--dim)]">
                    {safePage + 1} / {pageCount}ページ
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage(safePage + 1)}
                    className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 font-medium disabled:opacity-40"
                  >
                    次のページ
                  </button>
                </nav>
              )}
              </div>

              {/* Spot detail — ONE element, always mounted while the
                  スポット tab is shown. Below xl it is a bottom sheet:
                  fixed to the bottom, hidden while closed, sliding in on
                  a restrained spring (.sheet-slide). From xl up the same
                  element is a static sticky side pane, and while closed
                  it shows the empty state instead of hiding. Only
                  responsive classes switch the presentation, so resizing
                  or rotating mid-edit never remounts it — the SpotForm
                  inside keeps its input and focus. */}
              {selectedId !== null && (
                <div
                  aria-hidden="true"
                  onClick={closeDetail}
                  className="fixed inset-0 z-[45] bg-black/40 xl:hidden"
                />
              )}
              <aside
                ref={sheetRef}
                aria-label="スポット詳細"
                className={`fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-[var(--border)] bg-[var(--surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_-10px_36px_rgb(0_0_0/0.3)] xl:sticky xl:top-5 xl:z-auto xl:max-h-none xl:overflow-visible xl:rounded-[var(--radius)] xl:border xl:p-4 xl:shadow-none xl:left-auto xl:right-auto xl:bottom-auto ${
                  selectedId !== null ? "sheet-slide" : "hidden"
                } xl:block`}
              >
                {(editing || selectedSpot) && (
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <h3 className="min-w-0 font-[family-name:var(--font-display)] font-bold leading-snug">
                      {editing ? (
                        <>「{editing.name}」を編集中</>
                      ) : selectedSpot ? (
                        <>
                          {selectedSpot.visited && (
                            <span className="mr-2 inline-block rotate-[-8deg] rounded border-2 border-[var(--signal)] px-1 text-xs font-black text-[var(--signal)]">済</span>
                          )}
                          {selectedSpot.name}
                        </>
                      ) : null}
                    </h3>
                    <button
                      type="button"
                      data-detail-close
                      onClick={closeDetail}
                      aria-label="詳細を閉じる"
                      className="shrink-0 rounded-full border border-[var(--border)] p-1.5 text-[var(--dim)]"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                        <path d="M5 5l14 14M19 5L5 19" />
                      </svg>
                    </button>
                  </div>
                )}
                {editing ? (
                  <SpotForm
                    initial={editing}
                    submitLabel="保存する"
                    busy={updateMutation.isPending}
                    onSubmit={(row) => updateMutation.mutate({ id: editing.id, row })}
                    onCancel={() => setEditing(null)}
                    listNames={listNames}
                  />
                ) : selectedSpot ? (
                  <>
                    <p className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-[var(--text)]">{selectedSpot.category}</span>
                      <span className={selectedSpot.visited ? "font-medium text-[var(--accent)]" : "text-[var(--dim)]"}>
                        {selectedSpot.visited ? "訪問済み" : "未訪問"}
                      </span>
                      {selectedSpot.lat !== null && selectedSpot.lng !== null ? (
                        <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 font-medium text-[var(--accent-ink)]">座標あり</span>
                      ) : (
                        <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--dim)]">座標なし</span>
                      )}
                      {selectedSpot.note?.trim() && (
                        <span className="rounded-full bg-[var(--signal-bg)] px-2 py-0.5 font-medium text-[var(--signal)]">メモあり</span>
                      )}
                    </p>
                    {selectedSpot.note && (
                      <div className="mt-3 rounded-lg bg-[var(--surface-alt)] px-3 py-2.5">
                        <p className="text-xs font-bold tracking-wide text-[var(--dim)]">メモ</p>
                        <p className="mt-1 whitespace-pre-wrap break-words text-base leading-relaxed text-[var(--text)]">
                          {selectedSpot.note.length > 160 && !expandedNotes.has(selectedSpot.id)
                            ? `${selectedSpot.note.slice(0, 160)}…`
                            : selectedSpot.note}
                        </p>
                        {selectedSpot.note.length > 160 && (
                          <button
                            type="button"
                            aria-expanded={expandedNotes.has(selectedSpot.id)}
                            onClick={() =>
                              setExpandedNotes((prev) => {
                                const next = new Set(prev);
                                if (next.has(selectedSpot.id)) next.delete(selectedSpot.id);
                                else next.add(selectedSpot.id);
                                return next;
                              })
                            }
                            className="mt-1 text-sm font-medium text-[var(--accent)] underline"
                          >
                            {expandedNotes.has(selectedSpot.id) ? "メモを閉じる" : "メモを全文見る"}
                          </button>
                        )}
                      </div>
                    )}
                    {selectedSpot.address && (
                      <p className="mt-3 text-sm text-[var(--text)]">
                        <span className="mb-0.5 block text-xs font-bold tracking-wide text-[var(--dim)]">住所</span>
                        {selectedSpot.address}
                      </p>
                    )}
                    <p className="mt-3 text-sm text-[var(--dim)]">
                      座標:{" "}
                      {selectedSpot.lat !== null && selectedSpot.lng !== null
                        ? `${selectedSpot.lat.toFixed(5)}, ${selectedSpot.lng.toFixed(5)}`
                        : "未設定（近接通知の対象外）"}
                    </p>
                    {selectedSpot.visited && selectedSpot.visited_at && (
                      <p className="mt-1.5 text-sm text-[var(--dim)]">
                        {new Date(selectedSpot.visited_at).toLocaleDateString("ja-JP")} に訪問
                      </p>
                    )}
                    {selectedSpot.tags.length > 0 && (
                      <div className="mt-3">
                        <p className="text-xs font-bold tracking-wide text-[var(--dim)]">タグ</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {selectedSpot.tags.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => pickTag(tag)}
                              aria-label={`タグ「${tag}」で絞り込む`}
                              className="rounded-full border border-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent)]"
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* The four card actions, unchanged in behavior —
                        they live in the detail now instead of the row. */}
                    <div className="mt-4 grid grid-cols-2 gap-2 text-sm sm:flex sm:flex-wrap">
                      <button
                        type="button"
                        onClick={() => visitedMutation.mutate({ id: selectedSpot.id, visited: !selectedSpot.visited })}
                        disabled={visitedMutation.isPending}
                        className={`rounded-lg px-3 py-1.5 font-medium disabled:opacity-50 ${
                          selectedSpot.visited
                            ? "border border-[var(--border)] text-[var(--dim)]"
                            : "bg-[var(--accent)] text-[var(--accent-ink)]"
                        }`}
                      >
                        {visitedMutation.isPending ? "保存中…" : selectedSpot.visited ? "未訪問に戻す" : "訪問済みにする"}
                      </button>
                      {selectedMapsHref && (
                        <a
                          href={selectedMapsHref}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-center text-[var(--text)]"
                        >
                          地図で開く
                        </a>
                      )}
                      <button type="button" onClick={() => setEditing(selectedSpot)} className="rounded-lg border border-[var(--border)] px-3 py-1.5">
                        編集
                      </button>
                      <button type="button" onClick={() => { setDeleteError(null); setConfirmDelete(selectedSpot); }} className="rounded-lg px-3 py-1.5 text-center text-[var(--dim)]">
                        削除
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm leading-relaxed text-[var(--dim)]">
                    スポットを選ぶと、ここに詳細が表示されます
                  </p>
                )}
              </aside>
              </div>
              </div>
            </section>

            )}
          </VisitedMapSection>
        )}

        {/* ===== add / import + settings (その他 tab) =====
            Round-1 re-review fix: the two right-column sections
            share one wrapper in grid row 2, so expanding the
            リスト別 block (row 2, left column) can no longer push
            設定 down — the wrapper's children stack from its top
            no matter how tall the row grows. Below xl the wrapper
            is a plain div and the sections stack in the previous
            reading order (dashboard → lists → add/import →
            settings). */}
        {tab === "more" && (
        <div className="mt-8 xl:col-start-2 xl:row-start-2 xl:mt-0">
        <section aria-label="スポットの追加と取り込み">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-bold">追加・取り込み</h2>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => { setAddError(null); setShowAdd((v) => !v); setShowImport(false); }}
              aria-expanded={showAdd}
              className="flex-1 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)]"
            >
              ＋ スポットを追加
            </button>
            <button
              type="button"
              onClick={() => { setShowImport((v) => !v); setShowAdd(false); }}
              aria-expanded={showImport}
              className="flex-1 rounded-[var(--radius)] border border-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent)]"
            >
              ファイルから取り込む
            </button>
          </div>

          {showAdd && (
            <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <SpotForm
                submitLabel="追加する"
                busy={addMutation.isPending}
                onSubmit={(row) => addMutation.mutate(row)}
                onCancel={() => setShowAdd(false)}
                listNames={listNames}
                defaultList={listFilter}
              />
              {addError && <p className="mt-2 text-sm text-[var(--signal)]">{addError}</p>}
            </div>
          )}

          {showImport && (
            <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <h3 className="font-[family-name:var(--font-display)] font-bold">保存リストを取り込む</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--dim)]">
                <li>Google Takeout（takeout.google.com）で「地図（あなたのプレイス）」を書き出す</li>
                <li>リストごとのCSV（またはGeoJSON）ファイルが手に入る</li>
                <li>ここでファイルを選ぶだけ。重複したスポットはスキップされますが、メモが変わっていれば最新のメモに更新され、タグ列があればタグも取り込まれます</li>
              </ol>
              <div className="mt-3">
                <label htmlFor="import-category" className="mb-1 block text-sm font-medium">取り込み先のリスト</label>
                <input
                  id="import-category"
                  {...FIELDS.bulkImportSpots.spots.category}
                  className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2"
                  value={importCategory}
                  onChange={(e) => setImportCategory(e.target.value)}
                  list="import-list-names"
                  placeholder="行ってみたい"
                />
                <datalist id="import-list-names">
                  {listNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
                <p className="mt-1 text-xs text-[var(--dim)]">ファイル内の全スポットがこのリストに入ります（既存リスト名でも新しい名前でもOK）</p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.geojson,.json"
                className="hidden"
                aria-label="取り込むファイルを選ぶ"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-3 w-full rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 font-medium text-[var(--accent-ink)]"
              >
                ファイルを選ぶ（CSV / GeoJSON）
              </button>
              {importRows && (
                <div className="mt-3 rounded-lg bg-[var(--surface-alt)] p-3 text-sm">
                  <p>「{importFileName}」から {importRows.length}件 読み取れました（座標つき {importRows.filter((r) => r.lat !== null && r.lat !== undefined).length}件）</p>
                  <button
                    type="button"
                    onClick={() => void runImport()}
                    className="mt-2 w-full rounded-[var(--radius)] bg-[var(--signal)] px-4 py-2.5 font-bold text-white"
                  >
                    {importRows.length}件を取り込む
                  </button>
                </div>
              )}
              {importState.phase === "working" && (
                <p className="mt-3 text-sm">取り込み中… {importState.done} / {importState.total}件</p>
              )}
              {importState.phase === "done" && (
                <p className="mt-3 text-sm font-medium">
                  取り込み完了： {importState.inserted}件を追加
                  {importState.updated > 0 && `、既存${importState.updated}件のメモを更新`}
                  {importState.tagsUpdated > 0 && `、既存${importState.tagsUpdated}件のタグを更新`}
                  {importState.skipped > 0 && `、${importState.skipped}件は重複でスキップ`}
                </p>
              )}
              {importState.phase === "error" && (
                <p className="mt-3 text-sm text-[var(--signal)]">{importState.message}</p>
              )}
            </div>
          )}
        </section>

        <section aria-label="設定" className="mt-8">
          <h2 className="font-[family-name:var(--font-display)] text-lg font-bold">設定</h2>
          {/* 表示テーマ (phase 5): a manual override for the page's
              light / dark tokens. Switching only flips the
              data-theme attribute on <html> (see the theme state
              above), so nothing on this page — form input, the
              selected spot, the filters — is lost in the switch. */}
          <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-bold">表示テーマ</h3>
              <div className="flex rounded-full border border-[var(--border)] p-0.5" role="group" aria-label="表示テーマの切り替え">
                {(
                  [
                    { key: "system", label: "システム連動" },
                    { key: "light", label: "ライト" },
                    { key: "dark", label: "ダーク" },
                  ] as const
                ).map((t) => {
                  const active = theme === t.key;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTheme(t.key)}
                      className={`rounded-full px-3 py-1.5 text-sm ${
                        active
                          ? "bg-[var(--accent)] font-bold text-[var(--accent-ink)]"
                          : "font-medium text-[var(--dim)]"
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="mt-2 text-sm text-[var(--dim)]">
              端末のライト／ダーク設定に合わせるか、どちらかに固定できます。この端末での表示だけに効きます。
            </p>
          </div>

          <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
            <div className="flex items-center gap-3">
              <label htmlFor="radius-select" className="text-sm font-medium">近接通知の半径</label>
              <select
                id="radius-select"
                value={radiusM}
                onChange={(e) => radiusMutation.mutate(Number(e.target.value))}
                disabled={settings.isPending || radiusMutation.isPending}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 font-medium disabled:opacity-50"
              >
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r}m</option>
                ))}
              </select>
              {radiusMutation.isPending && <span className="text-sm text-[var(--dim)]">保存中…</span>}
            </div>
            {settings.isError && (
              <p className="mt-2 text-sm text-[var(--signal)]">
                設定の読み込みに失敗しました{" "}
                <button type="button" className="underline" onClick={() => void settings.refetch()}>再試行</button>
              </p>
            )}
            {radiusError && <p className="mt-2 text-sm text-[var(--signal)]">{radiusError}</p>}
            <p className="mt-3 text-sm text-[var(--dim)]">
              近くにあるスポットのお知らせはチャットで届きます。この画面はスポットの登録・整理専用で、現在地の監視は行いません。座標付きの未訪問スポットが通知の対象です。
            </p>
          </div>

          <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold">近づいたとき、メモを引用して呼びかける</h3>
              <button
                type="button"
                role="switch"
                aria-checked={memoTeaseEnabled}
                aria-label="メモの引用呼びかけを有効にする"
                disabled={settings.isPending || memoTeaseMutation.isPending}
                onClick={() => memoTeaseMutation.mutate({ memoTeaseEnabled: !memoTeaseEnabled })}
                className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                  memoTeaseEnabled ? "bg-[var(--accent)]" : "bg-[var(--border)]"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${
                    memoTeaseEnabled ? "left-[1.375rem]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="mt-2 text-sm text-[var(--dim)]">
              ONにすると、スポットの近くでお知らせするときに、そのスポットに書かれたメモを引用してメインチャットで声をかけます。メモがないスポットでは通常のお知らせになります。
            </p>
            <div className="mt-3">
              <label htmlFor="memo-tease-template" className="mb-1 block text-sm font-medium">
                呼びかけの文
              </label>
              <textarea
                id="memo-tease-template"
                {...FIELDS.updateSettings.memoTeaseTemplate}
                className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
                rows={2}
                value={memoTeaseTemplate}
                onChange={(e) => setTemplateDraft(e.target.value)}
                disabled={!memoTeaseEnabled}
              />
              <p className="mt-1 text-xs text-[var(--dim)]">
                {"{メモ}"} はスポットのメモ、{"{スポット名}"} はスポット名に置き換わります
              </p>
              {templateDraft !== null && templateDraft !== settings.data?.memoTeaseTemplate && (
                <button
                  type="button"
                  onClick={() => memoTeaseMutation.mutate({ memoTeaseTemplate })}
                  disabled={memoTeaseMutation.isPending || !memoTeaseTemplate.trim()}
                  className="mt-2 rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-ink)] disabled:opacity-50"
                >
                  {memoTeaseMutation.isPending ? "保存中…" : "呼びかけの文を保存"}
                </button>
              )}
              {memoTeaseError && (
                <p className="mt-2 text-sm text-[var(--signal)]">{memoTeaseError}</p>
              )}
            </div>
            <div className="mt-4">
              <p className="text-xs font-bold tracking-wide text-[var(--dim)]">
                チャットでの見え方{previewSpot ? `（「${previewSpot.name}」の実際のメモで表示）` : "（表示例）"}
              </p>
              <div className="mt-2 max-w-md rounded-2xl rounded-tl-md bg-[var(--surface-alt)] px-3.5 py-3">
                <p className="text-base leading-relaxed">
                  ねえねえ、近くに「{previewName}」があるよ〜！
                  {memoTeaseEnabled && (
                    <>
                      <br />
                      {previewCallout}
                    </>
                  )}
                </p>
              </div>
              {!memoTeaseEnabled && (
                <p className="mt-1 text-xs text-[var(--dim)]">OFFの間はメモの引用なしでお知らせします</p>
              )}
            </div>
          </div>
        </section>
        </div>
        )}
      </main>

      {/* ===== bottom tab bar ===== */}
      <nav
        aria-label="画面の切り替え"
        data-bottom-tab-bar
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex w-full max-w-3xl xl:max-w-5xl 2xl:max-w-7xl">
          {(
            [
              {
                key: "spots",
                label: "スポット",
                icon: (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M9 6h11M9 12h11M9 18h11" />
                    <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
                    <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
                    <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
                  </svg>
                ),
              },
              {
                key: "map",
                label: "市区町村",
                icon: (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14" />
                  </svg>
                ),
              },
              {
                key: "lines",
                label: "路線",
                icon: (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="5" y="3" width="14" height="13" rx="3" />
                    <path d="M5 10h14" />
                    <circle cx="9" cy="13.2" r="0.7" fill="currentColor" stroke="none" />
                    <circle cx="15" cy="13.2" r="0.7" fill="currentColor" stroke="none" />
                    <path d="M8.5 20.5 10.2 16M15.5 20.5 13.8 16" />
                  </svg>
                ),
              },
              {
                key: "more",
                label: "その他",
                icon: (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <path d="M4 8h9M17.5 8H20M4 16h3.5M12 16h8" />
                    <circle cx="15" cy="8" r="2.2" />
                    <circle cx="9.5" cy="16" r="2.2" />
                  </svg>
                ),
              },
            ] as const
          ).map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs ${
                  active ? "font-bold text-[var(--accent)]" : "font-medium text-[var(--dim)]"
                }`}
              >
                {t.icon}
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ===== delete confirmation dialog ===== */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-dialog-title"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="delete-dialog-title" className="font-[family-name:var(--font-display)] text-lg font-bold">
              スポットを削除しますか？
            </h3>
            <p className="mt-2 text-sm text-[var(--dim)]">
              「{confirmDelete.name}」（リスト: {confirmDelete.category}）を削除します。この操作は元に戻せません。
            </p>
            {deleteError && <p className="mt-2 text-sm text-[var(--signal)]">{deleteError}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => deleteMutation.mutate(confirmDelete.id)}
                disabled={deleteMutation.isPending}
                className="flex-1 rounded-[var(--radius)] bg-[var(--signal)] px-4 py-2.5 font-bold text-white disabled:opacity-50"
              >
                {deleteMutation.isPending ? "削除中…" : "削除する"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="flex-1 rounded-[var(--radius)] border border-[var(--border)] px-4 py-2.5"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== shared save-success notice (phase 5) =====
          One pill for every successful save, in the same words and
          type style as the radius setting's original inline
          「保存しました」. It floats above the bottom tab bar
          (safe-area aware), never intercepts taps, and dismisses
          itself — notifySaved / clearSaved above own its lifetime,
          and a failed save always clears it, so it never overlaps
          an inline error message. */}
      {savedAt > 0 && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-4"
          role="status"
        >
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm text-[var(--dim)] shadow-[0_4px_16px_rgb(0_0_0/0.18)]">
            保存しました
          </span>
        </div>
      )}
    </div>
  );
}
