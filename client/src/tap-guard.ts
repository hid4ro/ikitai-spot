/* Tap-vs-drag decision for the map's press → click pair
   (subtask 1580).

   The map tap listeners (municipality focus, line focus, spot
   select) share one contract: a press that turned into a drag
   must not count as a tap, because MapLibre still delivers a
   click after a short drag. The original implementation
   snapshotted the camera center at press time and rejected the
   click when the center had moved by more than 0.000001° —
   about 0.1 m. That threshold is not a drag detector, it is a
   hair trigger: the app's own camera animations (the record
   tabs' 1200 ms auto-fit on entry, a row tap's 1200 ms flyTo)
   keep the center moving long after the press, so a genuine
   tap made while the camera was still settling — the normal
   moment to tap, right after opening a tab or flying to a
   place — was silently discarded, on the phone and on the
   desktop alike. Both record tabs share the guard, so both
   tabs' map taps died the same way while the code read as
   wired up.

   The decision now rests on the POINTER, not the camera:
   MapLibre's press and click events both carry the canvas
   `point`, and a tap is a press whose release point stayed
   within a few pixels of the press point, however far the
   camera travelled in between. A deliberate drag moves the
   finger tens of pixels at minimum; finger jitter on a tap is
   a couple of pixels, so the slop sits far from both. When an
   event carries no point (a runtime that does not provide
   one), the center comparison remains as a fallback — with a
   tolerance sized like the slop in ground terms (~200 m),
   still far below any deliberate drag at city zooms and far
   above camera-settle drift. With nothing to compare, the
   press counts as a tap: MapLibre itself already suppresses
   clicks whose pointer travelled past its own tolerance. */

export type TapPoint = { x: number; y: number };
export type LngLatLike = { lng: number; lat: number };

export type PressSnapshot = {
  point: TapPoint | null;
  center: LngLatLike | null;
};

/* How far the pointer may wander between press and release
   and still count as a tap, in canvas pixels. */
export const TAP_SLOP_PX = 12;

/* Fallback center tolerance, in degrees (~200 m), used only
   when a press or click event carries no canvas point. */
export const TAP_CENTER_TOLERANCE_DEG = 0.002;

/* The canvas point of a MapLibre mouse/touch event, or null
   when the event does not carry a usable one. The runtime
   types the event loosely (`point?: unknown`), so the shape
   is validated instead of cast. */
export function pointFromMapEvent(e: unknown): TapPoint | null {
  if (typeof e !== "object" || e === null) return null;
  const point = (e as { point?: unknown }).point;
  if (typeof point !== "object" || point === null) return null;
  const { x, y } = point as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/* Whether the click that ended `press` counts as a tap on the
   spot (true) or as the tail of a drag (false). */
export function isTapAfterPress(
  press: PressSnapshot | null,
  click: { point: TapPoint | null; center: LngLatLike | null },
): boolean {
  if (!press) return true;
  if (press.point && click.point) {
    const dx = click.point.x - press.point.x;
    const dy = click.point.y - press.point.y;
    return Math.hypot(dx, dy) < TAP_SLOP_PX;
  }
  if (press.center && click.center) {
    return (
      Math.abs(click.center.lng - press.center.lng) <
        TAP_CENTER_TOLERANCE_DEG &&
      Math.abs(click.center.lat - press.center.lat) <
        TAP_CENTER_TOLERANCE_DEG
    );
  }
  return true;
}
