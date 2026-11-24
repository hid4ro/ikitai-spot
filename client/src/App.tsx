import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
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
import { mountMap, mountPlaceListMap } from "./map-helpers.mjs";
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
  LEDGER_LINE_NAME_MAP,
  RIDDEN_LINE_GEOMETRIES,
} from "./assets/visited-lines";
import {
  buildLineKeyByName,
  resolveRiddenLineKey as resolveRiddenLineKeyInAsset,
} from "./line-resolution";
import { pollForMap, type PollForMapHandle } from "./map-attach";
import {
  createSelectionSequencer,
  fallbackPhaseAfterReady,
} from "./spot-selection";
import visitedMapFallbackUrl from "./assets/visited-map-fallback.png";

/* Input limits come from the server actions' request schemas, so the
   form fields and the server can never disagree (platform v29). */
const FIELDS = actionFields<typeof Actions>();

/* One shared height for every map pane on the page — the spot list's
   pinned map and the 市区町村・路線 fill map — so switching tabs
   never changes the map's footprint. The height tracks the viewport
   (40% of it) up to a 20rem cap: tall enough to read, small enough
   that the list below stays in reach (the reader found the old
   60dvh / 32rem pane far too big). Horizontally both panes break out
   of the page column's side padding and run edge to edge. */
const MAP_PANE_HEIGHT = "h-[min(40dvh,20rem)]";

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
   Null only when neither coordinates nor any boundary are known. */
function representativePoint(
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

/* Resolves a ledger line name (e.g. 「JR総武快速線」) to its key in
   RIDDEN_LINE_GEOMETRIES (「総武線|東日本旅客鉄道」). The rules live
   in line-resolution.ts (regression-tested against the real asset);
   this binds them to the bundled asset. Returns null when nothing
   resolves — the line then simply has no track drawn and no color
   chip. */
function resolveRiddenLineKey(ledgerName: string): string | null {
  return resolveRiddenLineKeyInAsset(
    ledgerName,
    RIDDEN_LINE_GEOMETRIES,
    LINE_KEY_BY_NAME,
    LEDGER_LINE_NAME_MAP,
  );
}

/* The official color of a ledger line, via the same resolution the map
   overlay uses; null when the line cannot be resolved. */
function riddenLineColor(ledgerName: string): string | null {
  const key = resolveRiddenLineKey(ledgerName);
  return key ? (RIDDEN_LINE_GEOMETRIES[key]?.color ?? null) : null;
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
}: {
  title: string;
  value: number;
  total: number;
  pctText: string;
  color: string;
  doneLabel: string;
}) {
  const data = [
    { name: doneLabel, value },
    { name: "残り", value: Math.max(0, total - value) },
  ];
  return (
    <figure className="min-w-[140px] flex-1" aria-label={`${title}の制覇率 ${pctText}%（${value} / ${total}）`}>
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
            {value.toLocaleString()} / {total.toLocaleString()}
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
}: {
  rows: ProgressRow[];
  doneName: string;
  color: string;
}) {
  const byName = new Map(rows.map((r) => [r.name, r]));
  return (
    <div className="text-[var(--dim)]" aria-hidden="true">
      <ResponsiveContainer width="100%" height={rows.length * 38 + 46}>
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid horizontal={false} stroke="currentColor" strokeOpacity={0.12} />
          <XAxis type="number" domain={[0, "dataMax"]} tick={{ fontSize: 11 }} tickLine={false} axisLine={{ stroke: "currentColor", strokeOpacity: 0.25 }} />
          <YAxis
            type="category"
            dataKey="name"
            width={124}
            tick={{ fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(name: string) => {
              const row = byName.get(name);
              return row ? `${name} ${row.done}/${row.total}` : name;
            }}
          />
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            formatter={(value, name) => [Number(value).toLocaleString(), name]}
          />
          <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="done" name={doneName} stackId="total" fill={color} barSize={16} isAnimationActive={false} />
          <Bar dataKey="rest" name="残り" stackId="total" fill={CHART_REST_COLOR} fillOpacity={0.3} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* Cumulative counts by month (YYYY-MM), expanded to a continuous
   month axis from the first to the last recorded month so the time
   spacing is real. A series' value at a month is its total up to
   that month — defined for every month once counting starts, and 0
   before its first record. */
function buildCumulativeSeries(
  municipalityDates: readonly string[],
  lineDates: readonly string[],
): { month: string; municipalities: number; lines: number }[] {
  const monthOf = (d: string) => (/^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : null);
  const muniMonths = municipalityDates
    .map(monthOf)
    .filter((m): m is string => m !== null)
    .sort();
  const lineMonths = lineDates
    .map(monthOf)
    .filter((m): m is string => m !== null)
    .sort();
  const all = [...muniMonths, ...lineMonths].sort();
  const first = all[0];
  const last = all[all.length - 1];
  if (!first || !last) return [];
  const [startYear = 1970, startMonth = 1] = first.split("-").map(Number);
  const [endYear = 1970, endMonth = 1] = last.split("-").map(Number);
  const rows: { month: string; municipalities: number; lines: number }[] = [];
  let mi = 0;
  let li = 0;
  let mc = 0;
  let lc = 0;
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    while (mi < muniMonths.length && (muniMonths[mi] ?? "") <= key) {
      mc++;
      mi++;
    }
    while (li < lineMonths.length && (lineMonths[li] ?? "") <= key) {
      lc++;
      li++;
    }
    rows.push({ month: key, municipalities: mc, lines: lc });
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return rows;
}

/* The 制覇グラフ block under the fill map: overall donuts for
   municipalities and lines, per-prefecture municipality bars,
   per-operator line bars (only operators with at least one ridden
   line), and the cumulative growth chart. Every number is computed
   here from the same ledger rows and bundled totals the map and the
   headline counts above it use. */
function ConquestCharts({
  municipalities,
  prefectures,
  totalVisited,
  riddenLines,
  riddenLineKeys,
  municipalityProgressPct,
  lineProgressPct,
}: {
  municipalities: VisitedMunicipality[];
  prefectures: { name: string; total: number }[];
  totalVisited: number;
  riddenLines: { name: string; firstRiddenOn: string }[];
  riddenLineKeys: ReadonlySet<string>;
  municipalityProgressPct: string;
  lineProgressPct: string;
}) {
  const prefRows: ProgressRow[] = prefectures.flatMap((p) => {
    const total = PREFECTURE_MUNICIPALITY_TOTALS.get(p.name);
    if (!total) return [];
    return [{ name: p.name, done: p.total, total, rest: Math.max(0, total - p.total) }];
  });
  const uncoveredPrefectures = prefectures.filter(
    (p) => !PREFECTURE_MUNICIPALITY_TOTALS.has(p.name),
  );

  const operatorRidden = new Map<string, number>();
  for (const key of riddenLineKeys) {
    const entry = RIDDEN_LINE_GEOMETRIES[key];
    if (!entry) continue;
    operatorRidden.set(entry.operator, (operatorRidden.get(entry.operator) ?? 0) + 1);
  }
  const operatorRows: ProgressRow[] = [...operatorRidden.entries()]
    .map(([name, done]) => {
      const total = LINE_OPERATOR_TOTALS.get(name) ?? done;
      return { name, done, total, rest: Math.max(0, total - done) };
    })
    .sort(
      (a, b) =>
        b.done - a.done || b.total - a.total || a.name.localeCompare(b.name, "ja"),
    );

  const timeline = buildCumulativeSeries(
    municipalities.map((m) => m.visitedOn),
    riddenLines.map((l) => l.firstRiddenOn),
  );

  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface)] p-3">
      <h3 className="font-[family-name:var(--font-display)] text-base font-bold">制覇グラフ</h3>

      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <ProgressDonut
          title="市区町村"
          value={totalVisited}
          total={JAPAN_MUNICIPALITY_TOTAL}
          pctText={municipalityProgressPct}
          color={CHART_MUNICIPALITY_COLOR}
          doneLabel="訪問済み"
        />
        <ProgressDonut
          title="路線"
          value={riddenLineKeys.size}
          total={JAPAN_LINE_TOTAL}
          pctText={lineProgressPct}
          color={CHART_LINE_COLOR}
          doneLabel="乗車済み"
        />
      </div>

      {prefRows.length > 0 && (
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

      <div className="mt-4">
        <h4 className="text-sm font-medium">事業者別（路線）</h4>
        {operatorRows.length > 0 ? (
          <>
            <div className="mt-1">
              <StackedProgressBars rows={operatorRows} doneName="乗車済み" color={CHART_LINE_COLOR} />
            </div>
            <p className="mt-1 text-xs text-[var(--dim)]">
              乗った路線がある事業者だけを表示しています（全{LINE_OPERATOR_TOTALS.size}事業者のうち{operatorRows.length}事業者）
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-[var(--dim)]">
            まだ路線の記録がありません。路線が記録されると、事業者ごとの進み具合がここに出ます。
          </p>
        )}
      </div>

      {timeline.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-medium">これまでの伸び（月ごとの累計）</h4>
          <div className="mt-1 text-[var(--dim)]" aria-hidden="true">
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={timeline} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
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
                <Area type="stepAfter" dataKey="municipalities" name="市区町村" stroke={CHART_MUNICIPALITY_COLOR} fill={CHART_MUNICIPALITY_COLOR} fillOpacity={0.16} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0 }} isAnimationActive={false} />
                <Area type="stepAfter" dataKey="lines" name="路線" stroke={CHART_LINE_COLOR} fill={CHART_LINE_COLOR} fillOpacity={0.16} strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0 }} isAnimationActive={false} />
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

/* Bounding box of a GeoJSON geometry as [[minLng, minLat], [maxLng,
   maxLat]] — the shape MapLibre's fitBounds takes. Walks every ring of a
   Polygon / MultiPolygon. */
function geometryBounds(
  geometry: GeoJsonGeometry,
): [[number, number], [number, number]] | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      const [lng, lat] = coords as [number, number];
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geometry.coordinates);
  if (!Number.isFinite(minLng)) return null;
  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
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

