/* Boundary data store: municipality boundaries and prefecture
   borders, fetched per prefecture as TopoJSON instead of bundled
   into the client JS (subtask 1059 / 1148, design by くろにゃん
   2026-11-22).

   The data files live in ./assets/boundaries/ and are imported with
   the file loader (`with { type: "file" }`), so the bundler emits
   each one as its own non-JS asset with a content-hashed name and
   this module only carries the URLs. At runtime the app fetches the
   small manifest first, then only the prefecture files it needs:
   the prefectures the ledger touches (plus the prefecture borders)
   load as the priority set before the visited map mounts, and the
   remaining prefectures stream in in the background so the
   nationwide unvisited-boundary layer completes progressively.
   TopoJSON is converted to GeoJSON on the client with
   topojson-client; geometries land in the same
   「都道府県|市区町村」-keyed map the bundled asset used to fill, so
   every consumer downstream reads the same shapes as before.

   Failure model: a failed fetch never blocks the map. The geometry
   map simply stays (partly) empty, the layers built from it are
   thinner or absent, the static preview keeps covering the pane
   until the basemap arrives exactly as before, and
   isBoundaryLoadFailed() lets the UI show a discreet note.
   MapLibre sources are never handed a URL: data is fetched and
   converted here, then passed to the map as objects (the CVM
   runtime's relative-URL handling inside MapLibre is unverified —
   see the 2026-11-22 feasibility note).

   Hardening (Codex review of 1148, 2026-11-23): every fetch has
   its own deadline, so one stalled response can never hold the
   priority set — and with it the map mount — hostage; a converted
   prefecture file is cross-checked against the manifest (feature
   count and key prefix) and every feature must carry a usable
   Polygon/MultiPolygon geometry before anything is cached, so an
   HTTP 200 carrying the wrong body counts as a failure, not as
   an empty prefecture; and failures are not pinned for the page
   lifetime — each file gets up to MAX_LOAD_ATTEMPTS attempts,
   retried by the background pass and again when the browser
   reports it is back online, but only while a retryable failure
   actually exists, so a page that never started loading
   boundaries fetches nothing on reconnect. */

import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import type { GeoJsonGeometry } from "./geojson";

