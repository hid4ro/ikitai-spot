/* The unridden-lines ghost's Web Worker (subtask 1457, review
   round 3): the 路線 tab's heaviest computation — every formal
   line's unridden remainder, simplified — runs here, off the
   UI thread, so the first paint and every interaction on the
   路線 tab proceed while it works. The per-line memo inside
   simplifyGhostRemainder lives in this worker's module
   instance, so a coverage change re-simplifies only the lines
   whose remainder actually changed, exactly as it did on the
   main thread.

   This file is a build ENTRYPOINT, not an import: the client
   bundler (Bun.build) does not bundle `new Worker(new URL(...))`
   references, so client/generate-ghost-worker.mjs bundles this
   file on its own as a file asset before the client bundle.
   The app fetches it and creates a Blob Worker when the route
   tab needs the ghost. Only the painted legs cross postMessage. */

import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import {
  computeUnriddenGhostFeatures,
  type GhostWorkerRequest,
  type GhostWorkerResponse,
} from "./unridden-ghost";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: GhostWorkerResponse) => void;
};

scope.onmessage = (event: MessageEvent) => {
  const request = event.data as GhostWorkerRequest;
  if (!request || request.type !== "unridden-ghost-compute") return;
  const features = computeUnriddenGhostFeatures(
    request.coverage,
    RIDDEN_LINE_GEOMETRIES,
  );
  scope.postMessage({
    type: "unridden-ghost-result",
    seq: request.seq,
    coverageKey: request.coverageKey,
    features,
  });
};