/* Ray-casting point-in-ring test over [lng, lat] coordinate pairs. */
function ringContainsPoint(ring: number[][], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!a || !b) continue;
    const [xi, yi] = a as [number, number];
    const [xj, yj] = b as [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* Whether a Polygon / MultiPolygon geometry contains the point:
   inside an outer ring and outside every hole of that polygon. */
function geometryContainsPoint(geometry: GeoJsonGeometry, lng: number, lat: number): boolean {
  const polygons: number[][][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon;
    if (!outer || !ringContainsPoint(outer, lng, lat)) continue;
    if (holes.some((hole) => ringContainsPoint(hole, lng, lat))) continue;
    return true;
  }
  return false;
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

function VisitedMapSection({
  active,
  deviceLoc,
  cameraRequest,
  onRetakeDeviceLocation,
}: {
  active: boolean;
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
  /* The priority prefectures follow the ledger: this (re)runs
     whenever a new ledger lands, so a municipality recorded in a
     prefecture that has not loaded yet pulls its boundaries in
     too. boundarySettled flips once the first priority round
     finishes, successfully or not. */
  useEffect(() => {
    if (!visitedQuery.data && !visitedQuery.isError) return;
    const prefs = [
      ...new Set(
        (visitedQuery.data?.municipalities ?? []).map((m) => m.prefecture),
      ),
    ];
    let cancelled = false;
    void loadBoundaryPriorities(prefs).then(() => {
      if (!cancelled) setBoundarySettled(true);
    });
    return () => {
      cancelled = true;
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

  /* Ridden lines (same query key as RiddenLinesBlock below, so the two
     share one fetch): each ledger name resolves to at most one asset
     line key, and several ledger rows can land on the same key
     (JR総武快速線 and JR総武本線 are both 「総武線」) — the set keeps
     each painted line unique. */
  const riddenQuery = useQuery({
    queryKey: ["riddenLines"],
    queryFn: () => api.listRiddenLines({}),
  });
  const riddenLineKeys = new Set<string>();
  for (const line of riddenQuery.data?.lines ?? []) {
    const key = resolveRiddenLineKey(line.name);
    if (key) riddenLineKeys.add(key);
  }
  const riddenLineFeatures = [...riddenLineKeys].flatMap((key) => {
    const entry = RIDDEN_LINE_GEOMETRIES[key];
    if (!entry) return [];
    return [
      {
        type: "Feature",
        properties: { color: entry.color },
        geometry: entry.geometry,
      },
    ];
  });
  const riddenLinesKey = [...riddenLineKeys].sort().join(",");

  /* Progress denominators: municipalities against every municipality
     in Japan, lines against every railway line in Japan — the bundled
     asset carries all of them (国土数値情報 N02 line units), so a line
     ridden anywhere in the country resolves, draws, and counts. The
     line numerator is the number of distinct asset lines the ledger's
     ridden rows resolve to. */
  const municipalityProgressPct =
    JAPAN_MUNICIPALITY_TOTAL > 0
      ? ((totalVisited / JAPAN_MUNICIPALITY_TOTAL) * 100).toFixed(2)
      : "0.00";
  const lineProgressPct =
    JAPAN_LINE_TOTAL > 0
      ? ((riddenLineKeys.size / JAPAN_LINE_TOTAL) * 100).toFixed(1)
      : "0.0";

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
     the camera center when the current press started (so a drag, which
     also produces a click, does not clear the highlight). */
  const focusListenerMapRef = useRef<MapLibreLike | null>(null);
  const pressCenterRef = useRef<{ lng: number; lat: number } | null>(null);
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
  const frameCurrentMunicipality = async (manual: boolean) => {
    if (manual) setLocBusy(true);
    const loc = await resolveCurrentLocation();
    if (manual) setLocBusy(false);
    if (!loc) {
      return;
    }
    currentLocRef.current = { lat: loc.lat, lng: loc.lng };
    const hit = findMunicipalityAt(loc.lat, loc.lng, municipalitiesRef.current);
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    withLiveMapRef.current((map) => {
      try {
        ensureFocusListenersRef.current(map);
        drawCurrentLocationMarker(map, loc.lat, loc.lng, false);
        const bounds = hit ? geometryBounds(hit.geometry) : null;
        if (bounds) {
          map.fitBounds(bounds, {
            padding: 36,
            maxZoom: 15,
            duration: reduceMotion ? 0 : 1200,
          });
        } else {
          map.fitBounds(
            [
              [loc.lng - 0.04, loc.lat - 0.03],
              [loc.lng + 0.04, loc.lat + 0.03],
            ],
            { padding: 36, maxZoom: 15, duration: reduceMotion ? 0 : 1200 },
          );
        }
      } catch {
        /* framing is best-effort; a failure leaves the current view */
      }
    });
  };
  /* Kept in a ref so the auto-fit effect below always calls the
     latest version without re-running. */
  const frameCurrentRef = useRef(frameCurrentMunicipality);
  frameCurrentRef.current = frameCurrentMunicipality;
  const didAutoFitRef = useRef(false);
  useEffect(() => {
    if (didAutoFitRef.current) return;
    if (mapFailed) {
      didAutoFitRef.current = true;
      return;
    }
    if (mapReady === 0 || visitedQuery.isPending) return;
    /* A municipality the reader picked before the default framing
       landed wins — never yank the camera away from it. */
    didAutoFitRef.current = true;
    if (focusedIdRef.current !== null) return;
    void frameCurrentRef.current(false);
  }, [mapReady, visitedQuery.isPending, mapFailed]);
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
     this tab's own re-take button, exactly like the spot map. */
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        const loc = await resolveCurrentLocation();
        if (!loc) return;
        const cur = currentLocRef.current;
        if (cur && cur.lat === loc.lat && cur.lng === loc.lng) return;
        currentLocRef.current = { lat: loc.lat, lng: loc.lng };
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
     the position already shown changes nothing here. */
  const deviceLocLat = deviceLoc?.lat;
  const deviceLocLng = deviceLoc?.lng;
  const deviceLocAt = deviceLoc?.capturedAtMs;
  useEffect(() => {
    if (deviceLocLat === undefined || deviceLocLng === undefined || deviceLocAt === undefined) {
      return;
    }
    const cur = currentLocRef.current;
    if (cur && cur.lat === deviceLocLat && cur.lng === deviceLocLng) return;
    currentLocRef.current = { lat: deviceLocLat, lng: deviceLocLng };
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
    appliedCameraSeqRef.current = cameraRequest.seq;
    currentLocRef.current = { lat: cameraRequest.lat, lng: cameraRequest.lng };
    withLiveMapRef.current((map) => {
      try {
        drawCurrentLocationMarker(map, cameraRequest.lat, cameraRequest.lng, true);
      } catch {
        /* the camera move is a cue only */
      }
    });
  }, [cameraRequest, mapReady]);
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
  const placesKey = municipalities
    .map((m) => `${m.id}${boundaryGeometryFor(m) ? "g" : ""}`)
    .join(",");

  /* Mount the interactive map once the rows exist and the priority
     boundary set has settled (boundarySettled — until then the
     static preview covers the pane). No numbered pins
     are drawn: zoomed out they piled up over the Kanto cluster and
     buried the painted fills, which are the actual collection. Places
     still register with the runtime (it frames the initial camera on
     them) via markers that render nothing. Selection runs both ways
     without pins: a ledger row tap flies the map to the shape, and a
     tap on a painted shape highlights it and scrolls the ledger to
     its row (see ensureFocusListeners). When the runtime cannot run,
     the stored static map of the same municipalities takes its
     place. */
  useEffect(() => {
    if (mapFailed || !boundarySettled || mappable.length === 0) return;
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
        try {
          mapHandleRef.current?.destroy();
        } catch {
          /* a half-mounted handle may refuse; the fallback or the
             remount replaces its container either way */
        }
        mapHandleRef.current = null;
        focusListenerMapRef.current = null;
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
      const rows = mappable
        .map((m) => rowRefs.current[mappableIndex.get(m.id) ?? -1])
        .filter((el): el is HTMLElement => el !== null && el !== undefined);
      if (cancelled || rows.length !== mappable.length) return;
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
              paint: {
                "line-color": ["get", "color"],
                "line-width": 3.5,
                "line-opacity": 0.95,
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
      /* Paint order (boundary hierarchy, 2026-11-22), bottom to
         top: fills → ward lines → municipality outer boundaries →
         prefecture borders → ridden lines → (the focus layers,
         added later at runtime, above everything). The overlays
         above were pushed in computation order, so they are
         sorted into paint order here; ids not in the list keep
         their relative order at the end. */
      const OVERLAY_PAINT_ORDER = [
        "visited-areas",
        "visited-fill",
        "designated-city-wards-unvisited",
        "designated-city-wards-visited",
        "unvisited-areas",
        "visited-areas-outlines",
        "prefecture-borders",
        "visited-lines",
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
          ...(overlays.length > 0 ? { overlays } : {}),
        },
        failMap,
      );
      /* Attach the tap listeners (painted-shape select / blank-tap
         clear) right away, not only after the first row tap, so
         tapping a shape works from the start. */
      if (mapHandleRef.current) {
        withLiveMapRef.current((map) => {
          try {
            ensureFocusListenersRef.current(map);
          } catch {
            /* listeners retry on the next focus call */
          }
          /* The map is live: the default framing (fit to the
             municipality the reader is in) may run now. */
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
    };
    // placesKey captures the municipality set plus each one's shape
    // availability; riddenLinesKey captures the resolved line set the
    // overlay paints. mapAttempt is the automatic-retry nonce.
    // boundarySettled gates the first mount on the priority boundary
    // set; later boundary arrivals do NOT remount (the refresh effect
    // below updates the nationwide sources in place). Refs,
    // index, shaped and circled are derived from those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey, riddenLinesKey, mapFailed, mapAttempt, boundarySettled]);

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

  /* Runs `fn` with the live MapLibre map as soon as it exists. The map
     handle is stored at mount time, but the underlying map only appears
     once the runtime is ready, so poll briefly first. If the poll runs
     out with no map yet, the call is NOT dropped (the pre-2026-11-23
     behavior, which stranded boundary refreshes that raced a slow
     map): the waiter stays registered until flushMapWaiters retries
     it when a map signals readiness, or the mount teardown cancels
     it. A waiter's `fn` always reads the latest state when it finally
     runs, so a late run applies current data, not a stale snapshot. */
  const withLiveMap = (fn: (map: MapLibreLike) => void) => {
    const waiter: MapWaiter = {
      fn,
      cancelled: false,
      timer: null,
      retry: () => {},
    };
    mapWaitersRef.current.add(waiter);
    let attempts = 0;
    const tryOnce = () => {
      if (waiter.cancelled) {
        mapWaitersRef.current.delete(waiter);
        return;
      }
      const map = mapHandleRef.current?.getMap() ?? null;
      if (map) {
        mapWaitersRef.current.delete(waiter);
        if (map.isStyleLoaded()) {
          fn(map);
        } else {
          let done = false;
          const run = () => {
            if (done || waiter.cancelled) return;
            done = true;
            fn(map);
          };
          map.once("load", run);
          setTimeout(run, 2000);
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
      if (waiter.cancelled) return;
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

  /* Clears the focus highlight everywhere: the ledger row emphasis and
     the orange geometry on the map. Used by the map blank-tap listener
     and when the focused row is deleted. */
  const clearFocus = () => {
    focusedIdRef.current = null;
    setFocusedId(null);
    setTappedMunicipality(null);
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
     folded, and the ledger scrolls to its row — the camera itself
     does not move, the reader is already looking at the place. */
  const focusMunicipalityFromMap = (m: VisitedMunicipality) => {
    focusedIdRef.current = m.id;
    setFocusedId(m.id);
    setTappedMunicipality(null);
    setExpandedPrefectures((prev) =>
      prev.has(m.prefecture) ? prev : new Set(prev).add(m.prefecture),
    );
    pendingRowScrollRef.current = m.id;
    const geometry = boundaryGeometryFor(m);
    withLiveMap((map) => {
      try {
        setFocusGeometry(map, geometry, m);
      } catch {
        /* a failed highlight leaves the row emphasis as the cue */
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
    /* A row scroll still heading for a cleared row stops too. */
    rowScrollSeqRef.current += 1;
    setTappedMunicipality({ kind: "unvisited", name: hit.name, prefecture: hit.prefecture });
    withLiveMap((map) => {
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
     release, so the press-start center is remembered and a click
     after real camera movement is ignored — only a genuine tap on
     the spot counts. On a tap, the painted layers are hit-tested: a
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
    const rememberPress = () => {
      try {
        pressCenterRef.current = map.getCenter();
      } catch {
        pressCenterRef.current = null;
      }
    };
    map.on("mousedown", rememberPress);
    map.on("touchstart", rememberPress);
    map.on("click", (e) => {
      const start = pressCenterRef.current;
      pressCenterRef.current = null;
      if (start) {
        try {
          const now = map.getCenter();
          if (
            Math.abs(now.lng - start.lng) > 0.000001 ||
            Math.abs(now.lat - start.lat) > 0.000001
          ) {
            return;
          }
        } catch {
          /* fall through and treat it as a tap */
        }
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
              const hit = municipalitiesRef.current.find(
                (m) => `${m.prefecture} ${m.name}` === name,
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

  /* The section renders only while its tab is active, so on mount
     the live map is asked to re-measure its container (it may have
     been sized while the tab was hidden) — camera and highlight
     state then render at the right size. */
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
  }, [active]);

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
    const visibleTop = () =>
      paneActive && pane ? Math.max(0, pane.getBoundingClientRect().top) : 0;
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
        row.scrollIntoView({
          behavior: instant ? "auto" : "smooth",
          block: "center",
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
      if (fullyVisible() || attempts > 24) {
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
        try {
          ensureFocusListeners(map);
          setFocusGeometry(map, geometry, m);
          if (bounds) {
            map.fitBounds(bounds, {
              padding: 36,
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
    didAutoFitRef.current = false;
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
    <section aria-label="市区町村と路線の記録" className="pt-3">
      {/* Same opening as the スポット tab (pt-3 section, then the
          sticky full-bleed map at the very top with the shared
          MAP_PANE_HEIGHT): no header / intro text, no stats above
          the map, so switching tabs never moves or resizes the map.
          The frame button, the compact stats, the ledger, and the
          record controls all follow below the map. */}

      {visitedQuery.isPending && <p className="mt-3 text-sm text-[var(--dim)]">読み込み中…</p>}
      {visitedQuery.isError && (
        <p className="mt-3 text-sm text-[var(--signal)]">
          台帳の読み込みに失敗しました{" "}
          <button type="button" className="underline" onClick={() => void visitedQuery.refetch()}>
            再試行
          </button>
        </p>
      )}

      {visitedQuery.data && totalVisited === 0 && (
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
          totalVisited > 0
            ? "xl:grid xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-6"
            : undefined
        }
      >
      {totalVisited > 0 && (
        <>
          {/* Sticky map first — the exact same wrapper as the
              スポット tab's pinned map (sticky, -mx-4 full-bleed,
              mt-2 under the section's pt-3, shared MAP_PANE_HEIGHT),
              so the map sits at the identical position and size on
              both tabs. The grid placement lives on the wrapper;
              the map container inside keeps its own ref. */}
          <div className="sticky top-0 z-20 -mx-4 mt-2 bg-[var(--bg)] pb-2 pt-1 xl:col-start-1 xl:row-start-1">
          {mappable.length > 0 && !mapFailed && (
            <div className="relative">
              <div
                ref={mapContainerRef}
                className={`${MAP_PANE_HEIGHT} w-full overflow-hidden bg-[var(--surface-alt)]`}
                role="img"
                aria-label={`通った市区町村${mappable.length}件の地図`}
                aria-hidden={!basemapReady}
              />
              {fallbackPhase !== "gone" && (
                <div
                  className={`pointer-events-none absolute inset-0 z-10 bg-[var(--surface-alt)] motion-safe:transition-opacity motion-safe:duration-500 ${
                    fallbackPhase === "fading" ? "opacity-0" : "opacity-100"
                  }`}
                >
                  <img
                    src={visitedMapFallbackUrl}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                  <p role="status" className="absolute left-2 top-2 rounded bg-[var(--bg)] px-2 py-1 text-xs">
                    ライブ地図を読み込み中
                  </p>
                  <a
                    href="https://www.facebook.com/maps/attribution_terms"
                    target="_blank"
                    rel="noopener"
                    className="pointer-events-auto absolute bottom-0 right-0 bg-[var(--bg)] px-1 text-[10px]"
                  >
                    © OpenStreetMap contributors, Map Data Legal Notices
                  </a>
                </div>
              )}
            </div>
          )}
          {(mapFailed || mappable.length === 0) && (
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
          {mapFailed && mappable.length > 0 && (
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
              above; the console carries the detail. */}
          {boundaryFailed && !mapFailed && mappable.length > 0 && (
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
          {boundaryFailed && (mapFailed || mappable.length === 0) && (
            <p className="px-4 pt-1 text-xs text-[var(--dim)]">
              境界データの一部を読み込めませんでした。通信が戻れば自動で再取得します。
            </p>
          )}
          </div>

          {/* Right under the map: the frame button, then the stats
              in one compact block (prefecture counts, progress, and
              the one-line counting note). No caption about the
              fills — same cleanup as the スポット tab's map. */}
          {mappable.length > 0 && !mapFailed && (
            <div className="mt-2 flex flex-wrap items-center gap-2 xl:col-start-1 xl:row-start-2">
              <button
                type="button"
                onClick={() => void frameCurrentMunicipality(true)}
                disabled={locBusy}
                className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2 text-sm font-medium disabled:opacity-40"
              >
                {locBusy ? "確認中…" : "今いる市区町村に合わせる"}
              </button>
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

          <div className="mt-2 xl:col-start-1 xl:row-start-3">
            {prefectures.length > 0 && (
              <p className="text-sm">
                {prefectures.map((p) => `${p.name} ${p.total}`).join(" ・ ")}
              </p>
            )}
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>
                市区町村 {totalVisited.toLocaleString()} /{" "}
                {JAPAN_MUNICIPALITY_TOTAL.toLocaleString()}（{municipalityProgressPct}%）
              </span>
              <span>
                路線 {riddenLineKeys.size.toLocaleString()} /{" "}
                {JAPAN_LINE_TOTAL.toLocaleString()}（{lineProgressPct}%）
              </span>
            </p>
            <p className="mt-1 text-xs text-[var(--dim)]">
              路線数は国土数値情報の路線単位で、全国の全路線が分母です（総武快速線・総武本線は「総武線」として1路線に数えます）
            </p>
            {/* Border legend: the map's line hierarchy (prefecture
                borders strongest, then municipality boundaries,
                ward borders dashed and lightest) is not
                self-evident from the shapes alone, so the swatches
                sit with the stats under the map. */}
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
            <ConquestCharts
              municipalities={municipalities}
              prefectures={prefectures}
              totalVisited={totalVisited}
              riddenLines={riddenQuery.data?.lines ?? []}
              riddenLineKeys={riddenLineKeys}
              municipalityProgressPct={municipalityProgressPct}
              lineProgressPct={lineProgressPct}
            />
          </div>

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

      <div className="xl:col-start-2 xl:row-start-6">
        <RiddenLinesBlock />
      </div>
      </div>
    </section>
  );
}

/* ---------------- spot-list sticky map ---------------- */

/* The map pinned above the spot list (the reader asked for it:
   「一覧に行きたいとこリスト地図ほしい、スクロールしても固定」).
   It plots the SAME filtered set the list below shows — the visit
   state / list / tag / search filters are applied to the shared
   listSpotPoints data — and stays on screen via a sticky wrapper
   the caller renders. On mount it resolves the current location
   through the maps' existing route (the stored Pixel position
   while fresh — the page's only position source); once a location is known the
   camera fits BOTH it and the nearest plotted spot, the location
   gets the blue marker, and the nearest spot gets a green ring.
   Without a location the map keeps its whole-country initial
   framing. Filter changes re-plot, re-pick the nearest spot, and
   re-frame. The location itself stays live after mount: the maps'
   shared Pixel position is adopted the moment it changes
   (deviceLoc prop), and a 60 s re-read follows the
   Pixel while the reader stays on the tab. A tap on a plotted spot
   selects it: the tap is hit-tested against the spot points layer
   and reported through onSpotTap, and the caller opens the same
   detail a list-row tap opens (resolving the full row first — the
   point payload's memo is truncated, so it never seeds the detail
   itself). It publishes
   its live center through centerGetterRef: the list's
   「地図の中心から近い順」 sort snapshots the center of the map
   the reader is actually looking at (this map took over that role
   from the removed distribution map). */
function SpotListMap({
  visitFilter,
  listFilter,
  tagFilter,
  search,
  deviceLoc,
  cameraRequest,
  centerGetterRef,
  onSpotTap,
}: {
  visitFilter: "all" | "unvisited" | "visited";
  listFilter: string | null;
  tagFilter: string | null;
  search: string;
  /* The maps' shared Pixel position (App state), updated every
     time any stored-position read — a re-take on either tab, or
     the initial mount read — lands a fresh position, whatever the
     list's sort choice is. The map adopts it as its own location
     the moment it changes, so re-taking the position moves the
     blue marker, the nearest-spot ring, and the framing in step
     with the re-sorted list. Null until the first successful read;
     the map then keeps whatever position it already has. */
  deviceLoc: { lat: number; lng: number; capturedAtMs: number } | null;
  /* Explicit camera moves from a re-take (see MapCameraRequest in
     App): only requests targeting "spots" are applied here, each
     at most once. This is what returns the camera to the current
     location when a re-take lands the SAME coordinates the map
     already shows — the adoption effect below early-returns then,
     so without the request a hand-panned view could never be
     pulled back. */
  cameraRequest: MapCameraRequest | null;
  /* Registered once the live map attaches and cleared when it is
     destroyed; while it is null the caller falls back to this map's
     initial center. The getter reads the camera at call time, so it
     always returns the CURRENT center, never a stale snapshot. */
  centerGetterRef?: {
    current: (() => { lat: number; lng: number } | null) | null;
  };
  /* A tap on a plotted spot, resolved against the CURRENT filtered
     set (the same set the points layer paints). Optional: without a
     handler the map stays display-only. */
  onSpotTap?: (point: SpotMapPoint) => void;
}) {
  const pointsQuery = useQuery({
    queryKey: ["spotPoints"],
    queryFn: () => api.listSpotPoints({}),
  });
  const allPoints = pointsQuery.data?.points ?? [];
  const filtered = allPoints.filter((p) => {
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
  const filteredKey = filtered.map((p) => `${p.id}:${p.lng},${p.lat}`).join(";");
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  /* Spot tap selection: the callback lives in a ref so the map
     listener (attached once per map instance) always calls the
     latest one, and the press-start center is remembered so a press
     that turned into a drag does not count as a tap — the same
     contract as the fill map's focus listeners. */
  const onSpotTapRef = useRef(onSpotTap);
  onSpotTapRef.current = onSpotTap;
  const tapListenerMapRef = useRef<MapLibreLike | null>(null);
  const tapPressCenterRef = useRef<{ lng: number; lat: number } | null>(null);
  const attachSpotTap = (map: MapLibreLike) => {
    if (tapListenerMapRef.current === map) return;
    tapListenerMapRef.current = map;
    const rememberPress = () => {
      try {
        tapPressCenterRef.current = map.getCenter();
      } catch {
        tapPressCenterRef.current = null;
      }
    };
    map.on("mousedown", rememberPress);
    map.on("touchstart", rememberPress);
    map.on("click", (e) => {
      const start = tapPressCenterRef.current;
      tapPressCenterRef.current = null;
      if (start) {
        try {
          const now = map.getCenter();
          if (
            Math.abs(now.lng - start.lng) > 0.000001 ||
            Math.abs(now.lat - start.lat) > 0.000001
          ) {
            return;
          }
        } catch {
          /* fall through and treat it as a tap */
        }
      }
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
          const point = filteredRef.current.find((p) => p.id === id);
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
       flips to a pointer while hovering a dot. */
    map.on("mousemove", (e) => {
      const pt = e?.point as { x: number; y: number } | undefined;
      if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") return;
      try {
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

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapHandleRef = useRef<PlaceListMapHandle | null>(null);
  const liveMapRef = useRef<MapLibreLike | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  /* Same automatic recovery as the fill map (see the state note in
     VisitedMapSection): pre-load failures remount on a backoff
     ladder, a spent ladder shows the notice, background recovery
     rounds keep retrying while the notice is shown, and post-load
     error callbacks leave the live map mounted. */
  const [mapAttempt, setMapAttempt] = useState(0);
  const mapRetryCountRef = useRef(0);
  /* Why the last mount gave up, shown in the failure notice (see
     describeMapFailure); same contract as the fill map's. */
  const [mapFailureReason, setMapFailureReason] = useState<string | null>(null);
  /* Background recovery while the failure notice is shown: reset
     the ladder and remount (the notice lifts, the container comes
     back, and the mount effect re-runs). */
  useMapMountRecovery(mapFailed, () => {
    mapRetryCountRef.current = 0;
    setMapFailureReason(null);
    setMapFailed(false);
    setMapAttempt((n) => n + 1);
  });
  const [mapReady, setMapReady] = useState(0);
  const [loc, setLoc] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const locRef = useRef<{ lat: number; lng: number; label: string } | null>(null);
  /* Camera requests (see the cameraRequest prop): the newest seq
     this map has already flown to. Each request is applied at most
     once, and one that arrives before the map is ready is held —
     not dropped — until mapReady rises and an effect below applies
     the latest unapplied one. cameraRequestRef mirrors the prop
     for the framing effect, whose dependency list stays the
     original three triggers. */
  const appliedCameraSeqRef = useRef(0);
  const cameraRequestRef = useRef(cameraRequest);
  cameraRequestRef.current = cameraRequest;

  const pointsFeatureCollection = (pts: SpotMapPoint[]) => ({
    type: "FeatureCollection",
    features: pts.map((p) => ({
      type: "Feature",
      properties: { id: p.id },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    })),
  });

  /* Resolve the current location once on mount, through the same
     helper the 市区町村・路線 tab map uses. If the maps' shared
     Pixel position (the deviceLoc prop) has already been adopted
     by then, it wins — it is never older than this read. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const resolved = await resolveCurrentLocation();
      if (cancelled || !resolved) return;
      if (locRef.current) return;
      locRef.current = resolved;
      setLoc(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Adopt the maps' shared Pixel position whenever a re-take lands
     a new one: the framing effect below (keyed on loc) redraws the
     marker, re-picks the nearest spot, and re-fits the camera, so
     the map follows the same fresh position the list just sorted
     by. Without this wiring the re-take only re-sorted the list
     and the map stayed framed on its mount-time position forever
     (the reader's report). A re-take that returns the position the
     map already shows changes nothing HERE — pulling the camera
     back to it after a hand pan is the camera request's job (see
     the effects below). */
  const deviceLocLat = deviceLoc?.lat;
  const deviceLocLng = deviceLoc?.lng;
  const deviceLocAt = deviceLoc?.capturedAtMs;
  useEffect(() => {
    if (deviceLocLat === undefined || deviceLocLng === undefined || deviceLocAt === undefined) {
      return;
    }
    const cur = locRef.current;
    if (cur && cur.lat === deviceLocLat && cur.lng === deviceLocLng) return;
    const adopted = {
      lat: deviceLocLat,
      lng: deviceLocLng,
      label: `Pixelの位置（${deviceAgeMinutes(deviceLocAt)}分前）`,
    };
    locRef.current = adopted;
    setLoc(adopted);
  }, [deviceLocLat, deviceLocLng, deviceLocAt]);

  /* Follow the Pixel while the reader stays on this tab: the
     location job stores a fresh position about once a minute, so
     re-read it on the same cadence and adopt it only when the
     position actually moved — a reader who panned the map by hand
     while standing still is never yanked back. */
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        const resolved = await resolveCurrentLocation();
        if (!resolved) return;
        const cur = locRef.current;
        if (cur && cur.lat === resolved.lat && cur.lng === resolved.lng) return;
        locRef.current = resolved;
        setLoc(resolved);
      })();
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  /* Mount once, when the point data first exists. Later filter
     changes update the live source instead of remounting, so the
     map (and its framing) never flickers while the reader filters. */
  const hasPoints = allPoints.length > 0;
  useEffect(() => {
    if (mapFailed || !hasPoints) return;
    const container = mapContainerRef.current;
    if (!container) return;
    let cancelled = false;
    let handle: PlaceListMapHandle | null = null;
    let stopWatch: (() => void) | null = null;
    let attachPoll: PollForMapHandle | null = null;
    /* The one failure path for this mount, via the shared control
       (see VisitedMapSection): a pre-load failure remounts on the
       backoff ladder (this effect's cleanup destroys the stalled
       handle as the attempt nonce re-runs it); a spent ladder
       shows the notice with its reload button. A failure after
       the basemap arrived leaves the live map mounted. This mount
       must re-earn "loaded" — the control is created fresh per
       effect run for exactly that. */
    const failure = createMapMountFailureControl({
      retryCountRef: mapRetryCountRef,
      isCancelled: () => cancelled,
      destroyMount: () => {
        /* The effect cleanup destroys the handle when the
           attempt nonce re-runs the effect. */
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
      if (cancelled) return;
      const containerWidth =
        container.clientWidth > 0 ? container.clientWidth : window.innerWidth;
      const zoom = containerWidth < 560 ? 3.2 : 4.2;
      handle = mountMap(
        container,
        {
          center: { lat: 37.6, lng: 138.4 },
          zoom,
          baseStyle: "grayscale",
          overlays: [
            {
              id: "list-spot-points",
              data: pointsFeatureCollection(filteredRef.current),
              layers: [
                {
                  id: "list-spot-points-circle",
                  type: "circle",
                  source: "list-spot-points",
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
            },
          ],
        },
        failMap,
      );
      if (!handle) failMap(MAP_FAIL_NO_HANDLE);
      if (handle) {
        mapHandleRef.current = handle;
        /* Attach the tap listeners to the underlying map as soon as
           it exists — with NO attempt cap. The previous poll stopped
           after 20 tries at 150 ms (~3 s), so on a slow connection
           the map could arrive after the poll gave up and the tap
           listener was never registered (subtask 1216, review high).
           The poll now runs until the map appears or this mount is
           torn down, and the basemap watchdog below pokes it the
           moment the basemap signals ready, so readiness itself is
           an attach route to the CURRENT instance. The per-instance
           guard inside attachSpotTap keeps registration single. */
        attachPoll = pollForMap({
          getMap: () => handle?.getMap() ?? null,
          onMap: (map) => {
            if (cancelled) return;
            liveMapRef.current = map;
            attachSpotTapRef.current(map);
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
            setMapReady((n) => n + 1);
          },
        });
        /* Stall watchdog, same as the fill map's: a basemap load that
           hangs on a flaky connection never reaches onUnavailable, so
           without this the pane stayed blank forever outdoors. On
           timeout the failure path remounts on the backoff ladder
           and only then lets the failure notice (with its reload
           button) take the pane's place; this effect's cleanup
           destroys the stalled handle. */
        stopWatch = watchBasemapLoad(
          () => handle?.getMap() ?? null,
          () => {
            failure.markLoaded();
            /* The basemap arriving is also an attach signal: try to
               register the tap listeners on the current instance
               right now, not only whenever the poll next ticks. */
            attachPoll?.poke();
          },
          () => failMap(MAP_FAIL_TIMEOUT),
        );
      }
    })();
    return () => {
      cancelled = true;
      stopWatch?.();
      attachPoll?.cancel();
      if (handle && mapHandleRef.current === handle) mapHandleRef.current = null;
      if (handle) {
        liveMapRef.current = null;
        if (centerGetterRef) centerGetterRef.current = null;
      }
      handle?.destroy();
    };
    // Mounts once when data first exists; filteredRef supplies the
    // current set at that moment, later changes flow via setData.
    // mapAttempt is the automatic-retry nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPoints, mapFailed, mapAttempt]);

  /* Sync + framing: whenever the filtered set, the resolved
     location, or the live map changes, re-plot the points, redraw
     the location marker, re-pick the nearest spot (green ring), and
     fit the camera to location + nearest. Without a location the
     camera is left wherever it is (initially the whole country). */
  useEffect(() => {
    if (mapReady === 0) return;
    const map = liveMapRef.current;
    if (!map) return;
    try {
      map.getSource("list-spot-points")?.setData(pointsFeatureCollection(filteredRef.current));
    } catch {
      /* a failed re-plot leaves the previous dots; the list below
         is unaffected */
    }
    const current = locRef.current;
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
    for (const p of filteredRef.current) {
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
          { padding: 56, maxZoom: 15 },
        );
      }
    } catch {
      /* framing is a cue; a failure leaves the whole-country view */
    }
    // filteredKey / loc / mapReady are the triggers; refs carry the
    // current values into the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredKey, loc, mapReady]);

  /* Camera requests the framing effect could not take: a re-take
     that lands the SAME coordinates the map already shows never
     changes loc, so the framing effect does not re-run — yet the
     reader pressed the button precisely to be flown back to that
     position after panning away by hand. This effect (declared
     after the framing effect, so a framing run in the same commit
     gets first claim) watches the request itself: when an
     unapplied request for this map matches the location already
     shown, fly to it once. While the map is not ready the request
     simply stays unapplied, and the mapReady change re-runs this
     effect to apply the latest one. */
  useEffect(() => {
    if (!cameraRequest || cameraRequest.target !== "spots") return;
    if (cameraRequest.seq <= appliedCameraSeqRef.current) return;
    if (mapReady === 0) return;
    const current = locRef.current;
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
  }, [cameraRequest, mapReady]);

  if (mapFailed) {
    return (
      <div className="px-4">
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
          onClick={() => {
            mapRetryCountRef.current = 0;
            setMapFailureReason(null);
            setMapFailed(false);
          }}
          className="mt-0.5 text-sm font-medium text-[var(--accent)] underline"
        >
          地図を再読み込み
        </button>
      </div>
    );
  }
  return (
    <div>
      <div
        ref={mapContainerRef}
        className={`${MAP_PANE_HEIGHT} w-full overflow-hidden`}
        role="img"
        aria-label="絞り込み中のスポットをプロットした地図"
      />
    </div>
  );
}

/* The ridden-lines collection shown under the fill map: lines the user
   rode and got a line-trivia delivery for, with the first-ride date. */
function RiddenLinesBlock() {
  const queryClient = useQueryClient();
  const linesQuery = useQuery({
    queryKey: ["riddenLines"],
    queryFn: () => api.listRiddenLines({}),
  });
  const lines = linesQuery.data?.lines ?? [];
  const totalLines = linesQuery.data?.total ?? 0;

  const invalidateLines = () =>
    void queryClient.invalidateQueries({ queryKey: ["riddenLines"] });

  const [lineDeleteError, setLineDeleteError] = useState<string | null>(null);
  const deleteLineMutation = useMutation({
    mutationFn: async (id: number) => await api.deleteRiddenLine({ id }),
    onSuccess: () => {
      setLineDeleteError(null);
      invalidateLines();
    },
    onError: () => setLineDeleteError("削除に失敗しました"),
  });
  const [confirmDeleteLine, setConfirmDeleteLine] = useState<number | null>(null);
  /* The lines list starts collapsed so the section stays short as the
     collection grows; the header shows the count and toggles it open. */
  const [linesExpanded, setLinesExpanded] = useState(false);

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

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setLinesExpanded((v) => !v)}
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

      {linesQuery.isPending && <p className="mt-3 text-sm text-[var(--dim)]">読み込み中…</p>}
      {linesQuery.isError && (
        <p className="mt-3 text-sm text-[var(--signal)]">
          路線の記録の読み込みに失敗しました{" "}
          <button type="button" className="underline" onClick={() => void linesQuery.refetch()}>
            再試行
          </button>
        </p>
      )}
      {linesExpanded && linesQuery.data && totalLines === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          まだ記録がありません。新しい路線でトリビアを受け取ると、ここに自動で追加されます。
        </p>
      )}

      {linesExpanded && totalLines > 0 && (
        <ul className="mt-3 divide-y divide-[var(--border)] rounded-[var(--radius)] bg-[var(--surface)]">
          {lines.map((line) => {
            const editingLineContext = lineContextEditId === line.id;
            return (
            <li key={line.id} className="px-3 py-2.5">
              <div className="flex items-center gap-3">
                {riddenLineColor(line.name) && (
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: riddenLineColor(line.name) ?? undefined }}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{line.name}</span>
                  {line.note && (
                    <span className="block text-xs text-[var(--dim)]">{line.note}</span>
                  )}
                </span>
                <span className="shrink-0 text-xs text-[var(--dim)]">
                  {line.firstRiddenOn.replaceAll("-", "/")}
                </span>
                {confirmDeleteLine === line.id ? (
                  <span className="flex shrink-0 gap-1.5">
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
                <div className="mt-1.5">
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
            </li>
            );
          })}
        </ul>
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
  /* The spot list's pinned map registers a getter for its live
     center here (see SpotListMap). Until a live map exists — or if
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
  /* Bottom tab bar: スポット (spot list), 市区町村・路線 (the fill
     map + ledger + ridden lines), その他 (dashboard / add-import /
     settings). All state lives in this component, so switching tabs
     never loses filters or form input. The second tab IS the fill
     map (the reader's request): it opens straight onto the pinned
     fill map — the old 訪問記録 / スポット分布 toggle is gone, and
     the all-spots distribution map that used to follow below the
     fill map was removed at the reader's request. */
  const [tab, setTab] = useState<"spots" | "map" | "more">("spots");
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

  const spotsQuery = useQuery({
    queryKey: [
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
    ],
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
  const staggerKey = `${tab}|${page}|${filter}|${listFilter}|${tagFilter}|${search}|${memoOnly}`;
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
     the key instead. */
  useEffect(() => {
    if (selectedId === null || confirmDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
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
  }, [selectedId, confirmDelete, editing]);

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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
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

        {/* ===== 市区町村・路線 tab: the fill map is the tab =====
            The fill map section is the whole tab and opens directly
            (its map is pinned to the top of the viewport, fitted by
            default to the municipality the reader is in). The old
            all-spots distribution map that followed below it was
            removed at the reader's request — spots have their own
            map on the スポット tab. The section renders only while
            this tab is active, exactly as the other tabs' sections
            do. */}
        {tab === "map" && (
          <VisitedMapSection
            active
            deviceLoc={deviceLocation}
            cameraRequest={mapCameraRequest}
            onRetakeDeviceLocation={() => retakeMapDeviceLocation("visited")}
          />
        )}

        {/* ===== spot management (スポット tab) ===== */}
        {tab === "spots" && (
        <section aria-label="スポット管理" className="pt-3">
          {/* No visible heading row on this tab (the reader asked
              for it gone, count line included); the sr-only h2 only
              remains as the detail-close focus fallback target. */}
          <h2 ref={headingRef} tabIndex={-1} className="sr-only">スポット管理</h2>

          {/* Map first: the pinned map owns the upper screen (the
              shared MAP_PANE_HEIGHT, same as the 市区町村・路線
              tab's maps, so switching tabs never changes the map's
              footprint) and stays pinned while the compact management
              controls and the list scroll beneath it. The wrapper
              carries the page background so rows pass under it
              cleanly. It plots the same filtered set as the list and
              frames the current location + nearest spot when a
              location is known. */}
          <div className="sticky top-0 z-20 -mx-4 mt-2 bg-[var(--bg)] pb-2 pt-1">
            <SpotListMap
              visitFilter={filter}
              listFilter={listFilter}
              tagFilter={tagFilter}
              search={search}
              deviceLoc={deviceLocation}
              cameraRequest={mapCameraRequest}
              centerGetterRef={spotMapCenterGetterRef}
              onSpotTap={openDetailFromMap}
            />
          </div>
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
                 and rows outside the pinned set never animate. */
              const staggerIndex = staggerIds === null ? -1 : staggerIds.indexOf(spot.id);
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
                label: "市区町村・路線",
                icon: (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2ZM9 4v14M15 6v14" />
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