import boundaries01Url from "./assets/boundaries/boundaries-01.json" with { type: "file" };
import boundaries02Url from "./assets/boundaries/boundaries-02.json" with { type: "file" };
import boundaries03Url from "./assets/boundaries/boundaries-03.json" with { type: "file" };
import boundaries04Url from "./assets/boundaries/boundaries-04.json" with { type: "file" };
import boundaries05Url from "./assets/boundaries/boundaries-05.json" with { type: "file" };
import boundaries06Url from "./assets/boundaries/boundaries-06.json" with { type: "file" };
import boundaries07Url from "./assets/boundaries/boundaries-07.json" with { type: "file" };
import boundaries08Url from "./assets/boundaries/boundaries-08.json" with { type: "file" };
import boundaries09Url from "./assets/boundaries/boundaries-09.json" with { type: "file" };
import boundaries10Url from "./assets/boundaries/boundaries-10.json" with { type: "file" };
import boundaries11Url from "./assets/boundaries/boundaries-11.json" with { type: "file" };
import boundaries12Url from "./assets/boundaries/boundaries-12.json" with { type: "file" };
import boundaries13Url from "./assets/boundaries/boundaries-13.json" with { type: "file" };
import boundaries14Url from "./assets/boundaries/boundaries-14.json" with { type: "file" };
import boundaries15Url from "./assets/boundaries/boundaries-15.json" with { type: "file" };
import boundaries16Url from "./assets/boundaries/boundaries-16.json" with { type: "file" };
import boundaries17Url from "./assets/boundaries/boundaries-17.json" with { type: "file" };
import boundaries18Url from "./assets/boundaries/boundaries-18.json" with { type: "file" };
import boundaries19Url from "./assets/boundaries/boundaries-19.json" with { type: "file" };
import boundaries20Url from "./assets/boundaries/boundaries-20.json" with { type: "file" };
import boundaries21Url from "./assets/boundaries/boundaries-21.json" with { type: "file" };
import boundaries22Url from "./assets/boundaries/boundaries-22.json" with { type: "file" };
import boundaries23Url from "./assets/boundaries/boundaries-23.json" with { type: "file" };
import boundaries24Url from "./assets/boundaries/boundaries-24.json" with { type: "file" };
import boundaries25Url from "./assets/boundaries/boundaries-25.json" with { type: "file" };
import boundaries26Url from "./assets/boundaries/boundaries-26.json" with { type: "file" };
import boundaries27Url from "./assets/boundaries/boundaries-27.json" with { type: "file" };
import boundaries28Url from "./assets/boundaries/boundaries-28.json" with { type: "file" };
import boundaries29Url from "./assets/boundaries/boundaries-29.json" with { type: "file" };
import boundaries30Url from "./assets/boundaries/boundaries-30.json" with { type: "file" };
import boundaries31Url from "./assets/boundaries/boundaries-31.json" with { type: "file" };
import boundaries32Url from "./assets/boundaries/boundaries-32.json" with { type: "file" };
import boundaries33Url from "./assets/boundaries/boundaries-33.json" with { type: "file" };
import boundaries34Url from "./assets/boundaries/boundaries-34.json" with { type: "file" };
import boundaries35Url from "./assets/boundaries/boundaries-35.json" with { type: "file" };
import boundaries36Url from "./assets/boundaries/boundaries-36.json" with { type: "file" };
import boundaries37Url from "./assets/boundaries/boundaries-37.json" with { type: "file" };
import boundaries38Url from "./assets/boundaries/boundaries-38.json" with { type: "file" };
import boundaries39Url from "./assets/boundaries/boundaries-39.json" with { type: "file" };
import boundaries40Url from "./assets/boundaries/boundaries-40.json" with { type: "file" };
import boundaries41Url from "./assets/boundaries/boundaries-41.json" with { type: "file" };
import boundaries42Url from "./assets/boundaries/boundaries-42.json" with { type: "file" };
import boundaries43Url from "./assets/boundaries/boundaries-43.json" with { type: "file" };
import boundaries44Url from "./assets/boundaries/boundaries-44.json" with { type: "file" };
import boundaries45Url from "./assets/boundaries/boundaries-45.json" with { type: "file" };
import boundaries46Url from "./assets/boundaries/boundaries-46.json" with { type: "file" };
import boundaries47Url from "./assets/boundaries/boundaries-47.json" with { type: "file" };
import prefectureBordersUrl from "./assets/boundaries/prefecture-borders.json" with { type: "file" };
import boundaryManifestUrl from "./assets/boundaries/manifest.json" with { type: "file" };

/* TypeScript models a .json import as the parsed JSON value, but
   with the file loader these imports are the emitted asset URLs at
   runtime — asUrl is the one place that says so. */
const asUrl = (value: unknown): string => value as string;

/* File-loader URLs of the per-prefecture TopoJSON files, keyed by
   the two-digit prefecture code used in the file names and the
   manifest. */
