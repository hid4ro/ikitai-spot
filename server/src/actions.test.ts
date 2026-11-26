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

  test("a full ride at the current version stores its path snapshot (stage 2)", () => {
    // The snapshot is what the client paints from: the path id,
    // the version it was cut at, and the segment list as it stood
    // then — so a later master change never rewrites a past full
    // ride's range.
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: SERVICE_MASTER_VERSION,
    });
    const snapshot = JSON.parse(fields.pathSnapshot!);
    expect(snapshot.pathId).toBe("keio");
    expect(snapshot.masterVersion).toBe(SERVICE_MASTER_VERSION);
    expect(snapshot.segments).toHaveLength(1);
    expect(snapshot.segments[0].formalLineKey).toBe("京王線|京王電鉄");
  });

  test("a full ride with the frozen migration version is accepted", () => {
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: MIGRATED_MASTER_VERSION,
    });
    expect(fields.masterVersion).toBe(MIGRATED_MASTER_VERSION);
  });

  test("a full ride for a service the frozen version never held is rejected (subtask 1593)", () => {
    // Review batch round 1: naming the frozen migration
    // version for むさしの号 / しもうさ号 — services first
    // added at the current version — was accepted with
    // pathSnapshot: null, claiming a range that version's
    // master never contained. A new full ride may only name
    // a version whose master held the service. (Services the
    // frozen version did hold, like 京王線 above, still save
    // at it.)
    for (const name of ["むさしの号", "しもうさ号"]) {
      expect(() =>
        resolveRideFields(name, {
          rideState: "full",
          masterVersion: MIGRATED_MASTER_VERSION,
        }),
      ).toThrow(/did not contain/);
    }
  });

  test("a full ride for the newest services at the current version stores its snapshot (subtask 1593)", () => {
    const musashino = resolveRideFields("むさしの号", {
      rideState: "full",
      masterVersion: SERVICE_MASTER_VERSION,
    });
    expect(musashino.serviceId).toBe("jr-musashino-omiya");
    const musashinoSnapshot = JSON.parse(musashino.pathSnapshot!);
    expect(musashinoSnapshot.pathId).toBe("jr-musashino-omiya");
    expect(musashinoSnapshot.masterVersion).toBe(SERVICE_MASTER_VERSION);

    const shimousa = resolveRideFields("しもうさ号", {
      rideState: "full",
      masterVersion: SERVICE_MASTER_VERSION,
    });
    expect(shimousa.serviceId).toBe("jr-shimousa");
    const shimousaSnapshot = JSON.parse(shimousa.pathSnapshot!);
    expect(shimousaSnapshot.pathId).toBe("jr-shimousa");
    // The branch segment's approximate flag rides along in
    // the snapshot (subtask 1593).
    expect(shimousaSnapshot.segments[1].approximate).toBe(true);
  });

  test("a full ride at the frozen version stores a snapshot only while the versions coincide (stage 2)", () => {
    // The snapshot is cut from the current master. While the
    // frozen migration version IS the current version, a ride at
    // it carries a snapshot like any current-version ride; once
    // the master moves on, the same ride must store none (the
    // client falls back to the current master instead of
    // painting a range cut from the wrong version).
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: MIGRATED_MASTER_VERSION,
    });
    // Both versions are string-literal consts, so once they
    // diverge (2026-11-26, subtask 1590) TS2367 rejects the
    // direct comparison — widen one side to string.
    if ((MIGRATED_MASTER_VERSION as string) === SERVICE_MASTER_VERSION) {
      expect(
        JSON.parse(fields.pathSnapshot!).masterVersion,
      ).toBe(SERVICE_MASTER_VERSION);
    } else {
      expect(fields.pathSnapshot).toBeNull();
    }
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
    // The reviewer passed the then-current version padded with
    // spaces (" 2026-11-24 " at the time) and it validated but
    // was saved with its spaces, so it no longer matched the
    // known version constants. The validated string is what
    // gets saved. The padded value tracks the current version
    // constant so the test survives a master version bump.
    const fields = resolveRideFields("京王線", {
      rideState: "full",
      masterVersion: ` ${SERVICE_MASTER_VERSION} `,
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
    expect(fields.pathSnapshot).toBeNull();
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

describe("resolveRideFields: partial endpoints must be stations of the service (batch review round 2, high)", () => {
  // The reviewer's reproduction: the block merge (round 1,
  // subtask 1593) made addRiddenSection refuse 西浦和 as an
  // endpoint of むさしの号 — it is a segment junction the trains
  // pass without stopping — but a NEW row saved with its section
  // at once (addRiddenLine) only had the format checks, so
  // 西浦和→大宮 was stored and aggregated as 7.77 km ridden.
  test("むさしの号 from its junctions 西浦和 / 与野 is rejected", () => {
    for (const fromStationId of ["003014", "002947"]) {
      expect(() =>
        resolveRideFields("むさしの号", {
          rideState: "partial",
          fromStationId,
          toStationId: "002914",
        }),
      ).toThrow(/not a station of/);
    }
  });

  test("むさしの号 北府中→大宮 is still accepted", () => {
    const fields = resolveRideFields("むさしの号", {
      rideState: "partial",
      fromStationId: "003771",
      toStationId: "002914",
    });
    expect(fields.rideState).toBe("partial");
    expect(fields.recordedServiceId).toBe("jr-musashino-omiya");
  });

  test("the check is generic: しもうさ号 from its junction 与野 is rejected, a stopping pair is accepted", () => {
    expect(() =>
      resolveRideFields("しもうさ号", {
        rideState: "partial",
        fromStationId: "002947",
        toStationId: "003547",
      }),
    ).toThrow(/not a station of/);
    const fields = resolveRideFields("しもうさ号", {
      rideState: "partial",
      fromStationId: "003006",
      toStationId: "003547",
    });
    expect(fields.rideState).toBe("partial");
    expect(fields.recordedServiceId).toBe("jr-shimousa");
  });

  test("a mid-segment stop known from a migrated ride stays accepted", () => {
    // 聖蹟桜ヶ丘 is no block boundary of 京王線; the master knows
    // it from the migrated 府中→聖蹟桜ヶ丘 ride. It is a real
    // stop, so a fresh registration may record the ride — the
    // stricter block-provability rule stays with
    // addRiddenSection (validateSectionEndpoints).
    const fields = resolveRideFields("京王線", {
      rideState: "partial",
      fromStationId: "003821",
      toStationId: "003971",
    });
    expect(fields.rideState).toBe("partial");
    expect(fields.recordedServiceId).toBe("keio");
  });

  test("a real N02 station of another line is rejected too", () => {
    // 西浦和 is a genuine station group code — just not 京王線's.
    expect(() =>
      resolveRideFields("京王線", {
        rideState: "partial",
        fromStationId: "003014",
        toStationId: "003821",
      }),
    ).toThrow(/not a station of/);
  });

  test("中央線快速 神田→新宿 is accepted: a junction the trains stop at is boardable", () => {
    // 神田 (003677) is the junction of jr-chuo-rapid's two
    // segments, but every rapid stops there, so it is listed on
    // block b1 and belongs to serviceBoardingStationIds — unlike
    // the pass-through junctions above (batch review round 3,
    // medium: it was refused although the stretch aggregates as
    // ridden distance).
    const fields = resolveRideFields("JR中央線（快速）", {
      rideState: "partial",
      fromStationId: "003677",
      toStationId: "003700",
    });
    expect(fields.rideState).toBe("partial");
    expect(fields.recordedServiceId).toBe("jr-chuo-rapid");
  });

  test("a loop partial is rejected: a row-level section carries no direction", () => {
    // Loop sections belong to addRiddenSection, which takes the
    // direction a directionless loop section cannot be read
    // without.
    expect(() =>
      resolveRideFields("山手線", {
        rideState: "partial",
        fromStationId: "003766",
        toStationId: "003700",
      }),
    ).toThrow(/direction/);
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

describe("resolveRideFields: a parenthetical naming another service or operator never links (review round 5, medium)", () => {
  test("「総武本線（総武快速線）」 and 「武蔵野線（京王電鉄）」 save unlinked", () => {
    // The reviewer's reproduction: importing them into an empty
    // ledger saved jr-sobu-local and jr-musashino. The qualifiers
    // contradict the outer name — one names another service, the
    // other another operator — so neither may be dropped.
    for (const name of ["総武本線（総武快速線）", "武蔵野線（京王電鉄）"]) {
      const fields = resolveRideFields(name, {});
      expect(fields.serviceId).toBeNull();
      expect(fields.rideState).toBe("unknown");
    }
  });

  test("qualifiers naming the candidate's own alias or operator still link", () => {
    expect(resolveRideFields("臨海副都心線（りんかい線）", {}).serviceId).toBe(
      "rinkai",
    );
    expect(resolveRideFields("武蔵野線 (JR東日本)", {}).serviceId).toBe(
      "jr-musashino",
    );
  });
});

describe("resolveRideFields: spaces inside the parentheses resolve (review round 5, low)", () => {
  test("「中央線 ( 快速 )」 links to the rapid service", () => {
    // The reviewer's reproduction: it saved with serviceId null and
    // counted 0 nationally, while 「中央線（快速）」 counted 1.
    const fields = resolveRideFields("中央線 ( 快速 )", {});
    expect(fields.serviceId).toBe("jr-chuo-rapid");
    expect(fields.rideState).toBe("unknown");
    expect(resolveRideFields("中央線 ( 快速)", {}).serviceId).toBe(
      "jr-chuo-rapid",
    );
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
    expect(fields.pathSnapshot).toBeNull();
  });
});
