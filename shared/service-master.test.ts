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
    const toRide = (row: Row): RestoredRide => ({
      serviceId: row.service_id!,
      rideState: row.ride_state as RestoredRide["rideState"],
      from:
        row.from_station_id && row.from_station_name
          ? { id: row.from_station_id, name: row.from_station_name }
          : null,
      to:
        row.to_station_id && row.to_station_name
          ? { id: row.to_station_id, name: row.to_station_name }
          : null,
      masterVersion: row.master_version!,
    });
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