const PREFECTURE_FILE_URLS: Readonly<Record<string, string>> = {
"01": asUrl(boundaries01Url),
  "02": asUrl(boundaries02Url),
  "03": asUrl(boundaries03Url),
  "04": asUrl(boundaries04Url),
  "05": asUrl(boundaries05Url),
  "06": asUrl(boundaries06Url),
  "07": asUrl(boundaries07Url),
  "08": asUrl(boundaries08Url),
  "09": asUrl(boundaries09Url),
  "10": asUrl(boundaries10Url),
  "11": asUrl(boundaries11Url),
  "12": asUrl(boundaries12Url),
  "13": asUrl(boundaries13Url),
  "14": asUrl(boundaries14Url),
  "15": asUrl(boundaries15Url),
  "16": asUrl(boundaries16Url),
  "17": asUrl(boundaries17Url),
  "18": asUrl(boundaries18Url),
  "19": asUrl(boundaries19Url),
  "20": asUrl(boundaries20Url),
  "21": asUrl(boundaries21Url),
  "22": asUrl(boundaries22Url),
  "23": asUrl(boundaries23Url),
  "24": asUrl(boundaries24Url),
  "25": asUrl(boundaries25Url),
  "26": asUrl(boundaries26Url),
  "27": asUrl(boundaries27Url),
  "28": asUrl(boundaries28Url),
  "29": asUrl(boundaries29Url),
  "30": asUrl(boundaries30Url),
  "31": asUrl(boundaries31Url),
  "32": asUrl(boundaries32Url),
  "33": asUrl(boundaries33Url),
  "34": asUrl(boundaries34Url),
  "35": asUrl(boundaries35Url),
  "36": asUrl(boundaries36Url),
  "37": asUrl(boundaries37Url),
  "38": asUrl(boundaries38Url),
  "39": asUrl(boundaries39Url),
  "40": asUrl(boundaries40Url),
  "41": asUrl(boundaries41Url),
  "42": asUrl(boundaries42Url),
  "43": asUrl(boundaries43Url),
  "44": asUrl(boundaries44Url),
  "45": asUrl(boundaries45Url),
  "46": asUrl(boundaries46Url),
  "47": asUrl(boundaries47Url)
};

export type BoundaryManifestEntry = {
  pref_code: string;
  pref_name: string;
  features: number;
  file: string;
  bytes: number;
  sha256: string;
};

type BoundaryManifest = {
  version: number;
  generated_at: string;
  boundaries: BoundaryManifestEntry[];
  prefecture_borders: { file: string; bytes: number; sha256: string };
};

/* One anchor point per prefecture — the median boundary vertex
   ([lng, lat]), computed from the shipped data itself. Only used
   to guess which prefecture the reader is currently in, so the
   background pass can fetch that file first; a wrong guess costs
   nothing but a slightly later boundary around the reader. */
const PREFECTURE_ANCHORS: Readonly<Record<string, readonly [number, number]>> = {
  "01": [142.324, 43.34],
  "02": [140.852, 40.748],
  "03": [141.497, 39.534],
  "04": [141.039, 38.399],
  "05": [140.341, 39.866],
  "06": [140.151, 38.47],
  "07": [140.4, 37.375],
  "08": [140.324, 36.24],
  "09": [139.878, 36.595],
  "10": [139.017, 36.445],
  "11": [139.462, 35.984],
  "12": [140.202, 35.551],
  "13": [139.577, 35.64],
  "14": [139.518, 35.405],
  "15": [138.898, 37.601],
  "16": [137.124, 36.687],
  "17": [136.817, 37.05],
  "18": [136.064, 35.813],
  "19": [138.61, 35.608],
  "20": [138.014, 36.107],
  "21": [137.006, 35.535],
  "22": [138.433, 34.915],
  "23": [137.029, 35.045],
  "24": [136.51, 34.373],
  "25": [136.149, 35.109],
  "26": [135.559, 35.176],
  "27": [135.508, 34.567],
  "28": [134.846, 34.876],
  "29": [135.828, 34.471],
  "30": [135.48, 33.874],
  "31": [133.798, 35.386],
  "32": [132.701, 35.171],
  "33": [133.87, 34.777],
  "34": [132.764, 34.407],
  "35": [131.62, 34.087],
  "36": [134.441, 33.941],
  "37": [133.977, 34.304],
  "38": [132.694, 33.608],
  "39": [133.266, 33.422],
  "40": [130.636, 33.6],
  "41": [130.049, 33.34],
  "42": [129.485, 33.136],
  "43": [130.639, 32.548],
  "44": [131.585, 33.176],
  "45": [131.357, 32.178],
  "46": [130.312, 31.279],
  "47": [127.728, 26.251],
};

