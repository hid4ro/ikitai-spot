/* The main-thread half of the unridden-lines ghost's worker
   (subtask 1457, review round 3): hands a serialized coverage
   to the worker and resolves with its features — and ONLY the
   latest request's answer. A response to a superseded request
   is dropped here, and the caller re-checks the result's
   coverage key against the current ledger before applying it,
   so a ghost computed for an older ledger can never reach the
   map (finding 1's apply-side rule, shared with
   applyUnriddenLineGhostLatest in map-variant.ts).

   The worker is created from the bundled worker source
   (ghost-worker-source.ts, generated — see
   generate-ghost-worker.mjs for why the standard
   `new Worker(new URL(...))` pattern cannot be used with this
   app's bundler) through a Blob URL. One worker serves the
   app's lifetime, so the per-line simplification memo inside
   it persists across coverage changes.

   Fallback: where a Worker cannot be created at all (an
   environment without Worker, or a constructor that throws),
   the same computation runs inline — the one path that still
   touches the UI thread, kept so the ghost degrades to the
   pre-worker behavior instead of vanishing. Tests drive the
   client with a fake transport and a stub inline computation:
   unridden-ghost-client.test.ts. */

import {
  computeUnriddenGhostFeatures,
  ghostCoverageKey,
  type GhostCoverageWire,
  type GhostWorkerRequest,
  type GhostWorkerResponse,
} from "./unridden-ghost";
import { UNRIDDEN_GHOST_WORKER_SOURCE } from "./ghost-worker-source";
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
};

export class UnriddenGhostClient {
  private transport: GhostWorkerTransport | null = null;
  private transportFailed = false;
  private seq = 0;
  private pending: {
    seq: number;
    coverageKey: string;
    wire: GhostCoverageWire;
    resolve: (result: GhostResult | null) => void;
  } | null = null;

  constructor(
    private readonly createTransport: () => GhostWorkerTransport,
    private readonly computeInline: (
      wire: GhostCoverageWire,
    ) => UnriddenLineFeature[],
  ) {}

  /* Ask for the ghost of one coverage. Resolves with the
     result when it lands, or with null when a newer request
     superseded this one (the newer result is the one the
     caller wants; this request's answer, if it ever arrives,
     is dropped). Never rejects: a worker failure falls back
     to the inline computation. */
  request(wire: GhostCoverageWire): Promise<GhostResult | null> {
    const coverageKey = ghostCoverageKey(wire);
    this.seq += 1;
    const seq = this.seq;
    if (this.pending) {
      this.pending.resolve(null);
      this.pending = null;
    }
    const transport = this.transport ?? this.openTransport();
    if (!transport) {
      return Promise.resolve({
        coverageKey,
        features: this.computeInline(wire),
      });
    }
    return new Promise<GhostResult | null>((resolve) => {
      this.pending = { seq, coverageKey, wire, resolve };
      transport.postMessage({
        type: "unridden-ghost-compute",
        seq,
        coverageKey,
        coverage: wire,
      });
    });
  }

  private openTransport(): GhostWorkerTransport | null {
    if (this.transportFailed) return null;
    try {
      const transport = this.createTransport();
      transport.setOnMessage((message) => this.onMessage(message));
      transport.setOnError(() => this.onTransportError());
      this.transport = transport;
      return transport;
    } catch {
      this.transportFailed = true;
      return null;
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
    /* The worker died (or failed to start): every later
       request computes inline, and the request in flight —
       whose answer will never come — is answered inline too,
       from the wire it was sent with. */
    this.transport = null;
    this.transportFailed = true;
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.resolve({
        coverageKey: pending.coverageKey,
        features: this.computeInline(pending.wire),
      });
    }
  }
}

/* Creates the real worker from the bundled source. Kept apart
   from the client so tests never touch it. */
function createBlobWorkerTransport(): GhostWorkerTransport {
  const blob = new Blob([UNRIDDEN_GHOST_WORKER_SOURCE], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  return {
    postMessage: (message) => worker.postMessage(message),
    setOnMessage: (cb) => {
      worker.onmessage = (event: MessageEvent) =>
        cb(event.data as GhostWorkerResponse);
    },
    setOnError: (cb) => {
      worker.onerror = () => cb();
    },
  };
}

/* The app-wide client: one worker, created lazily on the
   first request (tabs that never show the ghost never pay
   for it — not even the worker's startup). */
export const unriddenGhostClient = new UnriddenGhostClient(
  createBlobWorkerTransport,
  (wire) => computeUnriddenGhostFeatures(wire, RIDDEN_LINE_GEOMETRIES),
);
