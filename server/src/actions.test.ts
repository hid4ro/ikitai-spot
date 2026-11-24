/* Regression tests for the ridden-lines save-time validation
   (review round 2, high + the master-version preservation).
   resolveRideFields is exercised directly — it is pure, so no DB
   is needed. The full addRiddenLine / importRiddenLines paths
   (existing-row backfill keeping a recorded master version) are
   verified by the reviewer's in-memory-DB reproduction instead:
   this repo has no action-handler harness.
   Run with: bun test server/src/actions.test.ts */
import { describe, expect, test } from "bun:test";
import { MIGRATED_MASTER_VERSION, SERVICE_MASTER_VERSION } from "../../shared/service-master";
import { resolveRideFields } from "./actions";

describe("resolveRideFields: full rides (review round 2, high)", () => {
  test("a full ride with the current master version is accepted", () => {
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: SERVICE_MASTER_VERSION,
    });
    expect(fields.rideState).toBe("full");
    expect(fields.serviceId).toBe("keio");
    expect(fields.masterVersion).toBe(SERVICE_MASTER_VERSION);
  });

  test("a full ride with the frozen migration version is accepted", () => {
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: MIGRATED_MASTER_VERSION,
    });
    expect(fields.masterVersion).toBe(MIGRATED_MASTER_VERSION);
  });

  test("a full ride with a made-up version is rejected", () => {
    // The reviewer's reproduction: full + "bogus" on an empty DB
    // was stored. A full ride's range must be reproducible from
    // its version, so an unknown version never saves.
    expect(() =>
      resolveRideFields("京王線", {
        rideState: "full",
        masterVersion: "bogus",
      }),
    ).toThrow(/known master version/);
  });

  test("a full ride with a blank or whitespace version is rejected", () => {
    expect(() =>
      resolveRideFields("京王線", { rideState: "full", masterVersion: "" }),
    ).toThrow(/known master version/);
    expect(() =>
      resolveRideFields("京王線", { rideState: "full", masterVersion: " " }),
    ).toThrow(/known master version/);
  });

  test("a full ride with no version supplied defaults to the current version", () => {
    const fields = resolveRideFields("京王線", { rideState: "full" });
    expect(fields.masterVersion).toBe(SERVICE_MASTER_VERSION);
  });

  test("a full ride with a padded version stores the trimmed version (review round 3, low)", () => {
    // The reviewer passed " 2026-11-24 " and it validated but was
    // saved with its spaces, so it no longer matched the known
    // version constants. The validated string is what gets saved.
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: " 2026-11-24 ",
    });
    expect(fields.masterVersion).toBe(SERVICE_MASTER_VERSION);
  });
});

describe("resolveRideFields: partial rides (review round 2, high)", () => {
  test("a partial ride between two N02 station codes is accepted", () => {
    const fields = resolveRideFields("京王線", {
      rideState: "partial",
      fromStationId: "003821",
      fromStationName: "府中",
      toStationId: "003971",
      toStationName: "聖蹟桜ヶ丘",
    });
    expect(fields.rideState).toBe("partial");
    expect(fields.fromStationId).toBe("003821");
    expect(fields.toStationId).toBe("003971");
  });

  test("a partial ride with made-up station ids is rejected", () => {
    // The reviewer's reproduction: partial with "bad" on both ends
    // was stored. "bad" is not an N02 station group code.
    expect(() =>
      resolveRideFields("京王線", {
        rideState: "partial",
        fromStationId: "bad",
        toStationId: "bad",
      }),
    ).toThrow(/N02 station IDs/);
  });

  test("a partial ride with one bad endpoint is rejected", () => {
    expect(() =>
      resolveRideFields("京王線", {
        rideState: "partial",
        fromStationId: "003821",
        toStationId: "bad",
      }),
    ).toThrow(/N02 station IDs/);
  });

  test("a partial ride from a station to itself is rejected", () => {
    expect(() =>
      resolveRideFields("京王線", {
        rideState: "partial",
        fromStationId: "003821",
        toStationId: "003821",
      }),
    ).toThrow(/two different stations/);
  });
});

describe("resolveRideFields: a distinguishing qualifier never attaches to the wrong service (review round 4, medium)", () => {
  test("「中央線（各駅停車）」 saves unlinked, not as jr-chuo-rapid", () => {
    // The reviewer's reproduction: saving it as jr-chuo-rapid
    // renamed the ride 「中央線快速」. The local service is not in
    // the master yet, so an unknown ride stays section-less, and a
    // partial ride for it is rejected until the service is added.
    const fields = resolveRideFields("中央線（各駅停車）", {});
    expect(fields.serviceId).toBeNull();
    expect(fields.rideState).toBe("unknown");
    expect(() =>
      resolveRideFields("中央線（各駅停車）", {
        rideState: "partial",
        fromStationId: "003700",
        toStationId: "003766",
      }),
    ).toThrow(/needs a known service/);
  });

  test("「武蔵野線 (JR東日本)」 links to jr-musashino", () => {
    const fields = resolveRideFields("武蔵野線 (JR東日本)", {});
    expect(fields.serviceId).toBe("jr-musashino");
    expect(fields.rideState).toBe("unknown");
  });
});

describe("resolveRideFields: unknown rides stay section-less", () => {
  test("endpoints supplied with unknown are dropped, never stored", () => {
    const fields = resolveRideFields("京王線", {
      rideState: "unknown",
      fromStationId: "003821",
      toStationId: "003971",
    });
    expect(fields.rideState).toBe("unknown");
    expect(fields.fromStationId).toBeNull();
    expect(fields.toStationId).toBeNull();
  });
});
