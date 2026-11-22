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
   see the 2026-11-22 feasibility note). */

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

/* ---------------- loading ---------------- */

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`boundary data fetch failed: ${res.status} ${url}`);
  }
  return res.json();
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
  const load = (async (): Promise<boolean> => {
    try {
      const ok = await ensureBoundaryManifest();
      if (!ok || !manifest) return false;
      const entry = manifest.boundaries.find((e) => e.pref_name === prefName);
      if (!entry) return false;
      const url = PREFECTURE_FILE_URLS[entry.pref_code];
      if (!url) return false;
      const topo = (await fetchJson(url)) as Topology;
      for (const f of topologyFeatures(topo)) {
        const key = f.properties?.key;
        if (!key || !f.geometry) continue;
        if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon") {
          continue;
        }
        geometryByKey.set(key, f.geometry as unknown as GeoJsonGeometry);
      }
      loadedPrefectures.add(prefName);
      touch();
      return true;
    } catch (err) {
      failedPrefectures.add(prefName);
      console.warn(`[boundary-data] boundaries load failed: ${prefName}`, err);
      touch();
      return false;
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

/* Background completion: every prefecture the priority set did not
   cover, a few at a time so the priority traffic and the basemap
   keep the connection first. Idempotent — loaded and failed
   prefectures are skipped, in-flight ones shared. */
export async function loadRemainingBoundaryPrefectures(): Promise<void> {
  const ok = await ensureBoundaryManifest();
  if (!ok || !manifest) return;
  const pending = manifest.boundaries
    .map((e) => e.pref_name)
    .filter(
      (name) => !loadedPrefectures.has(name) && !failedPrefectures.has(name),
    );
  const BATCH = 4;
  for (let i = 0; i < pending.length; i += BATCH) {
    await Promise.allSettled(
      pending.slice(i, i + BATCH).map((name) => ensurePrefectureBoundaries(name)),
    );
  }
}
