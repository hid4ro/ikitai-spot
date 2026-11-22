/* Shared selection numbering for the spot detail pane.
   A map tap on an off-page spot resolves asynchronously (getSpot),
   while row taps and the detail's close button act synchronously.
   Without a shared sequence, a slow getSpot response could land
   after the reader already picked another spot — or closed the
   detail — and overwrite the newer state with the older spot
   (Codex review of subtask 1212, medium). Every selection-changing
   operation (map tap, row tap, closing the detail) takes the next
   number; an async response is applied only while its number is
   still the latest.

   Deleting a spot is deliberately NOT a plain next(): a delete can
   succeed while a fetch for a different spot is in flight (the
   reader closed the deleted spot's detail and already tapped
   another spot on the map), and a global bump would silently drop
   that unrelated response (Codex re-review of subtask 1216,
   medium). Instead, a fetch started with nextFor(spotId) can be
   invalidated on its own via invalidateFor(spotId), which touches
   only requests for that one spot. Closing the deleted spot's
   detail is a separate, purely local step in the delete handler. */

export interface SelectionSequencer {
  /* Take the next selection number, invalidating all earlier ones. */
  next: () => number;
  /* Take the next selection number for an async fetch of `spotId`,
     remembering which spot the number belongs to so a later
     targeted invalidation can find it. */
  nextFor: (spotId: number) => number;
  /* Invalidate only the in-flight requests taken for `spotId`.
     Requests for other spots keep their standing, and the latest
     selection number does not move. Returns true when at least one
     recorded request was invalidated. */
  invalidateFor: (spotId: number) => boolean;
  /* The most recently taken number. */
  current: () => number;
  /* True while `seq` is still the latest selection number and has
     not been invalidated on its own. */
  isCurrent: (seq: number) => boolean;
}

export function createSelectionSequencer(): SelectionSequencer {
  let seq = 0;
  /* Selection numbers taken for an async fetch, by spot id. */
  const fetchSeqsBySpot = new Map<number, Set<number>>();
  /* Numbers invalidated on their own by invalidateFor(). */
  const invalidated = new Set<number>();
  return {
    next: () => {
      seq += 1;
      return seq;
    },
    nextFor: (spotId: number) => {
      seq += 1;
      let owned = fetchSeqsBySpot.get(spotId);
      if (!owned) {
        owned = new Set<number>();
        fetchSeqsBySpot.set(spotId, owned);
      }
      owned.add(seq);
      return seq;
    },
    invalidateFor: (spotId: number) => {
      const owned = fetchSeqsBySpot.get(spotId);
      if (!owned || owned.size === 0) return false;
      for (const candidate of owned) invalidated.add(candidate);
      fetchSeqsBySpot.delete(spotId);
      return true;
    },
    current: () => seq,
    isCurrent: (candidate: number) =>
      candidate === seq && !invalidated.has(candidate),
  };
}

/* The visited map's loading overlay after the basemap arrives.
   Normally it crossfades ("fading", then unmounts); with reduced
   motion the reader asked for no travel between states, so the
   overlay must come off immediately ("gone") instead of fading
   (Codex review of subtask 1212, low). */
export function fallbackPhaseAfterReady(
  reduceMotion: boolean,
): "fading" | "gone" {
  return reduceMotion ? "gone" : "fading";
}
