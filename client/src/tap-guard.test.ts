import { describe, expect, test } from "bun:test";
import {
  isTapAfterPress,
  pointFromMapEvent,
  TAP_CENTER_TOLERANCE_DEG,
  TAP_SLOP_PX,
  type PressSnapshot,
} from "./tap-guard";

const pressAt = (
  x: number,
  y: number,
  center = { lng: 139.48, lat: 35.67 },
): PressSnapshot => ({ point: { x, y }, center });

describe("pointFromMapEvent", () => {
  test("reads a well-formed canvas point", () => {
    expect(pointFromMapEvent({ point: { x: 10, y: 20 } })).toEqual({
      x: 10,
      y: 20,
    });
  });

  test("rejects events without a usable point", () => {
    expect(pointFromMapEvent(null)).toBeNull();
    expect(pointFromMapEvent({})).toBeNull();
    expect(pointFromMapEvent({ point: null })).toBeNull();
    expect(pointFromMapEvent({ point: { x: "10", y: 20 } })).toBeNull();
    expect(pointFromMapEvent({ point: { x: NaN, y: 20 } })).toBeNull();
  });
});

describe("isTapAfterPress", () => {
  test("a stationary press is a tap", () => {
    expect(
      isTapAfterPress(pressAt(100, 200), {
        point: { x: 100, y: 200 },
        center: { lng: 139.48, lat: 35.67 },
      }),
    ).toBe(true);
  });

  test("finger jitter of a few pixels is still a tap", () => {
    expect(
      isTapAfterPress(pressAt(100, 200), {
        point: { x: 102, y: 198 },
        center: { lng: 139.48, lat: 35.67 },
      }),
    ).toBe(true);
  });

  /* The subtask 1580 failure: the old guard compared camera
     centers with a 0.000001° threshold, so a tap made while
     the tab's own auto-fit (or a row tap's flyTo) was still
     animating — the center mid-flight, the finger perfectly
     still — was discarded as a "drag". The pointer decides
     now, so camera motion alone never rejects a tap. */
  test("a tap during a camera animation is a tap", () => {
    const moved = 0.0005; // ~50 m of camera travel, ≫ the old 0.000001° limit
    expect(moved).toBeGreaterThan(0.000001);
    expect(
      isTapAfterPress(pressAt(100, 200), {
        point: { x: 100, y: 200 },
        center: { lng: 139.48 + moved, lat: 35.67 + moved },
      }),
    ).toBe(true);
  });

  test("a real drag is not a tap, even a short one past the slop", () => {
    expect(TAP_SLOP_PX).toBeLessThan(40);
    expect(
      isTapAfterPress(pressAt(100, 200), {
        point: { x: 100 + TAP_SLOP_PX + 28, y: 200 },
        center: { lng: 139.49, lat: 35.67 },
      }),
    ).toBe(false);
  });

  test("without points, the center fallback keeps a humane tolerance", () => {
    const press: PressSnapshot = {
      point: null,
      center: { lng: 139.48, lat: 35.67 },
    };
    /* Camera-settle drift passes… */
    expect(
      isTapAfterPress(press, {
        point: null,
        center: { lng: 139.48 + TAP_CENTER_TOLERANCE_DEG / 10, lat: 35.67 },
      }),
    ).toBe(true);
    /* …a deliberate pan does not. */
    expect(
      isTapAfterPress(press, {
        point: null,
        center: { lng: 139.48 + TAP_CENTER_TOLERANCE_DEG * 5, lat: 35.67 },
      }),
    ).toBe(false);
  });

  test("nothing to compare counts as a tap", () => {
    expect(
      isTapAfterPress(null, { point: null, center: null }),
    ).toBe(true);
    expect(
      isTapAfterPress(
        { point: null, center: null },
        { point: null, center: null },
      ),
    ).toBe(true);
  });
});
