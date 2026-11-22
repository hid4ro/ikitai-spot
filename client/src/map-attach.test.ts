/* Regression tests for pollForMap (subtask 1216, review high):
   the old SpotListMap attach stopped after 20 tries at 150 ms
   (~3 s), so a map arriving later never got its tap listener.
   Run with: bun test client/src/map-attach.test.ts */
import { describe, expect, test } from "bun:test";
import { pollForMap } from "./map-attach";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pollForMap", () => {
  test("attaches to a map that appears only after the old 20-try budget", async () => {
    let calls = 0;
    const fakeMap = { id: "late-map" };
    const seen: unknown[] = [];
    const handle = pollForMap({
      intervalMs: 1,
      getMap: () => {
        calls += 1;
        /* Null for the first 30 tries — beyond the old 20-try cap,
           i.e. the ">3 s to display, then tap" case. */
        return calls > 30 ? fakeMap : null;
      },
      onMap: (m) => seen.push(m),
    });
    await sleep(1500);
    handle.cancel();
    expect(seen).toEqual([fakeMap]);
    expect(calls).toBeGreaterThan(30);
  });

  test("poke attaches immediately when the basemap-ready signal fires", async () => {
    let ready = false;
    const fakeMap = { id: "poked-map" };
    const seen: unknown[] = [];
    const handle = pollForMap({
      intervalMs: 60_000,
      getMap: () => (ready ? fakeMap : null),
      onMap: (m) => seen.push(m),
    });
    ready = true;
    handle.poke();
    expect(seen).toEqual([fakeMap]);
    handle.cancel();
  });

  test("attaches at most once and stops after cancel", async () => {
    let calls = 0;
    const seen: unknown[] = [];
    const handle = pollForMap({
      intervalMs: 5,
      getMap: () => {
        calls += 1;
        return null;
      },
      onMap: (m) => seen.push(m),
    });
    handle.cancel();
    const callsAtCancel = calls;
    await sleep(40);
    expect(calls).toBe(callsAtCancel);
    expect(seen).toEqual([]);
  });
});
