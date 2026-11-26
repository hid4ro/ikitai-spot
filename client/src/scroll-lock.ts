/* The page scroll lock, owned in exactly one place (v89 review
   round 1, finding 5). The fullscreen map and the mobile spot
   detail sheet both stop the page behind them from scrolling,
   and both used to save/restore document.body.style.overflow
   privately: open the sheet over the fullscreen map and the
   sheet saved the fullscreen's "hidden" as its own previous
   value, so closing both wrote "hidden" back and the page
   stayed locked forever.

   The lock is a count, not a value: the first acquirer saves
   the body's overflow and sets "hidden"; the value is restored
   only when the LAST holder releases, so holders can come and
   go in any order. Each acquire returns its own release
   function, and releasing twice is a no-op — an effect cleanup
   can never unbalance the count. */

let lockCount = 0;
let savedOverflow: string | null = null;

export function acquireScrollLock(): () => void {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount === 0) {
      document.body.style.overflow = savedOverflow ?? "";
      savedOverflow = null;
    }
  };
}

/* Whether any holder currently owns the lock — for tests and
   diagnostics; the UI never branches on it. */
export function scrollLockHeld(): boolean {
  return lockCount > 0;
}
