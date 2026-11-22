/* Polling for a map handle that appears asynchronously.
   The SpotListMap tap listeners can only attach once the runtime
   hands back the underlying MapLibre map, and on a slow connection
   that can take longer than any fixed poll budget: the previous
   shape stopped after 20 tries at 150 ms (~3 s), so a map that
   arrived later never got its click listener and taps stayed dead
   for the whole mount (Codex review of subtask 1212, high).
   This poll therefore has NO attempt cap — it keeps trying until
   the map appears or the owner cancels it (unmount / remount).
   `poke()` runs a try immediately, which is the route the basemap
   watchdog's success callback uses: "the basemap arrived" now also
   means "attach to the current instance right now", instead of
   only marking the mount loaded. The owner keeps its own
   per-instance duplicate guard, so extra pokes are harmless. */

export interface PollForMapHandle {
  /* Run one attach attempt right now (no-op once attached/cancelled). */
  poke: () => void;
  /* Stop polling; no further attempts happen after this call. */
  cancel: () => void;
}

export function pollForMap<T>(opts: {
  getMap: () => T | null;
  onMap: (map: T) => void;
  intervalMs?: number;
}): PollForMapHandle {
  const intervalMs = opts.intervalMs ?? 150;
  let cancelled = false;
  let attached = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (cancelled || attached) return;
    timer = null;
    let map: T | null = null;
    try {
      map = opts.getMap();
    } catch {
      map = null;
    }
    if (map) {
      attached = true;
      opts.onMap(map);
      return;
    }
    timer = setTimeout(tick, intervalMs);
  };

  tick();
  return {
    poke: () => {
      if (cancelled || attached) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      tick();
    },
    cancel: () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
