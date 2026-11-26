/* Regression tests for the service master （系統マスタ）.
   Run with: bun test shared/service-master.test.ts
   The master is hand-recorded, so these tests pin its contents:
   every service's expansion, every migrated ride's restored section,
   and the invariants the meeting agreed on (all draft, station
   segments chain, no guessed sections). */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATED_MASTER_VERSION,
  MIGRATED_RIDES,
  SERVICE_MASTER,
  SERVICE_MASTER_VERSION,
  assetKeysForService,
  blocksForService,
  canonicalLedgerName,
  expandService,
  formalLineNames,
  isExplicitlyUnlinked,
  isKnownMasterVersion,
  isN02StationId,
  isRiddenServiceLinkReviewable,
  legacyServiceByLedgerName,
  recordedSectionFitsService,
  resolveRiddenService,
  sectionEndpointsKnownToService,
  sectionRouteAmbiguous,
  serviceBoundaryStations,
  serviceById,
  serviceByLedgerName,
  serviceExistsAtMasterVersion,
  serviceFullPathSnapshot,
  serviceOrderedStations,
  serviceStationIds,
  stationRefById,
  validateSectionEndpoints,
  type RestoredRide,
  type StationRef,
} from "./service-master";
import { RIDDEN_LINE_GEOMETRIES } from "../client/src/assets/visited-lines";

describe("master shape", () => {
  test("every entry carries the four required metadata fields", () => {
    expect(SERVICE_MASTER.length).toBe(13);
    for (const entry of SERVICE_MASTER) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
      expect(entry.sources.length).toBeGreaterThan(0);
      expect(entry.verificationStatus).toBe("draft");
      // Drafts are unverified by definition: no verified date yet.
      expect(entry.verifiedAt).toBeNull();
      expect(entry.segments.length).toBeGreaterThan(0);
      expect(entry.operator.length).toBeGreaterThan(0);
    }
  });

  test("ids and ledger names are unique across the master", () => {
    const ids = SERVICE_MASTER.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = SERVICE_MASTER.flatMap((e) => e.ledgerNames);
    expect(new Set(names).size).toBe(names.length);
  });

  test("canonical ledger names are unique across the master (review round 3)", () => {
    // The JR-prefix lookup matches on canonical names, so two
    // different entries must never canonicalize to the same key —
    // otherwise a JR-less spelling could attach to the wrong
    // service. Two spellings of the SAME entry sharing a canonical
    // key are fine (「JR中央線」 canonicalizes to 「中央線」, and
    // 「JR中央線（快速）」 to 「中央線（快速）」 — the （快速）
    // qualifier is kept because it tells the rapid apart from the
    // local service, review round 4).
    const keysByEntry = SERVICE_MASTER.map(
      (e) => new Set(e.ledgerNames.map((name) => canonicalLedgerName(name))),
    );
    for (let i = 0; i < keysByEntry.length; i++) {
      for (let j = i + 1; j < keysByEntry.length; j++) {
        for (const key of keysByEntry[i]!) {
          expect(keysByEntry[j]!.has(key)).toBe(false);
        }
      }
    }
  });

  test("segments chain: each segment starts where the last ended", () => {
    for (const entry of SERVICE_MASTER) {
      for (let i = 1; i < entry.segments.length; i++) {
        expect(entry.segments[i]!.from.id).toBe(
          entry.segments[i - 1]!.to.id,
        );
      }
    }
  });

  test("every segment's formal line exists in the bundled asset", () => {
    for (const entry of SERVICE_MASTER) {
      for (const segment of entry.segments) {
        expect(RIDDEN_LINE_GEOMETRIES[segment.formalLineKey]).toBeDefined();
      }
    }
  });

  test("station ids are six-digit N02 group codes", () => {
    for (const entry of SERVICE_MASTER) {
      for (const segment of entry.segments) {
        expect(segment.from.id).toMatch(/^\d{6}$/);
        expect(segment.to.id).toMatch(/^\d{6}$/);
      }
    }
  });
});

