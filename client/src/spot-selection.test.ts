/* Regression tests for the shared selection sequence and the
   reduced-motion fallback phase (subtask 1216, review medium/low),
   plus the targeted invalidation for delete success (subtask 1221,
   re-review medium).
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

describe("targeted invalidation (delete success)", () => {
  test("deleting A does not invalidate an in-flight fetch for B: A's delete lands first, then B's response still opens", () => {
    const seq = createSelectionSequencer();
    const spotA = 101;
    const spotB = 202;
    /* The reader is viewing A's detail. */
    seq.next(); /* openDetail(A) */
    /* They start deleting A, close the dialog while the delete is
       in flight, and tap B (off-page) on the map. */
    const fetchB = seq.nextFor(spotB);
    /* A's delete succeeds before B's getSpot returns. The delete
       handler invalidates only requests for A and closes A's
       detail locally — it takes no selection number. */
    seq.invalidateFor(spotA);
    /* B's response arrives afterwards and must still be applied. */
    expect(seq.isCurrent(fetchB)).toBe(true);
    expect(seq.current()).toBe(fetchB);
  });

  test("deleting a spot invalidates its own in-flight fetch", () => {
    const seq = createSelectionSequencer();
    const spotA = 101;
    const fetchA = seq.nextFor(spotA);
    expect(seq.isCurrent(fetchA)).toBe(true);
    expect(seq.invalidateFor(spotA)).toBe(true);
    expect(seq.isCurrent(fetchA)).toBe(false);
  });

  test("invalidating a spot with no recorded fetch leaves the current selection untouched", () => {
    const seq = createSelectionSequencer();
    const fetchB = seq.nextFor(202);
    expect(seq.invalidateFor(999)).toBe(false);
    expect(seq.isCurrent(fetchB)).toBe(true);
  });

  test("a targeted invalidation does not resurrect a superseded fetch for the same spot", () => {
    const seq = createSelectionSequencer();
    const spotA = 101;
    const fetchA = seq.nextFor(spotA);
    seq.next(); /* a newer selection supersedes A's fetch */
    seq.invalidateFor(spotA);
    expect(seq.isCurrent(fetchA)).toBe(false);
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