/* The prefecture whose anchor sits closest to a position — the
   best available guess for "the prefecture the reader is in"
   before any boundary data has loaded. Null until the manifest
   (which maps codes to names) has landed. */
export function nearestBoundaryPrefectureName(
  lat: number,
  lng: number,
): string | null {
  if (!manifest) return null;
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const entry of manifest.boundaries) {
    const anchor = PREFECTURE_ANCHORS[entry.pref_code];
    if (!anchor) continue;
    const d =
      (anchor[0] - lng) * (anchor[0] - lng) +
      (anchor[1] - lat) * (anchor[1] - lat);
    if (d < bestDistance) {
      bestDistance = d;
      best = entry.pref_name;
    }
  }
  return best;
}

/* ---------------- store state ---------------- */

/* 「都道府県|市区町村」 → boundary geometry, filled prefecture by
   prefecture as files arrive. The map object itself is stable —
   consumers re-read it on every render / map rebuild, and the
   version counter below tells React when to re-read. */
const geometryByKey = new Map<string, GeoJsonGeometry>();

/* Prefecture name → municipality count, from the manifest. The
   denominator for the per-prefecture progress bars; populated when
   the manifest lands, so the counts are exact without loading a
   single geometry. */
const municipalityTotals = new Map<string, number>();

/* Prefecture border polylines (the strongly simplified separate
   file), as plain LineString coordinate arrays — the same shape the
   old bundled asset exported. Empty until the file lands. */
let prefectureBorderLines: number[][][] = [];

let manifest: BoundaryManifest | null = null;
let manifestState: "idle" | "loading" | "ready" | "failed" = "idle";
let bordersState: "idle" | "loading" | "ready" | "failed" = "idle";
const loadedPrefectures = new Set<string>();
const failedPrefectures = new Set<string>();
const prefectureLoads = new Map<string, Promise<boolean>>();

/* Attempt budgets: a failure is retried while attempts remain
   (see the header's failure model), then stays failed until the
   next page load. The counters only ever grow within a page. */
const MAX_LOAD_ATTEMPTS = 3;
let manifestAttempts = 0;
let bordersAttempts = 0;
const prefectureAttempts = new Map<string, number>();

let version = 0;
const listeners = new Set<() => void>();