describe("service → formal line expansion", () => {
  test("JR埼京線 expands to four formal lines in running order", () => {
    expect(formalLineNames("jr-saikyo")).toEqual([
      "山手線",
      "赤羽線",
      "東北線",
      "川越線",
    ]);
    expect(assetKeysForService("jr-saikyo")).toEqual([
      "山手線|東日本旅客鉄道",
      "赤羽線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
      "川越線|東日本旅客鉄道",
    ]);
    const segments = expandService("jr-saikyo");
    expect(segments).toHaveLength(4);
    expect(segments[0]!.from.name).toBe("大崎");
    expect(segments[3]!.to.name).toBe("川越");
  });

  test("the 大崎〜池袋 stretch is marked approximate (freight line stand-in)", () => {
    const segments = expandService("jr-saikyo");
    expect(segments[0]!.approximate).toBe(true);
    expect(segments[0]!.formalLineName).toBe("山手線");
    // The other three run on their own lines.
    expect(segments.slice(1).every((s) => !s.approximate)).toBe(true);
  });

  test("single-line services expand to one formal line", () => {
    expect(formalLineNames("jr-musashino")).toEqual(["武蔵野線"]);
    expect(formalLineNames("hokuso")).toEqual(["北総線"]);
    expect(formalLineNames("jr-chuo-rapid")).toEqual(["中央線"]);
    expect(formalLineNames("jr-sobu-rapid")).toEqual(["総武線"]);
    expect(formalLineNames("jr-sobu-local")).toEqual(["総武線"]);
    expect(formalLineNames("keio")).toEqual(["京王線"]);
    expect(formalLineNames("keio-new-line")).toEqual(["京王線"]);
    expect(formalLineNames("rinkai")).toEqual(["臨海副都心線"]);
    expect(formalLineNames("tobu-noda")).toEqual(["野田線"]);
  });

  test("山手線 is a loop of three formal lines in running order", () => {
    // The N02 山手線 key only covers 品川〜田端, so the loop is
    // held as three segments (review finding 4): 山手線 品川〜田端,
    // 東北線 田端〜東京, 東海道線 東京〜品川 — all outer-loop.
    expect(formalLineNames("yamanote")).toEqual([
      "山手線",
      "東北線",
      "東海道線",
    ]);
    expect(assetKeysForService("yamanote")).toEqual([
      "山手線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
      "東海道線|東日本旅客鉄道",
    ]);
  });

  test("むさしの号 forks off 武蔵野線 onto 東北線 at 西浦和 (subtask 1590)", () => {
    // The 大宮 branch forks at 西浦和, which the linear path
    // model cannot hold on jr-musashino itself — so むさしの号
    // is its own service: 武蔵野線 府中本町〜西浦和, 武蔵野線
    // （大宮支線） 西浦和〜与野, 東北線 与野〜大宮. The two
    // 武蔵野線 segments share one asset key, so the expansion
    // dedupes to two formal lines / two keys.
    expect(formalLineNames("jr-musashino-omiya")).toEqual([
      "武蔵野線",
      "東北線",
    ]);
    expect(assetKeysForService("jr-musashino-omiya")).toEqual([
      "武蔵野線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
    ]);
    const segments = expandService("jr-musashino-omiya");
    expect(segments).toHaveLength(3);
    expect(segments[0]!.from.name).toBe("府中本町");
    expect(segments[0]!.to.name).toBe("西浦和");
    expect(segments[1]!.to.name).toBe("与野");
    expect(segments[2]!.to.name).toBe("大宮");
    expect(serviceByLedgerName("むさしの号")?.id).toBe(
      "jr-musashino-omiya",
    );
    // The parent line keeps its own identity.
    expect(serviceByLedgerName("JR武蔵野線")?.id).toBe("jr-musashino");
  });

  test("しもうさ号 mirrors むさしの号 across the fork at 与野 (subtask 1591)", () => {
    // The 大宮→西船橋 counterpart of むさしの号, recorded
    // ahead of any ride: 東北線 大宮〜与野, 武蔵野線 （支線）
    // 与野〜武蔵浦和, 武蔵野線 武蔵浦和〜西船橋. The two
    // 武蔵野線 segments share one asset key, so the expansion
    // dedupes to two formal lines / two keys.
    expect(formalLineNames("jr-shimousa")).toEqual([
      "東北線",
      "武蔵野線",
    ]);
    expect(assetKeysForService("jr-shimousa")).toEqual([
      "東北線|東日本旅客鉄道",
      "武蔵野線|東日本旅客鉄道",
    ]);
    const segments = expandService("jr-shimousa");
    expect(segments).toHaveLength(3);
    expect(segments[0]!.from.name).toBe("大宮");
    expect(segments[0]!.to.name).toBe("与野");
    expect(segments[1]!.to.name).toBe("武蔵浦和");
    expect(segments[2]!.to.name).toBe("西船橋");
    // The branch segment's shape runs ~37% long against the
    // physical run (see the master note), so it is flagged
    // approximate; the other two segments are the lines
    // themselves (review batch round 1, subtask 1593).
    expect(segments[1]!.approximate).toBe(true);
    expect(segments[0]!.approximate).toBeUndefined();
    expect(segments[2]!.approximate).toBeUndefined();
    expect(serviceByLedgerName("しもうさ号")?.id).toBe("jr-shimousa");
  });

  test("りんかい線 resolves to its official name 臨海副都心線", () => {
    expect(assetKeysForService("rinkai")).toEqual([
      "臨海副都心線|東京臨海高速鉄道",
    ]);
  });

  test("山手線 is a loop: its segments chain 品川→田端→東京→品川", () => {
    const segments = expandService("yamanote");
    expect(segments).toHaveLength(3);
    expect(segments[0]!.from.name).toBe("品川");
    expect(segments[0]!.to.name).toBe("田端");
    expect(segments[1]!.to.name).toBe("東京");
    expect(segments[2]!.to.name).toBe("品川");
    // The whole loop is the outer side (the migrated ride
    // 大崎→目黒 runs outer-loop order); stage 2 uses this to tell
    // which side of the loop a ride took.
    expect(segments.every((s) => s.direction === "outer")).toBe(true);
  });

  test("an unknown service id expands to nothing", () => {
    expect(expandService("does-not-exist")).toEqual([]);
    expect(formalLineNames("does-not-exist")).toEqual([]);
    expect(assetKeysForService("does-not-exist")).toEqual([]);
  });
});

describe("ledger-name lookup", () => {
  test("all nine ledger rows find their service", () => {
    for (const name of Object.keys(MIGRATED_RIDES)) {
      expect(serviceByLedgerName(name)).toBeDefined();
    }
  });

  test("「JR中央線」 without the （快速） suffix is the rapid service", () => {
    expect(serviceByLedgerName("JR中央線")?.id).toBe("jr-chuo-rapid");
  });

  test("「東武アーバンパークライン」 is the nickname of 東武野田線 (subtask 1566)", () => {
    expect(serviceByLedgerName("東武野田線")?.id).toBe("tobu-noda");
    expect(serviceByLedgerName("東武アーバンパークライン")?.id).toBe(
      "tobu-noda",
    );
  });

  test("「京王新線」 is its own service, not the 京王線 (subtask 1574)", () => {
    expect(serviceByLedgerName("京王新線")?.id).toBe("keio-new-line");
    expect(serviceByLedgerName("京王線")?.id).toBe("keio");
  });

  test("「臨海副都心線（りんかい線）」 with the parenthetical is the rinkai service (review round 2)", () => {
    // The reviewer registered 「りんかい線」 and
    // 「臨海副都心線（りんかい線）」 and got 2/1 for 東京臨海高速鉄道:
    // the parenthetical spelling matched no ledger name, so its row
    // stayed unlinked and counted by map key instead of by service.
    // A trailing （…） qualifier does not make a different service.
    expect(serviceByLedgerName("臨海副都心線（りんかい線）")?.id).toBe(
      "rinkai",
    );
    expect(serviceByLedgerName("臨海副都心線")?.id).toBe("rinkai");
    // The qualifier is stripped only for the lookup: a base name
    // the master does not know still finds nothing.
    expect(serviceByLedgerName("存在しない線（快速）")).toBeUndefined();
  });

  test("「武蔵野線」 without the JR prefix is the jr-musashino service (review round 3)", () => {
    // The reviewer registered 「JR武蔵野線」 and 「武蔵野線」 and got
    // 2/597 nationally and 2 for JR東日本: the JR-less spelling
    // matched no ledger name, so its row stayed unlinked and counted
    // by map key instead of by service. A leading JR operator prefix
    // does not make a different service.
    expect(serviceByLedgerName("武蔵野線")?.id).toBe("jr-musashino");
    expect(serviceByLedgerName("JR武蔵野線")?.id).toBe("jr-musashino");
    // The prefix is stripped only for the lookup: a name the master
    // does not know still finds nothing.
    expect(serviceByLedgerName("JR存在しない線")).toBeUndefined();
  });

  test("「中央線（各駅停車）」 is a different service from the rapid and stays unlinked (review round 4)", () => {
    // The reviewer's reproduction: a new 「中央線（各駅停車）」 row
    // was saved as jr-chuo-rapid and then shown as 「中央線快速」.
    // The （各駅停車） qualifier tells the local service apart
    // from the rapid — it is not a redundant qualifier like
    // （りんかい線） — so it must not be stripped for the lookup.
    // The local service is not in the master yet, so the row stays
    // unlinked until the master gains a local-service entry.
    expect(serviceByLedgerName("中央線（各駅停車）")).toBeUndefined();
    expect(serviceByLedgerName("中央線(各駅停車）")).toBeUndefined();
    // The rapid service itself is unaffected.
    expect(serviceByLedgerName("JR中央線（快速）")?.id).toBe("jr-chuo-rapid");
    expect(serviceByLedgerName("中央線（快速）")?.id).toBe("jr-chuo-rapid");
  });

  test("a half-width parenthetical operator note resolves (review round 4)", () => {    // The reviewer's reproduction: 「武蔵野線 (JR東日本)」 was not
    // recognized as the musashino service because the canonical
    // form only handled full-width （） — the half-width parens
    // and spaces are the same qualifier shape.
    expect(serviceByLedgerName("武蔵野線 (JR東日本)")?.id).toBe(
      "jr-musashino",
    );
    expect(serviceByLedgerName("武蔵野線（JR東日本）")?.id).toBe(
      "jr-musashino",
    );
    expect(canonicalLedgerName("武蔵野線 (JR東日本)")).toBe("武蔵野線");
    // A distinguishing qualifier is kept, not stripped.
    expect(canonicalLedgerName("中央線（各駅停車）")).toBe(
      "中央線（各駅停車）",
    );
  });

  test("an unregistered name finds no service", () => {
    expect(serviceByLedgerName("存在しない線")).toBeUndefined();
    expect(serviceByLedgerName("西武池袋線")).toBeUndefined();
  });

  test("serviceById finds each entry", () => {
    for (const entry of SERVICE_MASTER) {
      expect(serviceById(entry.id)).toBe(entry);
    }
    expect(serviceById("does-not-exist")).toBeUndefined();
  });
});

