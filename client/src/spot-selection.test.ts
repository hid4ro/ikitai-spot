/* Regression tests for the shared selection sequence and the
   reduced-motion fallback phase (subtask 1216, review medium/low).
   Run with: bun test client/src/spot-selection.test.ts */
import { describe, expect, test } from "bun:test";
import {
  createSelectionSequencer,
  fallbackPhaseAfterReady,
} from "./spot-selection";

describe("createSelectionSequencer", () => {
  test("a stale getSpot response is no longer current after a newer selection", () => {
    const seq = createSelectionSequencer();
    const mapTapA = seq.next();
    expect(seq.isCurrent(mapTapA)).toBe(true);
    /* The reader picks row B while A's fetch is in flight. */
    const rowTapB = seq.next();
    expect(seq.isCurrent(mapTapA)).toBe(false);
    expect(seq.isCurrent(rowTapB)).toBe(true);
  });

  test("closing the detail invalidates an in-flight response", () => {
    const seq = createSelectionSequencer();
    const mapTap = seq.next();
    seq.next(); /* closeDetail */
    expect(seq.isCurrent(mapTap)).toBe(false);
  });

  test("numbers are strictly increasing", () => {
    const seq = createSelectionSequencer();
    const a = seq.next();
    const b = seq.next();
    expect(b).toBeGreaterThan(a);
    expect(seq.current()).toBe(b);
  });
});

describe("fallbackPhaseAfterReady", () => {
  test("reduced motion removes the overlay immediately, without fading", () => {
    expect(fallbackPhaseAfterReady(true)).toBe("gone");
  });
  test("normal motion crossfades", () => {
    expect(fallbackPhaseAfterReady(false)).toBe("fading");
  });
});