function touch(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/* useSyncExternalStore binding for React consumers. */
export function subscribeBoundaryData(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getBoundaryVersion(): number {
  return version;
}

/* ---------------- reads ---------------- */

export function getBoundaryGeometryByKey(): ReadonlyMap<string, GeoJsonGeometry> {
  return geometryByKey;
}

export function getPrefectureMunicipalityTotals(): ReadonlyMap<string, number> {
  return municipalityTotals;
}

export function getPrefectureBorderLines(): number[][][] {
  return prefectureBorderLines;
}

export function isPrefectureBoundariesLoaded(prefName: string): boolean {
  return loadedPrefectures.has(prefName);
}

/* True when any part of the boundary data failed to load, so the UI
   can note that the map is showing without (some) boundaries. */
export function isBoundaryLoadFailed(): boolean {
  return (
    manifestState === "failed" ||
    bordersState === "failed" ||
    failedPrefectures.size > 0
  );
}

/* True once every prefecture file in the manifest has loaded, so
   a point lookup against the geometry map is authoritative: a
   miss then really is outside the boundary data, not just a
   prefecture that has not arrived yet. */
export function isBoundaryCoverageComplete(): boolean {
  if (!manifest) return false;
  return manifest.boundaries.every((e) => loadedPrefectures.has(e.pref_name));
}

/* ---------------- loading ---------------- */

/* Every boundary fetch carries its own deadline, covering both
   the response and the JSON body read: one stalled file must
   never hold the priority set — and with it the map mount — or a
   background batch hostage. 15 s is generous for the largest
   prefecture file (~640 KB) even on a slow link, and the retry
   rounds give a stalled file further chances. */
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`boundary data fetch failed: ${res.status} ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

type ConvertedFeature = {
  properties: Record<string, string> | null;
  geometry: { type: string; coordinates: unknown } | null;
};

/* The first (only) object of a topology, converted to GeoJSON
   features with topojson-client. */
function topologyFeatures(topo: Topology): ConvertedFeature[] {
  const objectName = Object.keys(topo.objects)[0];
  if (!objectName) return [];
  const converted = feature(topo, topo.objects[objectName]!);
  const collection =
    converted.type === "FeatureCollection" ? converted : null;
  if (!collection) return [];
  return collection.features as unknown as ConvertedFeature[];
}

export async function ensureBoundaryManifest(): Promise<boolean> {
  if (manifestState === "ready") return true;
  if (manifestState === "failed") return false;
  if (manifestState === "loading") {
    /* Another caller is already fetching it; poll the shared state
       rather than issuing a second request. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ensureBoundaryManifest();
  }
  manifestState = "loading";
  manifestAttempts += 1;
  try {
    const data = (await fetchJson(asUrl(boundaryManifestUrl))) as BoundaryManifest;
    if (!data || !Array.isArray(data.boundaries)) {
      throw new Error("boundary manifest has no boundaries list");
    }
    manifest = data;
    municipalityTotals.clear();
    for (const entry of data.boundaries) {
      municipalityTotals.set(entry.pref_name, entry.features);
    }
    manifestState = "ready";
    touch();
    return true;
  } catch (err) {
    manifestState = "failed";
    console.warn("[boundary-data] manifest load failed", err);
    touch();
    return false;
  }
}

export async function ensurePrefectureBorders(): Promise<boolean> {
  if (bordersState === "ready") return true;
  if (bordersState === "failed") return false;
  if (bordersState === "loading") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ensurePrefectureBorders();
  }
  bordersState = "loading";
  bordersAttempts += 1;
  try {
    const topo = (await fetchJson(asUrl(prefectureBordersUrl))) as Topology;
    const lines: number[][][] = [];
    for (const f of topologyFeatures(topo)) {
      if (!f.geometry) continue;
      if (f.geometry.type === "LineString") {
        lines.push(f.geometry.coordinates as number[][]);
      } else if (f.geometry.type === "MultiLineString") {
        for (const part of f.geometry.coordinates as number[][][]) {
          lines.push(part);
        }
      }
    }
    /* An empty conversion is a wrong body, not a borderless
       country: count it as a failure so the retry rounds apply. */
    if (lines.length === 0) {
      throw new Error("prefecture borders converted to no lines");
    }
    prefectureBorderLines = lines;
    bordersState = "ready";
    touch();
    return true;
  } catch (err) {
    bordersState = "failed";
    console.warn("[boundary-data] prefecture borders load failed", err);
    touch();
    return false;
  }
}

export function ensurePrefectureBoundaries(prefName: string): Promise<boolean> {
  if (loadedPrefectures.has(prefName)) return Promise.resolve(true);
  if (failedPrefectures.has(prefName)) return Promise.resolve(false);
  const existing = prefectureLoads.get(prefName);
  if (existing) return existing;
  return startPrefectureLoad(prefName);
}

function startPrefectureLoad(prefName: string): Promise<boolean> {
  const load = (async (): Promise<boolean> => {
    try {
      /* A manifest outage is not this prefecture's failure: it
         neither marks the prefecture failed nor consumes one of
         its attempts, so the prefecture still gets its full
         budget once the manifest is back (the online-event retry
         in retryFailedBoundaryLoads relies on this). */
      const ok = await ensureBoundaryManifest();
      if (!ok || !manifest) return false;
      prefectureAttempts.set(
        prefName,
        (prefectureAttempts.get(prefName) ?? 0) + 1,
      );
      try {
        const entry = manifest.boundaries.find((e) => e.pref_name === prefName);
        if (!entry) {
          throw new Error(`prefecture not in boundary manifest: ${prefName}`);
        }
        const url = PREFECTURE_FILE_URLS[entry.pref_code];
        if (!url) {
          throw new Error(`no boundary file for prefecture: ${prefName}`);
        }
        const topo = (await fetchJson(url)) as Topology;
        const features = topologyFeatures(topo);
        /* Cross-check against the manifest before anything is
           cached: a truncated or wrong body (an HTTP 200 with the
           wrong payload happens on flaky tunnels) must count as a
           failed load, not as an empty-but-successful prefecture.
           Every feature must carry a key of THIS prefecture, and
           the counts must match the manifest exactly. */
        const keys = new Set<string>();
        for (const f of features) {
          const key = f.properties?.key;
          if (!key || !key.startsWith(`${prefName}|`)) {
            throw new Error(
              `boundary data mismatch for ${prefName}: unexpected feature key ${String(key)}`,
            );
          }
          keys.add(key);
        }
        if (features.length !== entry.features || keys.size !== entry.features) {
          throw new Error(
            `boundary data mismatch for ${prefName}: ${features.length} features / ${keys.size} keys, manifest says ${entry.features}`,
          );
        }
        /* Every feature must also carry a usable geometry. A
           body whose keys and counts match but whose geometries
           are null or of an unexpected type would otherwise be
           cached as a holed prefecture and still marked loaded,
           so the coverage check would call the country complete
           with municipalities missing from it. One bad geometry
           fails the whole prefecture (retry rounds apply), and
           nothing from the body is cached. */
        for (const f of features) {
          const g = f.geometry;
          if (
            !g ||
            (g.type !== "Polygon" && g.type !== "MultiPolygon") ||
            !Array.isArray(g.coordinates) ||
            g.coordinates.length === 0
          ) {
            throw new Error(
              `boundary data mismatch for ${prefName}: feature ${String(f.properties?.key)} has no usable Polygon/MultiPolygon geometry`,
            );
          }
        }
        for (const f of features) {
          geometryByKey.set(
            f.properties!.key!,
            f.geometry as unknown as GeoJsonGeometry,
          );
        }
        loadedPrefectures.add(prefName);
        touch();
        return true;
      } catch (err) {
        failedPrefectures.add(prefName);
        console.warn(`[boundary-data] boundaries load failed: ${prefName}`, err);
        touch();
        return false;
      }
    } finally {
      prefectureLoads.delete(prefName);
    }
  })();
  prefectureLoads.set(prefName, load);
  return load;
}

/* The priority set: the manifest, the prefecture borders, and the
   given prefectures (the ones the ledger touches), all in parallel.
   Resolves when every one of them has settled, successfully or not —
   the caller mounts the map either way. */
export async function loadBoundaryPriorities(
  prefNames: readonly string[],
): Promise<void> {
  const jobs: Promise<boolean>[] = [ensurePrefectureBorders()];
  for (const name of new Set(prefNames)) {
    jobs.push(ensurePrefectureBoundaries(name));
  }
  /* The manifest gates the prefecture files; ensurePrefectureBorders
     is independent of it. Kick the manifest first so the prefecture
     jobs find it ready. */
  await ensureBoundaryManifest();
  await Promise.allSettled(jobs);
}

/* Background completion: every prefecture the priority set did
   not cover, a few at a time so the priority traffic and the
   basemap keep the connection first. Concurrent calls share one
   run. `priorityPrefName` (the prefecture the reader is currently
   in, when known) goes to the head of the queue without joining
   the priority set — the map mount never waits for it.

   A prefecture that fails is not pinned for the page lifetime:
   after the first pass, the run retries the failed ones while
   they still have attempts left (MAX_LOAD_ATTEMPTS in total), so
   a transient stall recovers on its own; the online-event retry
   below covers a longer outage. */
let remainingLoad: Promise<void> | null = null;

export function loadRemainingBoundaryPrefectures(
  priorityPrefName?: string | null,
): Promise<void> {
  if (remainingLoad) return remainingLoad;
  remainingLoad = (async (): Promise<void> => {
    try {
      const ok = await ensureBoundaryManifest();
      if (!ok || !manifest) return;
      const all = manifest.boundaries.map((e) => e.pref_name);
      const ordered = (names: string[]): string[] => {
        if (!priorityPrefName) return names;
        const i = names.indexOf(priorityPrefName);
        if (i <= 0) return names;
        return [
          priorityPrefName,
          ...names.slice(0, i),
          ...names.slice(i + 1),
        ];
      };
      const BATCH = 4;
      const runBatches = async (names: string[]): Promise<void> => {
        for (let i = 0; i < names.length; i += BATCH) {
          await Promise.allSettled(
            names
              .slice(i, i + BATCH)
              .map((name) => ensurePrefectureBoundaries(name)),
          );
        }
      };
      await runBatches(
        ordered(
          all.filter(
            (name) =>
              !loadedPrefectures.has(name) && !failedPrefectures.has(name),
          ),
        ),
      );
      for (let round = 1; round < MAX_LOAD_ATTEMPTS; round++) {
        const retryable = all.filter(
          (name) =>
            !loadedPrefectures.has(name) &&
            failedPrefectures.has(name) &&
            (prefectureAttempts.get(name) ?? 0) < MAX_LOAD_ATTEMPTS,
        );
        if (retryable.length === 0) break;
        /* Lifting the failed mark is what lets
           ensurePrefectureBoundaries start a fresh attempt; the
           mark returns if the attempt fails again. */
        for (const name of retryable) failedPrefectures.delete(name);
        touch();
        await runBatches(ordered(retryable));
      }
    } finally {
      remainingLoad = null;
    }
  })();
  return remainingLoad;
}

/* True when at least one boundary file has failed and still has
   attempts left — the only situation a recovery drive may act
   on. A failure can only exist once a load was attempted, so
   this also proves the boundary machinery is in use: a page
   that never opened the visited map has nothing to retry. */
export function hasRetryableBoundaryFailures(): boolean {
  if (manifestState === "failed" && manifestAttempts < MAX_LOAD_ATTEMPTS) {
    return true;
  }
  if (bordersState === "failed" && bordersAttempts < MAX_LOAD_ATTEMPTS) {
    return true;
  }
  for (const name of failedPrefectures) {
    if ((prefectureAttempts.get(name) ?? 0) < MAX_LOAD_ATTEMPTS) return true;
  }
  return false;
}

/* Re-drive everything that failed while it still has attempts
   left — the manifest and the prefecture borders included (their
   ensure functions report a failure forever once failed, so the
   failed state is lifted here first). Wired to the browser's
   "online" event below, so a connection that comes back also
   brings the missing boundaries back. With nothing retryable
   this is a no-op: the nationwide data set is never fetched
   speculatively. */
export async function retryFailedBoundaryLoads(): Promise<void> {
  if (!hasRetryableBoundaryFailures()) return;
  let lifted = false;
  if (manifestState === "failed" && manifestAttempts < MAX_LOAD_ATTEMPTS) {
    manifestState = "idle";
    lifted = true;
  }
  if (bordersState === "failed" && bordersAttempts < MAX_LOAD_ATTEMPTS) {
    bordersState = "idle";
    lifted = true;
  }
  if (lifted) touch();
  await ensureBoundaryManifest();
  await ensurePrefectureBorders();
  await loadRemainingBoundaryPrefectures();
}

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  /* Recovery on reconnect is limited to pages that actually
     started loading boundaries and have a failed file to retry:
     a page that never opened the visited map must not pull the
     nationwide data set just because the connection came back. */
  window.addEventListener("online", () => {
    if (!hasRetryableBoundaryFailures()) return;
    void retryFailedBoundaryLoads();
  });
}
