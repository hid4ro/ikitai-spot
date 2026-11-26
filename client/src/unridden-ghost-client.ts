/* The main-thread half of the unridden-lines ghost's worker
   (subtask 1457, review round 3): hands a serialized coverage
   to the worker and resolves with its features — and ONLY the
   latest request's answer. A response to a superseded request
   is dropped here, and the caller re-checks the result's
   coverage key against the current ledger before applying it,
   so a ghost computed for an older ledger can never reach the
   map (finding 1's apply-side rule, shared with
   applyUnriddenLineGhostLatest in map-variant.ts).

   The first request fetches the separately bundled worker
   script and starts it from a Blob URL. The worker stays alive
   across coverage changes to preserve its per-line memo.
   Startup and messaging failures fall back to the same
   computation on the main thread. */

import {
  computeUnriddenGhostFeatures,
  ghostCoverageKey,
  type GhostCoverageWire,
  type GhostWorkerRequest,
  type GhostWorkerResponse,
} from "./unridden-ghost";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import type { UnriddenLineFeature } from "./map-variant";

export type GhostResult = {
  coverageKey: string;
  features: UnriddenLineFeature[];
};

/* The minimal worker surface the client needs — the real
   Worker satisfies it, and tests drive it with a fake. */
export type GhostWorkerTransport = {
  postMessage: (message: GhostWorkerRequest) => void;
  setOnMessage: (cb: (message: GhostWorkerResponse) => void) => void;
  setOnError: (cb: () => void) => void;
  close: () => void;
};

export class UnriddenGhostClient {
  private transport: GhostWorkerTransport | null = null;
  private transportFailed = false;
  private opening = false;
  private seq = 0;
  private pending: {
    seq: number;
    coverageKey: string;
    wire: GhostCoverageWire;
    resolve: (result: GhostResult | null) => void;
    reject: (reason: unknown) => void;
  } | null = null;

  constructor(
    private readonly createTransport: () => Promise<GhostWorkerTransport>,
    private readonly computeInline: (
      wire: GhostCoverageWire,
    ) => UnriddenLineFeature[],
  ) {}

  /* A superseded request resolves with null. During startup,
     only the latest request is sent once the worker is ready. */
  request(wire: GhostCoverageWire): Promise<GhostResult | null> {
    const coverageKey = ghostCoverageKey(wire);
    this.pending?.resolve(null);
    return new Promise<GhostResult | null>((resolve, reject) => {
      this.pending = { seq: ++this.seq, coverageKey, wire, resolve, reject };
      if (this.transportFailed) {
        this.finishInline();
      } else if (this.transport) {
        this.sendPending(this.transport);
      } else if (!this.opening) {
        this.opening = true;
        void this.openTransport();
      }
    });
  }

  private async openTransport(): Promise<void> {
    try {
      const transport = await this.createTransport();
      this.transport = transport;
      transport.setOnMessage((message) => this.onMessage(message));
      transport.setOnError(() => this.onTransportError());
      this.sendPending(transport);
    } catch {
      this.onTransportError();
    } finally {
      this.opening = false;
    }
  }

  private sendPending(transport: GhostWorkerTransport): void {
    const pending = this.pending;
    if (!pending) return;
    try {
      transport.postMessage({
        type: "unridden-ghost-compute",
        seq: pending.seq,
        coverageKey: pending.coverageKey,
        coverage: pending.wire,
      });
    } catch {
      this.onTransportError();
    }
  }

  private onMessage(message: GhostWorkerResponse): void {
    if (!message || message.type !== "unridden-ghost-result") return;
    const pending = this.pending;
    if (!pending || message.seq !== pending.seq) {
      /* An answer to a superseded request (or a duplicate):
         the seq check is what keeps a stale ghost off the
         map — drop it. */
      return;
    }
    this.pending = null;
    pending.resolve({
      coverageKey: pending.coverageKey,
      features: message.features,
    });
  }

  private onTransportError(): void {
    const transport = this.transport;
    this.transport = null;
    this.transportFailed = true;
    transport?.close();
    this.finishInline();
  }

  private finishInline(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    try {
      pending.resolve({
        coverageKey: pending.coverageKey,
        features: this.computeInline(pending.wire),
      });
    } catch (error) {
      pending.reject(error);
    }
  }
}

const WORKER_FETCH_TIMEOUT_MS = 15_000;

async function fetchWorkerSource(assetUrl: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(assetUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Ghost worker asset fetch failed (${response.status})`);
    }
    const source: unknown = await response.json();
    if (typeof source !== "string" || source.length === 0) {
      throw new Error("Invalid ghost worker asset");
    }
    return source;
  } finally {
    clearTimeout(timer);
  }
}

async function createBlobWorkerTransport(
  assetUrl: string,
): Promise<GhostWorkerTransport> {
  if (typeof Worker === "undefined") throw new Error("Web Workers are unavailable");
  const source = await fetchWorkerSource(assetUrl);
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return {
    postMessage: (message) => worker.postMessage(message),
    setOnMessage: (cb) => {
      worker.onmessage = (event: MessageEvent) => {
        URL.revokeObjectURL(url);
        cb(event.data as GhostWorkerResponse);
      };
    },
    setOnError: (cb) => {
      worker.addEventListener("error", cb);
      worker.addEventListener("messageerror", cb);
    },
    close: () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    },
  };
}

export function createUnriddenGhostClient(assetUrl: string): UnriddenGhostClient {
  return new UnriddenGhostClient(
    () => createBlobWorkerTransport(assetUrl),
    (wire) => computeUnriddenGhostFeatures(wire, RIDDEN_LINE_GEOMETRIES),
  );
}