describe("review round 5: a parenthetical that names another service or operator never links (medium)", () => {
  test("「総武本線（総武快速線）」 contradicts itself and stays unlinked", () => {
    // The reviewer's reproduction: importing it into an empty
    // ledger saved jr-sobu-local — the qualifier names a DIFFERENT
    // service (the rapid), so dropping it attaches the row to the
    // wrong service. A qualifier is redundant only when it names
    // the candidate's own alias or the candidate's own operator.
    expect(serviceByLedgerName("総武本線（総武快速線）")).toBeUndefined();
    expect(canonicalLedgerName("総武本線（総武快速線）")).toBe(
      "総武本線（総武快速線）",
    );
  });

  test("「武蔵野線（京王電鉄）」 names another operator and stays unlinked", () => {
    // The reviewer's reproduction: it saved jr-musashino, although
    // the note says 京王電鉄 and the musashino service is JR East's.
    // The old check accepted ANY operator in the master as the
    // qualifier; only the candidate's own operator counts now.
    expect(serviceByLedgerName("武蔵野線（京王電鉄）")).toBeUndefined();
    expect(canonicalLedgerName("武蔵野線（京王電鉄）")).toBe(
      "武蔵野線（京王電鉄）",
    );
  });

  test("a qualifier naming the candidate's own alias or operator still links", () => {
    // The teacher's own positive cases: both must keep linking.
    expect(serviceByLedgerName("臨海副都心線（りんかい線）")?.id).toBe(
      "rinkai",
    );
    expect(serviceByLedgerName("武蔵野線 (JR東日本)")?.id).toBe(
      "jr-musashino",
    );
    expect(serviceByLedgerName("武蔵野線（JR東日本）")?.id).toBe(
      "jr-musashino",
    );
    // And the distinguishing qualifier keeps the local service out.
    expect(serviceByLedgerName("中央線（各駅停車）")).toBeUndefined();
    expect(serviceByLedgerName("中央線（快速）")?.id).toBe("jr-chuo-rapid");
  });
});

describe("review round 5: spaces inside the parentheses are the same qualifier shape (low)", () => {
  test("「中央線 ( 快速 )」 links to the rapid service", () => {
    // The reviewer's reproduction: it saved with serviceId null and
    // counted 0 in the national donut, while 「中央線（快速）」
    // counted 1. The spaces inside the parentheses are trimmed
    // when the paren width is unified — the identifying word
    // （快速） is kept, only its padding goes.
    expect(canonicalLedgerName("中央線 ( 快速 )")).toBe("中央線（快速）");
    expect(canonicalLedgerName("中央線 ( 快速)")).toBe("中央線（快速）");
    expect(serviceByLedgerName("中央線 ( 快速 )")?.id).toBe("jr-chuo-rapid");
    expect(serviceByLedgerName("中央線 ( 快速)")?.id).toBe("jr-chuo-rapid");
  });
});

describe("legacy matching and saved link review", () => {
  test("legacyServiceByLedgerName reproduces the pre-round-4 blanket strip", () => {
    // The old canonical form dropped any trailing （…） and the
    // leading JR, so 「中央線（各駅停車）」 attached to the rapid
    // service — the bug round 4 fixed at save time. Half-width
    // parens were not unified then, so they did not resolve.
    expect(legacyServiceByLedgerName("中央線（各駅停車）")?.id).toBe(
      "jr-chuo-rapid",
    );
    expect(legacyServiceByLedgerName("総武本線（総武快速線）")?.id).toBe(
      "jr-sobu-local",
    );
    expect(legacyServiceByLedgerName("武蔵野線（京王電鉄）")?.id).toBe(
      "jr-musashino",
    );
    expect(legacyServiceByLedgerName("武蔵野線 (JR東日本)")).toBeUndefined();
    expect(legacyServiceByLedgerName("JR中央線（快速）")?.id).toBe(
      "jr-chuo-rapid",
    );
  });

  test("conflicting links retain evidence from both historical lookup generations", () => {
    for (const [name, serviceId, historicalAutoMatchVersions] of [
      ["中央線（各駅停車）", "jr-chuo-rapid", ["1"]],
      ["武蔵野線 (京王電鉄)", "jr-musashino", ["2"]],
      ["総武本線（総武快速線）", "jr-sobu-local", ["1", "2"]],
      ["中央線（各駅停車）", "jr-sobu-local", []],
      ["中央線（各駅停車）", "does-not-exist", []],
    ] as const) {
      expect(resolveRiddenService({ name, serviceId })).toEqual({
        service: undefined,
        needsReview: true,
        historicalAutoMatchVersions,
      });
    }
    for (const [name, serviceId] of [
      ["JR中央線（快速）", "jr-chuo-rapid"],
      ["京王線", "keio"],
      ["武蔵野線 (JR東日本)", "jr-musashino"],
    ] as const) {
      const link = resolveRiddenService({ name, serviceId });
      expect(link.needsReview).toBe(false);
      expect(link.service?.id).toBe(serviceId);
    }
  });

  test("documented explicit links are distinguished from inferred historical links", () => {
    const row = { name: "武蔵野線 (京王電鉄)", serviceId: "jr-musashino" };
    expect(resolveRiddenService(row).needsReview).toBe(true);
    expect(resolveRiddenService({
      ...row,
      serviceLinkSource: "auto",
      serviceMatchVersion: "2",
    })).toMatchObject({ needsReview: true, historicalAutoMatchVersions: ["2"] });
    const confirmed = resolveRiddenService({ ...row, serviceLinkSource: "explicit" });
    expect(confirmed.needsReview).toBe(false);
    expect(confirmed.service?.id).toBe(row.serviceId);
  });

  test("only rows awaiting confirmation (or an explicit unlink) are reviewable", () => {
    // A saved link the current name rule disagrees with.
    expect(
      isRiddenServiceLinkReviewable({
        name: "武蔵野線 (京王電鉄)",
        serviceId: "jr-musashino",
      }),
    ).toBe(true);
    // A clean link, auto or explicit, needs no confirmation.
    expect(
      isRiddenServiceLinkReviewable({ name: "京王線", serviceId: "keio" }),
    ).toBe(false);
    expect(
      isRiddenServiceLinkReviewable({
        name: "武蔵野線 (京王電鉄)",
        serviceId: "jr-musashino",
        serviceLinkSource: "explicit",
      }),
    ).toBe(false);
    // An explicit unlink can be undone by confirming again.
    expect(
      isRiddenServiceLinkReviewable({
        name: "武蔵野線 (京王電鉄)",
        serviceId: null,
        serviceLinkSource: "explicit",
      }),
    ).toBe(true);
    // A never-linked row is not this operation's target.
    expect(
      isRiddenServiceLinkReviewable({ name: "武蔵野線 (京王電鉄)", serviceId: null }),
    ).toBe(false);
  });
});

