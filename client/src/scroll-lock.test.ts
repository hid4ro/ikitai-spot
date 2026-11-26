/* Regression tests for the shared page scroll lock (v89
   review round 1, finding 5): overlapping holders (fullscreen
   map + mobile detail sheet) must never restore each other's
   saved overflow. Run with: bun test client/src/scroll-lock.test.ts */
import { afterEach, describe, expect, test } from "bun:test";
import { acquireScrollLock, scrollLockHeld } from "./scroll-lock";

/* A minimal stand-in for document.body: the lock only ever
   reads and writes body.style.overflow. */
const body = { style: { overflow: "" } };
(globalThis as { document?: unknown }).document = { body };

afterEach(() => {
  body.style.overflow = "";
});

describe("acquireScrollLock", () => {
  test("one holder locks and restores the previous value", () => {
    body.style.overflow = "auto";
    const release = acquireScrollLock();
    expect(body.style.overflow).toBe("hidden");
    expect(scrollLockHeld()).toBe(true);
    release();
    expect(body.style.overflow).toBe("auto");
    expect(scrollLockHeld()).toBe(false);
  });

  test("overlapping holders restore only when the last one leaves", () => {
    /* The reviewed failure: fullscreen locks first, the detail
       sheet opens over it and closes first — the page must stay
       locked until the fullscreen also closes, and then return
       to the value from before ANY holder, not "hidden". */
    body.style.overflow = "";
    const releaseFullscreen = acquireScrollLock();
    const releaseSheet = acquireScrollLock();
    expect(body.style.overflow).toBe("hidden");
    releaseSheet();
    expect(body.style.overflow).toBe("hidden");
    expect(scrollLockHeld()).toBe(true);
    releaseFullscreen();
    expect(body.style.overflow).toBe("");
    expect(scrollLockHeld()).toBe(false);
  });

  test("holders can also leave in acquisition order", () => {
    body.style.overflow = "scroll";
    const releaseFirst = acquireScrollLock();
    const releaseSecond = acquireScrollLock();
    releaseFirst();
    expect(body.style.overflow).toBe("hidden");
    releaseSecond();
    expect(body.style.overflow).toBe("scroll");
  });

  test("releasing twice is a no-op and cannot unbalance the count", () => {
    const releaseA = acquireScrollLock();
    const releaseB = acquireScrollLock();
    releaseA();
    releaseA();
    expect(body.style.overflow).toBe("hidden");
    expect(scrollLockHeld()).toBe(true);
    releaseB();
    expect(scrollLockHeld()).toBe(false);
  });

  test("a fresh acquire after full release re-saves the current value", () => {
    const release1 = acquireScrollLock();
    release1();
    body.style.overflow = "auto";
    const release2 = acquireScrollLock();
    expect(body.style.overflow).toBe("hidden");
    release2();
    expect(body.style.overflow).toBe("auto");
  });
});
