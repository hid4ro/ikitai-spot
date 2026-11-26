// Client bundle for the space.
//
// Bundling is owned by the SDK so every space produces an identical
// production-mode React bundle. See @hatch/space-sdk/build for the
// canonical Bun.build() configuration (entrypoint, outdir, NODE_ENV
// define, asset naming, tailwind plugin).

import { buildClient } from "@hatch/space-sdk/build";
import { generateGhostWorkerSource } from "./generate-ghost-worker.mjs";

/* Pre-step (subtask 1457, review round 3): bundle the unridden-
   ghost Web Worker into client/src/ghost-worker-source.ts, which
   the client bundle carries as a string and turns into a Blob-URL
   worker at runtime. The canonical build above does not bundle
   Worker references, so the worker is bundled here, from the same
   sources, on every build. See generate-ghost-worker.mjs. */
await generateGhostWorkerSource();

await buildClient();
