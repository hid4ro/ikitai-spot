/* Regression tests for the service master （系統マスタ）.
   Run with: bun test shared/service-master.test.ts
   The master is hand-recorded, so these tests pin its contents:
   every service's expansion, every migrated ride's restored section,
   and the invariants the meeting agreed on (all draft, station
   segments chain, no guessed sections). */
import { describe, expect, test } from "bun:test";
import {
  MIGRATED_RIDES,
  SERVICE_MASTER,
  SERVICE_MASTER_VERSION,
  assetKeysForService,
  expandService,
  formalLineNames,
  serviceById,
  serviceByLedgerName,
  type RestoredRide,
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
    expect(formalLineNames("yamanote")).toEqual(["山手線"]);
  });

  test("りんかい線 resolves to its official name 臨海副都心線", () => {
    expect(assetKeysForService("rinkai")).toEqual([
      "臨海副都心線|東京臨海高速鉄道",
    ]);
  });

  test("山手線 is a loop: its segment starts and ends at 品川", () => {
    const [segment] = expandService("yamanote");
    expect(segment!.from.id).toBe(segment!.to.id);
    expect(segment!.from.name).toBe("品川");
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
    for (const ride of Object.values(MIGRATED_RIDES)) {
      expect(ride.masterVersion).toBe(SERVICE_MASTER_VERSION);
    }
  });

  test("the SQL migration backfills exactly these rides", async () => {
    // drizzle/0011_ridden_lines_service_master.sql is the other copy
    // of this table (SQL cannot import it); the two must agree, or
    // the live ledger and the app disagree about a ride.
    const sql = await Bun.file(
      new URL(
        "../drizzle/0011_ridden_lines_service_master.sql",
        import.meta.url,
      ),
    ).text();
    const updateRe =
      /UPDATE `ridden_lines` SET `service_id` = '([^']+)'(?:, `ride_state` = '([^']+)', `from_station_id` = '([^']+)', `from_station_name` = '([^']+)', `to_station_id` = '([^']+)', `to_station_name` = '([^']+)')?, `master_version` = '([^']+)' WHERE `name` = '([^']+)';/g;
    const fromSql = new Map<string, RestoredRide>();
    for (const m of sql.matchAll(updateRe)) {
      const [, serviceId, rideState, fromId, fromName, toId, toName, version, name] =
        m;
      fromSql.set(name!, {
        serviceId: serviceId!,
        rideState: (rideState ?? "unknown") as RestoredRide["rideState"],
        from:
          fromId && fromName ? { id: fromId, name: fromName } : null,
        to: toId && toName ? { id: toId, name: toName } : null,
        masterVersion: version!,
      });
    }
    expect([...fromSql.keys()].sort()).toEqual(
      Object.keys(MIGRATED_RIDES).sort(),
    );
    for (const [name, ride] of Object.entries(MIGRATED_RIDES)) {
      expect(fromSql.get(name)).toEqual(ride);
    }
  });
});