describe("save-time validation (review round 2)", () => {
  test("isN02StationId accepts six-digit group codes only", () => {
    expect(isN02StationId("003766")).toBe(true);
    expect(isN02StationId("004135")).toBe(true);
    // The reviewer's reproduction values.
    expect(isN02StationId("bad")).toBe(false);
    expect(isN02StationId("")).toBe(false);
    expect(isN02StationId("12345")).toBe(false);
    expect(isN02StationId("1234567")).toBe(false);
    expect(isN02StationId("00376a")).toBe(false);
    expect(isN02StationId(" 003766")).toBe(false);
  });

  test("isKnownMasterVersion accepts only versions the master knows", () => {
    expect(isKnownMasterVersion(SERVICE_MASTER_VERSION)).toBe(true);
    expect(isKnownMasterVersion(MIGRATED_MASTER_VERSION)).toBe(true);
    // The reviewer's reproduction values.
    expect(isKnownMasterVersion("bogus")).toBe(false);
    expect(isKnownMasterVersion("")).toBe(false);
    expect(isKnownMasterVersion(" ")).toBe(false);
    expect(isKnownMasterVersion("2026-11-25")).toBe(false);
  });

  test("serviceExistsAtMasterVersion tells which services a version's master held (subtask 1593)", () => {
    // The current master holds every service, old and new.
    expect(serviceExistsAtMasterVersion("keio", SERVICE_MASTER_VERSION)).toBe(true);
    expect(
      serviceExistsAtMasterVersion("jr-musashino-omiya", SERVICE_MASTER_VERSION),
    ).toBe(true);
    expect(
      serviceExistsAtMasterVersion("jr-shimousa", SERVICE_MASTER_VERSION),
    ).toBe(true);
    expect(
      serviceExistsAtMasterVersion("tobu-noda", SERVICE_MASTER_VERSION),
    ).toBe(true);
    expect(
      serviceExistsAtMasterVersion("keio-new-line", SERVICE_MASTER_VERSION),
    ).toBe(true);
    // The frozen migration master held the nine migrated
    // services — and not the two added on 2026-11-26, nor the
    // two added on 2026-11-27.
    expect(serviceExistsAtMasterVersion("keio", MIGRATED_MASTER_VERSION)).toBe(true);
    expect(
      serviceExistsAtMasterVersion("jr-musashino", MIGRATED_MASTER_VERSION),
    ).toBe(true);
    expect(
      serviceExistsAtMasterVersion("jr-musashino-omiya", MIGRATED_MASTER_VERSION),
    ).toBe(false);
    expect(
      serviceExistsAtMasterVersion("jr-shimousa", MIGRATED_MASTER_VERSION),
    ).toBe(false);
    expect(
      serviceExistsAtMasterVersion("tobu-noda", MIGRATED_MASTER_VERSION),
    ).toBe(false);
    expect(
      serviceExistsAtMasterVersion("keio-new-line", MIGRATED_MASTER_VERSION),
    ).toBe(false);
    // Unknown versions and unknown services hold nothing.
    expect(serviceExistsAtMasterVersion("keio", "bogus")).toBe(false);
    expect(
      serviceExistsAtMasterVersion("no-such-service", SERVICE_MASTER_VERSION),
    ).toBe(false);
  });
});

