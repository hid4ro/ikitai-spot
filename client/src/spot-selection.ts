/* Shared selection numbering for the spot detail pane.
   A map tap on an off-page spot resolves asynchronously (getSpot),
   while row taps and the detail's close button act synchronously.
   Without a shared sequence, a slow getSpot response could land
   after the reader already picked another spot — or closed the
   detail — and overwrite the newer state with the older spot
   (Codex review of subtask 1212, medium). Every selection-changing
   operation (map tap, row tap, closing the detail, deleting the
   shown spot) takes the next number; an async response is applied
   only while its number is still the latest. */

export interface SelectionSequencer {
  /* Take the next selection number, invalidating all earlier ones. */
  next: () => number;
  /* The most recently taken number. */
  current: () => number;
  /* True while `seq` is still the latest selection number. */
  isCurrent: (seq: number) => boolean;
}

export function createSelectionSequencer(): SelectionSequencer {
  let seq = 0;
  return {
    next: () => {
      seq += 1;
      return seq;
    },
    current: () => seq,
    isCurrent: (candidate: number) => candidate === seq,
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
