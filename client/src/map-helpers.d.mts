// Types for the bundled map helpers (map-helpers.mjs, copied from the
// platform's map runtime assets with ONE local deviation, documented in
// map-helpers.mjs itself: the unavailable callback receives the failure
// reason). Only the entry points this app uses are declared.
//
// The bundled runtime (assets/hatch-maps.js) also carries local patches,
// re-apply them if it is ever re-copied from the platform original:
// (1) the mount handle's getMap / fitBounds / flyTo passthroughs (see
// PlaceListMapHandle below), and (2) the worker-probe timeout Q7 raised
// from 3 s to 10 s, so a busy main thread on a phone cannot fail the
// probe — and with it every mount — on a slow first load. The runtime
// also aborts the initial style request on teardown and forwards
// runtime error details, including nonfatal resource errors.

export type MapPlace = {
  label: string;
  lat: number;
  lng: number;
  [key: string]: unknown;
};

export type MapOverlay = {
  id: string;
  data: unknown;
  layers: {
    id: string;
    type: string;
    source: string;
    paint?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    filter?: unknown[];
    /* Zoom gates (boundary hierarchy, 2026-11-22): the border
       layers appear at different zooms — municipality outlines
       only from zoom 7 / 7.5, so wide views show prefecture
       borders alone. Passed through to MapLibre's addLayer. */
    minzoom?: number;
    maxzoom?: number;
  }[];
};

/* Minimal shape of the underlying MapLibre map the runtime hands back
   through the patched handle (see the note in App.tsx): only the camera
   and source/layer calls the visited-map focus feature uses. */
export type MapLibreLike = {
  fitBounds: (
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>,
  ) => void;
  flyTo: (options: Record<string, unknown>) => void;
  isStyleLoaded: () => boolean;
  once: (event: string, cb: () => void) => void;
  /* For the persistent focus highlight's tap handling: press start
     (mousedown / touchstart) snapshots the center via getCenter, and
     click compares it so a drag does not count as a tap. Click
     handlers receive the event with its canvas `point`, which the
     painted-shape hit test feeds to queryRenderedFeatures; `lngLat`
     carries the tapped ground coordinate (the distribution map sorts
     its tap candidates by distance from it). */
  on: (
    event: string,
    cb: (e: { point?: unknown; lngLat?: { lng: number; lat: number } }) => void,
  ) => void;
  getCenter: () => { lng: number; lat: number };
  /* The map canvas element; the distribution map flips its cursor to
     a pointer while the reader hovers a dot. */
  getCanvas: () => { style: { cursor: string } };
  queryRenderedFeatures: (
    point: unknown,
    options?: { layers?: string[] },
  ) => { properties?: Record<string, unknown> | null }[];
  /* Re-measure the container after it was hidden (display:none) behind
     the other map sub-view and shown again. */
  resize: () => void;
  getSource: (id: string) => { setData: (data: unknown) => void } | undefined;
  /* Swap a layer's filter at runtime: the focus highlight hides
     the focused municipality from the NORMAL fill layers (its
     focus fill replaces it, so the two never stack darker), while
     the separate opacity-0 hit layers keep it tappable. */
  setFilter: (layerId: string, filter: unknown) => void;
  addSource: (id: string, source: Record<string, unknown>) => void;
  addLayer: (layer: Record<string, unknown>) => void;
  getLayer: (id: string) => unknown;
};

export type PlaceListMapHandle = {
  selectPlace: (index: number | null) => void;
  destroy: () => void;
  /* Added by this artifact's local patch to hatch-maps.js: the stock
     handle only exposes selectPlace, which never moves the camera. */
  getMap: () => MapLibreLike | null;
  fitBounds: (
    bounds: [[number, number], [number, number]],
    options?: Record<string, unknown>,
  ) => void;
  flyTo: (options: Record<string, unknown>) => void;
};

/* Plain map mount (no place list): used by the all-spots distribution
   map, which draws every spot as an overlay dot and needs an explicit
   initial camera instead of the place-fit the list map performs. The
   runtime reads `center` as a { lat, lng } object. */
export function mountMap(
  container: HTMLElement,
  options: {
    center?: { lat: number; lng: number };
    zoom?: number;
    baseStyle?: "light" | "dark" | "grayscale";
    overlays?: MapOverlay[];
    onResourceError?: (reason: string) => void;
  },
  /* Receives the failure reason when the helper can name one:
     `unsupported:worker` / `unsupported:webgl` from the capability
     check, or the runtime's fatal-error message verbatim. */
  onUnavailable: (reason?: string) => void,
): PlaceListMapHandle | null;

export function mountPlaceListMap(
  container: HTMLElement,
  options: {
    places: MapPlace[];
    rows: HTMLElement[];
    baseStyle?: "light" | "dark" | "grayscale";
    selectedClass?: string;
    overlays?: MapOverlay[];
    onResourceError?: (reason: string) => void;
    /* Replaces the default numbered-pin renderer; return "" to draw
       no marker at all (the visited map does this so wide-zoom fills
       stay visible, and selects via taps on the painted shapes). */
    marker?: (place: MapPlace, index: number, selected: boolean) => string;
  },
  /* Same reason contract as mountMap's callback. */
  onUnavailable: (reason?: string) => void,
): PlaceListMapHandle | null;