describe("the nine migrated rides", () => {
  test("exactly the nine live ledger rows are migrated", () => {
    expect(Object.keys(MIGRATED_RIDES).sort()).toEqual(
      [
        "JR中央線（快速）",
        "JR埼京線",
        "JR武蔵野線",
        "JR総武快速線",
        "JR総武本線",
        "りんかい線",
        "京王線",
        "北総線",
        "山手線",
      ].sort(),
    );
  });

  test("seven rides restore a section, two stay unknown", () => {
    const states = Object.values(MIGRATED_RIDES).map((r) => r.rideState);
    expect(states.filter((s) => s === "partial")).toHaveLength(7);
    expect(states.filter((s) => s === "unknown")).toHaveLength(2);
    expect(states.filter((s) => s === "full")).toHaveLength(0);
  });

  test("the restored sections match the recorded trip contexts", () => {
    const section = (name: string): [string, string] => {
      const ride = MIGRATED_RIDES[name]!;
      expect(ride.rideState).toBe("partial");
      return [ride.from!.name, ride.to!.name];
    };
    expect(section("JR中央線（快速）")).toEqual(["国分寺", "東京"]);
    expect(section("JR総武快速線")).toEqual(["東京", "千葉"]);
    expect(section("JR総武本線")).toEqual(["佐倉", "千葉"]);
    expect(section("京王線")).toEqual(["府中", "聖蹟桜ヶ丘"]);
    expect(section("JR埼京線")).toEqual(["新宿", "大崎"]);
    expect(section("りんかい線")).toEqual(["大崎", "品川シーサイド"]);
    expect(section("山手線")).toEqual(["大崎", "目黒"]);
  });

  test("a restored section runs between two different stations", () => {
    // The master carries segment endpoints, not a per-station line
    // membership table, so station→line membership was cross-checked
    // once against the raw N02 station data (see DATA-PLAN.md):
    // every restored endpoint is a station point of its formal line,
    // except 東京駅 on 中央線 — N02's station points carry no
    // （東京, 中央線） row, though the group code 003766 is confirmed
    // as 東京駅 on the other JR lines and 中央線 serves 東京駅.
    // The unit test pins what the master itself guarantees.
    for (const ride of Object.values(MIGRATED_RIDES)) {
      if (ride.rideState !== "partial") continue;
      expect(ride.from).not.toBeNull();
      expect(ride.to).not.toBeNull();
      expect(ride.from!.id).not.toBe(ride.to!.id);
    }
  });

  test("unknown rides carry no section", () => {
    for (const name of ["JR武蔵野線", "北総線"]) {
      const ride = MIGRATED_RIDES[name]!;
      expect(ride.rideState).toBe("unknown");
      expect(ride.from).toBeNull();
      expect(ride.to).toBeNull();
    }
  });

  test("every migrated ride records the master version it was cut at", () => {
    // Frozen, NOT tracking SERVICE_MASTER_VERSION (review finding
    // 6): the next master bump must leave these rows alone.
    for (const ride of Object.values(MIGRATED_RIDES)) {
      expect(ride.masterVersion).toBe(MIGRATED_MASTER_VERSION);
    }
    expect(MIGRATED_MASTER_VERSION).toBe("2026-11-24");
  });

  test("the SQL migration backfills exactly these rides (applied to a real SQLite DB)", async () => {
    // drizzle/0011_ridden_lines_service_master.sql is the other copy
    // of this table (SQL cannot import it); the two must agree, or
    // the live ledger and the app disagree about a ride. The SQL is
    // verified by APPLYING it to a scratch database (review finding
    // 6), not by parsing its text — so its WHERE clauses and
    // statement order are exercised, not just its spelling.
    const db = new Database(":memory:");
    // The table as it stands just before 0011 (0008 + 0010).
    db.exec(`
      CREATE TABLE ridden_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        name TEXT NOT NULL,
        first_ridden_on TEXT NOT NULL,
        note TEXT,
        context TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    // The nine legacy rows, at their recorded first-ride dates
    // (location-trivia/seen_lines.md), plus rows the migration must
    // leave alone: a same-name row on a different date, and an
    // unrelated line.
    const seed: [string, string][] = [
      ["JR武蔵野線", "2026-11-12"],
      ["北総線", "2026-11-12"],
      ["JR中央線（快速）", "2026-11-15"],
      ["JR総武快速線", "2026-11-15"],
      ["JR総武本線", "2026-11-16"],
      ["京王線", "2026-11-22"],
      ["JR埼京線", "2026-11-24"],
      ["りんかい線", "2026-11-24"],
      ["山手線", "2026-11-24"],
      ["JR武蔵野線", "2026-11-13"],
      ["西武池袋線", "2026-11-20"],
    ];
    const insert = db.prepare(
      "INSERT INTO ridden_lines (name, first_ridden_on, created_at) VALUES (?, ?, 0)",
    );
    for (const [name, date] of seed) insert.run(name, date);
    const sqlText = await Bun.file(
      new URL(
        "../drizzle/0011_ridden_lines_service_master.sql",
        import.meta.url,
      ),
    ).text();
    db.exec(sqlText);
    type Row = {
      service_id: string | null;
      ride_state: string;
      from_station_id: string | null;
      from_station_name: string | null;
      to_station_id: string | null;
      to_station_name: string | null;
      master_version: string | null;
    };
    const read = (name: string, date: string): Row =>
      db
        .query(
          "SELECT service_id, ride_state, from_station_id, from_station_name, to_station_id, to_station_name, master_version FROM ridden_lines WHERE name = ? AND first_ridden_on = ?",
        )
        .get(name, date) as Row;
    const toRide = (row: Row): RestoredRide => {
      // The SQL stores only the station id + name; the coordinates
      // ride along in the TS table, so the comparison attaches
      // them from the expected ride (id + name must match exactly).
      const stationWithCoords = (
        id: string | null,
        name: string | null,
      ): StationRef | null => {
        if (!id || !name) return null;
        for (const ride of Object.values(MIGRATED_RIDES)) {
          for (const station of [ride.from, ride.to]) {
            if (station?.id === id && station.name === name) return station;
          }
        }
        return { id, name, lng: 0, lat: 0 };
      };
      return {
        serviceId: row.service_id!,
        rideState: row.ride_state as RestoredRide["rideState"],
        from: stationWithCoords(row.from_station_id, row.from_station_name),
        to: stationWithCoords(row.to_station_id, row.to_station_name),
        masterVersion: row.master_version!,
      };
    };
    // All seven columns of all nine rows match the TS table.
    for (const [name, ride] of Object.entries(MIGRATED_RIDES)) {
      const date = seed.find(([n]) => n === name)![1]!;
      expect(toRide(read(name, date))).toEqual(ride);
    }
    // The rows outside the migration's scope stay untouched.
    expect(read("JR武蔵野線", "2026-11-13")).toEqual({
      service_id: null,
      ride_state: "unknown",
      from_station_id: null,
      from_station_name: null,
      to_station_id: null,
      to_station_name: null,
      master_version: null,
    });
    expect(read("西武池袋線", "2026-11-20").service_id).toBeNull();
    // Re-running the migration changes nothing, and an explicitly
    // recorded section survives it: give the out-of-scope 武蔵野線
    // row a caller's own link + section, then apply the UPDATEs
    // again (the ADD COLUMNs cannot run twice — only the backfill
    // is re-runnable, which is exactly what the guards protect).
    db.exec(
      "UPDATE ridden_lines SET service_id = 'keio', ride_state = 'partial', from_station_id = '003700', from_station_name = '新宿', to_station_id = '003821', to_station_name = '府中', master_version = '2026-11-24' WHERE name = 'JR武蔵野線' AND first_ridden_on = '2026-11-13'",
    );
    const backfillOnly = sqlText
      .split("--> statement-breakpoint")
      .filter((part) => part.trimStart().startsWith("UPDATE"))
      .join("\n");
    db.exec(backfillOnly);
    expect(read("JR武蔵野線", "2026-11-13")).toEqual({
      service_id: "keio",
      ride_state: "partial",
      from_station_id: "003700",
      from_station_name: "新宿",
      to_station_id: "003821",
      to_station_name: "府中",
      master_version: "2026-11-24",
    });
    for (const [name, ride] of Object.entries(MIGRATED_RIDES)) {
      const date = seed.find(([n]) => n === name)![1]!;
      expect(toRide(read(name, date))).toEqual(ride);
    }
    db.close();
  });
});

describe("stage 2 blocks (subtask 1421)", () => {
  test("every service's blocks partition it between boundary stations", () => {
    for (const entry of SERVICE_MASTER) {
      expect(entry.blocks.length).toBeGreaterThan(0);
      // Blocks chain: each block starts where the previous ended.
      for (let i = 1; i < entry.blocks.length; i++) {
        expect(entry.blocks[i]!.from.id).toBe(entry.blocks[i - 1]!.to.id);
      }
      // The blocks cover the service end to end: first block starts
      // at the first segment's from, last block ends at the last
      // segment's to (a loop closes on its first station).
      expect(entry.blocks[0]!.from.id).toBe(entry.segments[0]!.from.id);
      expect(entry.blocks[entry.blocks.length - 1]!.to.id).toBe(
        entry.segments[entry.segments.length - 1]!.to.id,
      );
      // Every station in the entry carries coordinates (the
      // geometry code projects sections onto the line shape).
      for (const station of [
        ...entry.segments.flatMap((s) => [s.from, s.to]),
        ...entry.blocks.flatMap((b) => [
          b.from,
          ...(b.stations ?? []),
          b.to,
        ]),
      ]) {
        expect(Number.isFinite(station.lng)).toBe(true);
        expect(Number.isFinite(station.lat)).toBe(true);
        expect(station.lng).toBeGreaterThan(122);
        expect(station.lng).toBeLessThan(146);
        expect(station.lat).toBeGreaterThan(24);
        expect(station.lat).toBeLessThan(46);
      }
    }
  });

  test("block ids are unique across the master", () => {
    const ids = SERVICE_MASTER.flatMap((e) => e.blocks.map((b) => b.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("validateSectionEndpoints: whole blocks and multi-block runs pass", () => {
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003766", "003700"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003766", "004029"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio", "003966", "003934"),
    ).toBeNull();
  });

  test("validateSectionEndpoints: unlisted stations fail, reversed order passes (review round 1)", () => {
    // 国分寺 used to be the example here: a real station on 中央線
    // known only from a migrated ride, listed on no block, so it
    // could not be a section endpoint. Subtask 1572 listed it on
    // jr-chuo-rapid/b2, so it now resolves (the five restored
    // sections are covered in the subtask 1572 test below).
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003606", "004029"),
    ).toBeNull();
    // A station of another service still fails: 調布 is 京王線's
    // block boundary, not 中央線's.
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003966", "004029"),
    ).toMatch(/not a station of/);
    // A section is one stretch of the line, travelled either
    // way: 高尾→東京 is the same stretch as 東京→高尾, so the
    // old running-order rejection is gone (review round 1, high
    // — the return ride 東松戸→北府中 runs against the running
    // order and must be accepted).
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "004029", "003766"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003766", "003766"),
    ).toMatch(/two different stations/);
    expect(validateSectionEndpoints("no-such-service", "003766", "003700")).toMatch(
      /unknown service/,
    );
  });

  test("validateSectionEndpoints: listed mid-block stations pass (subtask 1455)", () => {
    // The three estimated sections of subtask 1455: both endpoints
    // are stations listed on a block of the service. The 武蔵野線
    // one runs against the running order （東松戸→北府中 is the
    // return ride) — that is accepted, and so is the same pair
    // the other way round.
    expect(
      validateSectionEndpoints("jr-musashino", "003187", "003771"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-musashino", "003771", "003187"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("hokuso", "003187", "003083"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("hokuso", "003083", "003187"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("yamanote", "003700", "004135", "inner"),
    ).toBeNull();
    // The loop still needs its direction, and either side is a
    // valid section — the direction picks which one.
    expect(
      validateSectionEndpoints("yamanote", "003700", "004135"),
    ).toMatch(/needs a direction/);
    expect(
      validateSectionEndpoints("yamanote", "003700", "004135", "outer"),
    ).toBeNull();
    // A listed station against a boundary of a later block works.
    expect(
      validateSectionEndpoints("jr-musashino", "003187", "003547"),
    ).toBeNull();
  });

  test("validateSectionEndpoints: the むさしの号 ride 北府中→大宮 passes (subtask 1590)", () => {
    // 北府中 is listed on jr-musashino-omiya/b1 and 大宮 is the
    // block's far boundary: the 2026-11-26 ride resolves as a
    // section of the new service, in either direction.
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "003771", "002914"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "002914", "003771"),
    ).toBeNull();
    // The whole service also passes.
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "003876", "002914"),
    ).toBeNull();
    // 西浦和 is only the junction where the path forks onto
    // the 大宮支線 — むさしの号 does not stop there, so it is
    // not an endpoint, in either direction or against itself
    // (review batch round 1, subtask 1593; the block no
    // longer splits at 西浦和).
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "003014", "002914"),
    ).toMatch(/not a station of/);
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "002914", "003014"),
    ).toMatch(/not a station of/);
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "003014", "003014"),
    ).toMatch(/two different stations/);
    // 南浦和 is a station of the parent jr-musashino service but
    // the むさしの号 never calls there — it is not an endpoint
    // of this service.
    expect(
      validateSectionEndpoints("jr-musashino-omiya", "003004", "002914"),
    ).toMatch(/not a station of/);
    // Ordered stations: the two block boundaries with the
    // listed mid-block station interleaved; 西浦和 and 与野
    // are only segment junctions, so neither appears.
    expect(
      serviceOrderedStations("jr-musashino-omiya").map((s) => s.id),
    ).toEqual(["003876", "003771", "002914"]);
  });

  test("validateSectionEndpoints: しもうさ号 endpoints (subtask 1591)", () => {
    // The whole service passes in either direction, and a
    // section ending at a listed mid-block station （東松戸
    // on b3) resolves too.
    expect(
      validateSectionEndpoints("jr-shimousa", "002914", "003547"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-shimousa", "003547", "002914"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-shimousa", "002914", "003187"),
    ).toBeNull();
    // 西浦和 is not a station of this service: the しもうさ号
    // joins the main line at 別所信号場 without calling there
    // (the simplified shape's junction sits near 西浦和, but
    // the station is not the service's).
    expect(
      validateSectionEndpoints("jr-shimousa", "003014", "003547"),
    ).toMatch(/not a station of/);
    // Ordered stations: block boundaries with the listed
    // mid-block station interleaved; 与野 is only a segment
    // junction, so it does not appear (same as on
    // jr-musashino-omiya).
    expect(
      serviceOrderedStations("jr-shimousa").map((s) => s.id),
    ).toEqual(["002914", "003006", "003004", "003187", "003547"]);
  });

  test("validateSectionEndpoints: 東武野田線 endpoints (subtask 1566)", () => {
    // The whole service passes in either direction, and the
    // 2026-11-26 ride 大宮→七光台 resolves: 七光台 is listed
    // on tobu-noda/b2 and 大宮 is the service's far boundary.
    expect(
      validateSectionEndpoints("tobu-noda", "002914", "003589"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("tobu-noda", "003589", "002914"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("tobu-noda", "002914", "002803"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("tobu-noda", "002803", "002914"),
    ).toBeNull();
    // A block boundary against the listed mid-block station
    // of the same block works too.
    expect(
      validateSectionEndpoints("tobu-noda", "002785", "002803"),
    ).toBeNull();
    // Ordered stations: block boundaries with the listed
    // mid-block station interleaved in running order.
    expect(
      serviceOrderedStations("tobu-noda").map((s) => s.id),
    ).toEqual(["002914", "002785", "002803", "002984", "003589"]);
  });

  test("validateSectionEndpoints: the five restored sections register (subtask 1572)", () => {
    // The five ledger rides of 2026-11-15〜11-24 that were known
    // only from their migrated endpoints: each far end is now
    // listed on a block, so addRiddenSection accepts the section.
    // Non-loop sections pass in either direction.
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003606", "003766"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003766", "003606"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-saikyo", "003700", "004135"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("jr-saikyo", "004135", "003700"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("rinkai", "004135", "004182"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("rinkai", "004182", "004135"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio", "003821", "003971"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio", "003971", "003821"),
    ).toBeNull();
    // The loop section needs its direction: 大崎→目黒 runs
    // outer-loop order (via 五反田), the short way round.
    expect(
      validateSectionEndpoints("yamanote", "004135", "004072"),
    ).toMatch(/needs a direction/);
    expect(
      validateSectionEndpoints("yamanote", "004135", "004072", "outer"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("yamanote", "004135", "004072", "inner"),
    ).toBeNull();
    // Ordered stations: block boundaries with the listed
    // mid-block stations interleaved in running order.
    expect(
      serviceOrderedStations("jr-chuo-rapid").map((s) => s.id),
    ).toEqual(["003766", "003677", "003700", "003606", "003634", "004029"]);
    expect(
      serviceOrderedStations("jr-saikyo").map((s) => s.id),
    ).toEqual(["004135", "003700", "003390", "003155", "002914", "002909"]);
    expect(
      serviceOrderedStations("rinkai").map((s) => s.id),
    ).toEqual(["003997", "004182", "004135"]);
    expect(
      serviceOrderedStations("keio").map((s) => s.id),
    ).toEqual(["003700", "003966", "003821", "003971", "003934"]);
  });

  test("validateSectionEndpoints: the 京王新線 sections register (subtask 1574)", () => {
    // The four stations of the new service: any pair registers,
    // either way round (non-loop). The 2026-11-25 ride 新宿→幡ヶ谷
    //付近 is NOT registered — its alighting station is unconfirmed
    // — but the master entry makes a future ride registerable.
    expect(
      validateSectionEndpoints("keio-new-line", "003700", "003764"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003764", "003700"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003764", "003791"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003791", "003764"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003791", "003806"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003806", "003791"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003700", "003806"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("keio-new-line", "003806", "003700"),
    ).toBeNull();
    // A station of the parent 京王線 that the 新線 never calls at
    // is not an endpoint here: 調布 is keio's block boundary, not
    // a 京王新線 station.
    expect(
      validateSectionEndpoints("keio-new-line", "003700", "003966"),
    ).toMatch(/not a station of/);
    // Ordered stations: boundaries with the listed mid-block
    // stations interleaved in running order.
    expect(
      serviceOrderedStations("keio-new-line").map((s) => s.id),
    ).toEqual(["003700", "003764", "003791", "003806"]);
  });

  test("validateSectionEndpoints: a single block may be ridden either way round a loop (review round 2, medium)", () => {
    // 新宿→渋谷 inner runs yamanote/b2 （渋谷〜新宿) end to
    // end — a real ride. The old block-direction check
    // rejected it because the endpoints match b2, whose own
    // direction is outer. The same endpoints outer are the
    // long way round the loop, which only shares the endpoints
    // with b2 — also a valid section, and the direction is
    // what tells them apart, not the block.
    expect(
      validateSectionEndpoints("yamanote", "003700", "003922", "inner"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("yamanote", "003700", "003922", "outer"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("yamanote", "003922", "003700", "inner"),
    ).toBeNull();
  });

  test("serviceOrderedStations interleaves block stations in running order", () => {
    expect(
      serviceOrderedStations("jr-musashino").map((s) => s.id),
    ).toEqual(["003876", "003771", "003004", "003187", "003547"]);
    expect(
      serviceOrderedStations("hokuso").map((s) => s.id),
    ).toEqual(["003248", "003187", "003083", "003125"]);
    // A loop closes on its first station, like the boundaries.
    // 目黒 sits between 大崎 and 渋谷 on b1 (subtask 1572).
    expect(
      serviceOrderedStations("yamanote").map((s) => s.id),
    ).toEqual([
      "004095",
      "004135",
      "004072",
      "003922",
      "003700",
      "003390",
      "003335",
      "003766",
      "004095",
    ]);
    expect(serviceOrderedStations("no-such-service")).toEqual([]);
  });

  test("validateSectionEndpoints: a loop needs a direction", () => {
    expect(validateSectionEndpoints("yamanote", "004095", "003922")).toMatch(
      /needs a direction/,
    );
    expect(
      validateSectionEndpoints("yamanote", "004095", "003922", "outer"),
    ).toBeNull();
    /* 品川→渋谷 inner is the long way round the loop — a valid
       section, not a wrong-direction block: the direction says
       which way round, and a single block can be ridden either
       way (review round 2, medium — the old check rejected it
       for matching b1's endpoints). The block-direction
       agreement now lives in the server's addRiddenSection,
       where the block the ride claims to be is known (see
       ridden-link.test.ts). */
    expect(
      validateSectionEndpoints("yamanote", "004095", "003922", "inner"),
    ).toBeNull();
    // A multi-block run round the loop still needs the direction.
    expect(
      validateSectionEndpoints("yamanote", "004095", "003335", "outer"),
    ).toBeNull();
  });

  test("the full-path snapshot keeps the path id and version", () => {
    const snapshot = serviceFullPathSnapshot("jr-saikyo")!;
    expect(snapshot.pathId).toBe("jr-saikyo");
    // A fresh snapshot is stamped with the CURRENT master
    // version (2026-11-26 since subtask 1590) — it equalled
    // MIGRATED_MASTER_VERSION only while the two coincided.
    expect(snapshot.masterVersion).toBe(SERVICE_MASTER_VERSION);
    expect(snapshot.segments.length).toBe(4);
    expect(snapshot.segments[0]!.formalLineKey).toBe(
      "山手線|東日本旅客鉄道",
    );
    // The freight section records both its stand-in shape and the
    // side of the loop it runs on (stage-1 review handoff).
    expect(snapshot.segments[0]!.approximate).toBe(true);
    expect(snapshot.segments[0]!.direction).toBe("outer");
    expect(serviceFullPathSnapshot("no-such-service")).toBeNull();
  });

  test("stationRefById resolves segment ends, block boundaries and migrated endpoints", () => {
    // A segment terminus (高尾 is only a segment end).
    expect(stationRefById("004029")?.name).toBe("高尾");
    // A block boundary that is no segment end （調布 is a 京王線
    // block boundary only).
    expect(stationRefById("003966")?.name).toBe("調布");
    // A migrated endpoint that is neither a segment end nor a
    // block boundary （国分寺 was only in the restored 中央線
    // section, 聖蹟桜ヶ丘 only in the 京王線 one, until subtask
    // 1572 listed both on blocks as well).
    expect(stationRefById("003606")?.name).toBe("国分寺");
    expect(stationRefById("003971")?.name).toBe("聖蹟桜ヶ丘");
    // A station listed on a block (stage 3, subtask 1455).
    expect(stationRefById("003187")?.name).toBe("東松戸");
    expect(stationRefById("003187")?.lng).toBeCloseTo(139.94311, 5);
    expect(stationRefById("003187")?.lat).toBeCloseTo(35.77013, 5);
    expect(stationRefById("003771")?.name).toBe("北府中");
    expect(stationRefById("003083")?.name).toBe("印西牧の原");
    // Coordinates ride along, so a resolved station can be
    // projected onto the line shape.
    const shinjuku = stationRefById("003700")!;
    expect(shinjuku.name).toBe("新宿");
    expect(shinjuku.lng).toBeCloseTo(139.69993, 5);
    expect(shinjuku.lat).toBeCloseTo(35.6898, 5);
    expect(stationRefById("999999")).toBeUndefined();
  });
});

describe("integrated review round 1: an explicit unlink is a confirmed answer", () => {
  test("resolveRiddenService neither resolves nor quarantines an explicitly unlinked row", () => {
    /* 「京王線」 would resolve by name; the human's confirmed
       unlink must win over the name rule, and it must not come
       back as 要確認 either — the question was answered. */
    expect(
      resolveRiddenService({
        name: "京王線",
        serviceId: null,
        serviceLinkSource: "explicit",
      }),
    ).toEqual({ service: undefined, needsReview: false });
  });

  test("isExplicitlyUnlinked tells the confirmed unlink from a plain missing link", () => {
    expect(
      isExplicitlyUnlinked({
        name: "京王線",
        serviceId: null,
        serviceLinkSource: "explicit",
      }),
    ).toBe(true);
    expect(isExplicitlyUnlinked({ name: "京王線", serviceId: null })).toBe(false);
    expect(
      isExplicitlyUnlinked({
        name: "京王線",
        serviceId: null,
        serviceLinkSource: "auto",
      }),
    ).toBe(false);
    /* An explicit LINK is not an unlink. */
    expect(
      isExplicitlyUnlinked({
        name: "京王線",
        serviceId: "keio",
        serviceLinkSource: "explicit",
      }),
    ).toBe(false);
  });

  test("serviceStationIds covers segment ends, block boundaries, listed block stations and migrated endpoints", () => {
    const keio = serviceStationIds("keio");
    expect(keio.has("003700")).toBe(true); // 新宿, a segment end
    expect(keio.has("003966")).toBe(true); // 調布, a block boundary only
    expect(keio.has("003971")).toBe(true); // 聖蹟桜ヶ丘, a migrated endpoint (listed on keio/b3 since subtask 1572)
    expect(keio.has("003606")).toBe(false); // 国分寺 belongs to 中央線
    const chuo = serviceStationIds("jr-chuo-rapid");
    expect(chuo.has("003606")).toBe(true);
    expect(chuo.has("003634")).toBe(true); // 立川
    /* Listed block stations (stage 3, subtask 1455) belong to
       their service; a migrated endpoint of another service
       still does not. */
    const musashino = serviceStationIds("jr-musashino");
    expect(musashino.has("003187")).toBe(true); // 東松戸
    expect(musashino.has("003771")).toBe(true); // 北府中
    expect(musashino.has("003083")).toBe(false); // 印西牧の原 is 北総線's
    const hokuso = serviceStationIds("hokuso");
    expect(hokuso.has("003187")).toBe(true); // 東松戸, shared with 武蔵野線
    expect(hokuso.has("003083")).toBe(true); // 印西牧の原
    expect(serviceStationIds("no-such-service").size).toBe(0);
    /* Every migrated ride's endpoints are in its own service's
       set — the fit checks on both sides rely on it. */
    for (const ride of Object.values(MIGRATED_RIDES)) {
      if (!ride.from || !ride.to) continue;
      const stations = serviceStationIds(ride.serviceId);
      expect(stations.has(ride.from.id)).toBe(true);
      expect(stations.has(ride.to.id)).toBe(true);
    }
  });
});

describe("integrated review round 2: the fit yardsticks", () => {
  test("sectionEndpointsKnownToService counts a restored mid-segment station as known", () => {
    /* 京王線's 府中→聖蹟桜ヶ丘： 聖蹟桜ヶ丘 is no block boundary
       (the boundary-only hint wrongly refused this section),
       but the migration restored it, so the server's yardstick
       — known stations — accepts it, and the hint now uses the
       same one. */
    expect(
      serviceBoundaryStations("keio").some((s) => s.id === "003971"),
    ).toBe(false);
    expect(sectionEndpointsKnownToService("keio", "003821", "003971")).toBe(
      true,
    );
    /* A station of another service is still foreign. */
    expect(sectionEndpointsKnownToService("keio", "003821", "003634")).toBe(
      false,
    );
  });

  test("a section between listed mid-block stations fits its service (subtask 1455)", () => {
    /* The three estimated sections, as addRiddenSection would
       store them (recorded under their own service, no block —
       none of the three is exactly one block). */
    expect(
      recordedSectionFitsService("jr-musashino", {
        fromStationId: "003187",
        toStationId: "003771",
        direction: null,
        blockId: null,
        recordedServiceId: "jr-musashino",
      }),
    ).toBe(true);
    expect(
      recordedSectionFitsService("hokuso", {
        fromStationId: "003187",
        toStationId: "003083",
        direction: null,
        blockId: null,
        recordedServiceId: "hokuso",
      }),
    ).toBe(true);
    expect(
      recordedSectionFitsService("yamanote", {
        fromStationId: "003700",
        toStationId: "004135",
        direction: "inner",
        blockId: null,
        recordedServiceId: "yamanote",
      }),
    ).toBe(true);
    /* The same pair under the wrong service still does not fit. */
    expect(
      recordedSectionFitsService("hokuso", {
        fromStationId: "003187",
        toStationId: "003771",
        direction: null,
        blockId: null,
        recordedServiceId: "hokuso",
      }),
    ).toBe(false);
  });

  test("a primary section whose pair runs on another service over a different route is ambiguous", () => {
    /* 東京→新宿 is 中央線（快速）'s first block — and also a
       山手線 pair, over 山手線・東北線・東海道線. The endpoints
       alone cannot say which route was ridden, from either
       side. */
    expect(sectionRouteAmbiguous("jr-chuo-rapid", "003766", "003700")).toBe(true);
    expect(sectionRouteAmbiguous("yamanote", "003766", "003700")).toBe(true);
  });

  test("pairs no other service serves, or that share the one formal line, are not ambiguous", () => {
    /* 国分寺 is 中央線's alone. */
    expect(sectionRouteAmbiguous("jr-chuo-rapid", "003766", "003606")).toBe(false);
    /* 総武快速線・総武本線 share their pairs over the one
       formal line 総武線 — the same route, not a rival one. */
    expect(sectionRouteAmbiguous("jr-sobu-rapid", "003766", "004173")).toBe(false);
    expect(sectionRouteAmbiguous("jr-sobu-local", "003531", "004173")).toBe(false);
    /* 京王線's restored section: no other service serves
       聖蹟桜ヶ丘 at all. */
    expect(sectionRouteAmbiguous("keio", "003821", "003971")).toBe(false);
  });

  test("a loop direction selects an arc but cannot rule out a different service's route", () => {
    // No other known service serves both 渋谷 and 東京.
    expect(sectionRouteAmbiguous("yamanote", "003922", "003766")).toBe(true);
    expect(sectionRouteAmbiguous("yamanote", "003922", "003766", "inner")).toBe(false);
    expect(sectionRouteAmbiguous("yamanote", "003922", "003766", "outer")).toBe(false);
    // 中央線（快速） is a separate route even when the loop arc is known.
    expect(sectionRouteAmbiguous("yamanote", "003766", "003700", "inner")).toBe(true);
    expect(sectionRouteAmbiguous("yamanote", "003766", "003700", "outer")).toBe(true);
  });

  test("endpoints alone cannot identify the restored loop and shared sections", () => {
    // 大崎→目黒 on 山手線 has two arcs without a recorded direction.
    expect(sectionRouteAmbiguous("yamanote", "004135", "004072")).toBe(true);
    // 新宿 and 大崎 are known to both services, but one endpoint
    // sits mid-block on each chain.
    expect(sectionRouteAmbiguous("jr-saikyo", "003700", "004135")).toBe(true);
  });
});
