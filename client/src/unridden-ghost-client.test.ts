/* Tests for the ghost worker's main-thread client (subtask
   1457, review round 3): only the latest request's answer may
   resolve, a superseded request's late answer is dropped, and
   a worker that cannot start — or dies mid-flight — falls
   back to the inline computation instead of stranding the
   ghost. Run with: bun test
   client/src/unridden-ghost-client.test.ts */
import { describe, expect, test } from "bun:test";
import {
  UnriddenGhostClient,
  type GhostWorkerTransport,
} from "./unridden-ghost-client";
import {
  ghostCoverageKey,
  type GhostCoverageWire,
  type GhostWorkerRequest,
  type GhostWorkerResponse,
} from "./unridden-ghost";
import type { UnriddenLineFeature } from "./map-variant";

const feature = (key: string): UnriddenLineFeature => ({
  type: "Feature",
  properties: { key, color: "#123456" },
  geometry: {
    type: "MultiLineString",
    coordinates: [
      [
        [139.0, 35.0],
        [139.01, 35.0],
      ],
    ],
  },
});

const wireA: GhostCoverageWire = { services: [] };
const wireB: GhostCoverageWire = {
  services: [
    {
      serviceId: "svc-a",
      unknown: false,
      legs: [
        {
          key: "k|o",
          edge: "edge:1",
          fromT: 0,
          toT: 0.5,
          coords: [
            [139.0, 35.0],
            [139.01, 35.0],
          ],
          lengthKm: 1,
        },
      ],
    },
  ],
};

class FakeTransport implements GhostWorkerTransport {
  sent: GhostWorkerRequest[] = [];
  private messageCb: ((m: GhostWorkerResponse) => void) | null = null;
  private errorCb: (() => void) | null = null;
  postMessage(message: GhostWorkerRequest): void {
    this.sent.push(message);
  }
  setOnMessage(cb: (m: GhostWorkerResponse) => void): void {
    this.messageCb = cb;
  }
  setOnError(cb: () => void): void {
    this.errorCb = cb;
  }
  respond(seq: number, features: UnriddenLineFeature[]): void {
    this.messageCb?.({
      type: "unridden-ghost-result",
      seq,
      coverageKey: "echoed",
      features,
    });
  }
  fail(): void {
    this.errorCb?.();
  }
}

function makeClient(transport: FakeTransport) {
  const inlineCalls: GhostCoverageWire[] = [];
  const client = new UnriddenGhostClient(
    () => transport,
    (wire) => {
      inlineCalls.push(wire);
      return [feature("inline")];
    },
  );
  return { client, inlineCalls };
}

describe("UnriddenGhostClient", () => {
  test("the latest request resolves with the worker's features — the inline path stays untouched", async () => {
    const transport = new FakeTransport();
    const { client, inlineCalls } = makeClient(transport);
    const promise = client.request(wireB);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.coverageKey).toBe(ghostCoverageKey(wireB));
    transport.respond(transport.sent[0]!.seq, [feature("from-worker")]);
    const result = await promise;
    expect(result?.coverageKey).toBe(ghostCoverageKey(wireB));
    expect(result?.features[0]!.properties.key).toBe("from-worker");
    expect(inlineCalls).toHaveLength(0);
  });

  test("a superseded request resolves null and its late answer is dropped", async () => {
    const transport = new FakeTransport();
    const { client } = makeClient(transport);
    const first = client.request(wireA);
    const second = client.request(wireB);
    /* The first request was superseded the moment the second
       was sent. */
    expect(await first).toBeNull();
    /* Its answer arriving late must not resolve (or corrupt)
       the live request. */
    transport.respond(transport.sent[0]!.seq, [feature("stale")]);
    transport.respond(transport.sent[1]!.seq, [feature("fresh")]);
    const result = await second;
    expect(result?.features[0]!.properties.key).toBe("fresh");
    expect(result?.coverageKey).toBe(ghostCoverageKey(wireB));
  });

  test("answers arriving out of order still land on the right request", async () => {
    const transport = new FakeTransport();
    const { client } = makeClient(transport);
    const first = client.request(wireA);
    const second = client.request(wireB);
    /* Newer answer first, then the stale one: the stale one
       finds no pending request and is ignored. */
    transport.respond(transport.sent[1]!.seq, [feature("fresh")]);
    transport.respond(transport.sent[0]!.seq, [feature("stale")]);
    expect((await second)?.features[0]!.properties.key).toBe("fresh");
    expect(await first).toBeNull();
  });

  test("a worker that cannot start falls back to the inline computation", async () => {
    const client = new UnriddenGhostClient(
      () => {
        throw new Error("no Worker here");
      },
      () => [feature("inline")],
    );
    const result = await client.request(wireB);
    expect(result?.coverageKey).toBe(ghostCoverageKey(wireB));
    expect(result?.features[0]!.properties.key).toBe("inline");
  });

  test("a worker dying mid-flight answers the pending request inline, and later requests go straight inline", async () => {
    const transport = new FakeTransport();
    const { client, inlineCalls } = makeClient(transport);
    const promise = client.request(wireB);
    transport.fail();
    const result = await promise;
    expect(result?.features[0]!.properties.key).toBe("inline");
    expect(inlineCalls).toEqual([wireB]);
    const second = await client.request(wireA);
    expect(second?.features[0]!.properties.key).toBe("inline");
    /* No second message was posted to the dead worker. */
    expect(transport.sent).toHaveLength(1);
  });
});
