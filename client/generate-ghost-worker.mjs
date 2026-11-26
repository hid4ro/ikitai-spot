/* Bun leaves references to Worker entrypoints unbundled. Build
   the worker as a classic script and package it via the SDK's
   existing JSON file asset path, also used for prefecture
   boundaries. The browser fetches it on the first route-tab
   request and starts a Blob Worker. */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function generateGhostWorkerAsset(
  output = new URL("./src/assets/unridden-ghost-worker.json", import.meta.url),
) {
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("./src/unridden-ghost-worker.ts", import.meta.url)),
    ],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("generate-ghost-worker: worker bundle failed");
  }
  const source = await result.outputs[0].text();
  await writeFile(output, JSON.stringify(source) + "\n");
}

if (import.meta.main) {
  await generateGhostWorkerAsset();
}
