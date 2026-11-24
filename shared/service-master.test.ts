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
  isKnownMasterVersion,
  isN02StationId,
  isRiddenServiceLinkReviewable,
  legacyServiceByLedgerName,
  resolveRiddenService,
  serviceById,
  serviceByLedgerName,
  serviceFullPathSnapshot,
  stationRefById,
  validateSectionEndpoints,
  type RestoredRide,
  type StationRef,
} from "./service-master";
import { RIDDEN_LINE_GEOMETRIES } from "../client/src/assets/visited-lines";

describe("master shape", () => {
  test("every entry carries the four required metadata fields", () => {
    expect(SERVICE_MASTER.length).toBe(9);
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
    expect(formalLineNames("rinkai")).toEqual(["臨海副都心線"]);
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
        ...entry.blocks.flatMap((b) => [b.from, b.to]),
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

  test("validateSectionEndpoints: mid-block stations and reversed order fail", () => {
    // 国分寺 is a real station on 中央線 but not a block boundary.
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003606", "004029"),
    ).toMatch(/not a boundary station/);
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "004029", "003766"),
    ).toMatch(/running order/);
    expect(
      validateSectionEndpoints("jr-chuo-rapid", "003766", "003766"),
    ).toMatch(/two different stations/);
    expect(validateSectionEndpoints("no-such-service", "003766", "003700")).toMatch(
      /unknown service/,
    );
  });

  test("validateSectionEndpoints: a loop needs a direction", () => {
    expect(validateSectionEndpoints("yamanote", "004095", "003922")).toMatch(
      /needs a direction/,
    );
    expect(
      validateSectionEndpoints("yamanote", "004095", "003922", "outer"),
    ).toBeNull();
    expect(
      validateSectionEndpoints("yamanote", "004095", "003922", "inner"),
    ).toMatch(/runs outer, not inner/);
    // A multi-block run round the loop still needs the direction.
    expect(
      validateSectionEndpoints("yamanote", "004095", "003335", "outer"),
    ).toBeNull();
  });

  test("the full-path snapshot keeps the path id and version", () => {
    const snapshot = serviceFullPathSnapshot("jr-saikyo")!;
    expect(snapshot.pathId).toBe("jr-saikyo");
    expect(snapshot.masterVersion).toBe(MIGRATED_MASTER_VERSION);
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
    // A migrated endpoint that is neither （国分寺 is only in the
    // restored 中央線 section; 聖蹟桜ヶ丘 only in the 京王線 one).
    expect(stationRefById("003606")?.name).toBe("国分寺");
    expect(stationRefById("003971")?.name).toBe("聖蹟桜ヶ丘");
    // Coordinates ride along, so a resolved station can be
    // projected onto the line shape.
    const shinjuku = stationRefById("003700")!;
    expect(shinjuku.name).toBe("新宿");
    expect(shinjuku.lng).toBeCloseTo(139.69993, 5);
    expect(shinjuku.lat).toBeCloseTo(35.6898, 5);
    expect(stationRefById("999999")).toBeUndefined();
  });
});
