/* Regression tests for the stage-2 migration (subtask 1421).
   The migration SQL is verified by APPLYING it to a scratch
   database (the review round 1, finding 6 rule: never verify SQL
   by parsing its text) — 0011 first, then 0012 on top, so the
   column and the sections table land on the real post-0011
   shape. Run with: bun test server/src/stage2-migration.test.ts */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RIDDEN_LINE_GEOMETRIES } from "../../client/src/assets/visited-lines";
import { computeRiddenLineCoverage } from "../../client/src/line-geometry";

async function applyMigration(db: Database, name: string): Promise<void> {
  db.exec(await Bun.file(new URL(`../../drizzle/${name}.sql`, import.meta.url)).text());
}

async function migratedDb(seedBeforeStage1?: (db: Database) => void): Promise<Database> {
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
  seedBeforeStage1?.(db);
  await applyMigration(db, "0011_ridden_lines_service_master");
  await applyMigration(db, "0012_ridden_lines_stage2");
  return db;
}

describe("migration 0012 (stage 2)", () => {
  test("adds path_snapshot to ridden_lines", async () => {
    const db = await migratedDb();
    const columns = db
      .query("PRAGMA table_info(ridden_lines)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("path_snapshot");
    // Existing rows keep their 0011 values; the new column is null.
    db.exec(
      "INSERT INTO ridden_lines (name, first_ridden_on, created_at) VALUES ('京王線', '2026-11-22', 0)",
    );
    const row = db
      .query("SELECT path_snapshot FROM ridden_lines WHERE name = '京王線'")
      .get() as { path_snapshot: string | null };
    expect(row.path_snapshot).toBeNull();
    db.close();
  });

  test("creates ridden_line_sections and round-trips a section", async () => {
    const db = await migratedDb();
    const columns = db
      .query("PRAGMA table_info(ridden_line_sections)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "ridden_line_id",
      "from_station_id",
      "from_station_name",
      "to_station_id",
      "to_station_name",
      "direction",
      "block_id",
      "created_at",
    ]);
    db.exec(
      "INSERT INTO ridden_lines (name, first_ridden_on, created_at) VALUES ('京王線', '2026-11-22', 0)",
    );
    const line = db
      .query("SELECT id FROM ridden_lines WHERE name = '京王線'")
      .get() as { id: number };
    db.query(
      "INSERT INTO ridden_line_sections (ridden_line_id, from_station_id, from_station_name, to_station_id, to_station_name, direction, block_id, created_at) VALUES (?, '003966', '調布', '003821', '府中', NULL, 'keio/b2', 0)",
    ).run(line.id);
    const section = db
      .query(
        "SELECT from_station_id, to_station_id, block_id FROM ridden_line_sections WHERE ridden_line_id = ?",
      )
      .get(line.id) as {
      from_station_id: string;
      to_station_id: string;
      block_id: string;
    };
    expect(section).toEqual({
      from_station_id: "003966",
      to_station_id: "003821",
      block_id: "keio/b2",
    });
    db.close();
  });

  test("a full ride's path snapshot round-trips as JSON", async () => {
    const db = await migratedDb();
    const snapshot = JSON.stringify({
      pathId: "keio",
      masterVersion: "2026-11-24",
      segments: [
        {
          formalLineKey: "京王線|京王電鉄",
          from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
          to: {
            id: "003934",
            name: "京王八王子",
            lng: 139.34298,
            lat: 35.65805,
          },
        },
      ],
    });
    db.query(
      "INSERT INTO ridden_lines (name, first_ridden_on, created_at, ride_state, service_id, master_version, path_snapshot) VALUES ('京王線', '2026-11-22', 0, 'full', 'keio', '2026-11-24', ?)",
    ).run(snapshot);
    const row = db
      .query("SELECT path_snapshot FROM ridden_lines WHERE name = '京王線'")
      .get() as { path_snapshot: string };
    const parsed = JSON.parse(row.path_snapshot) as {
      pathId: string;
      masterVersion: string;
    };
    expect(parsed.pathId).toBe("keio");
    expect(parsed.masterVersion).toBe("2026-11-24");
    db.close();
  });
});

describe("migration 0015 (recorded service)", () => {
  test("restores all seven known partial rides without changing their distance", async () => {
    const restoredRides = [
      ["JR中央線（快速）", "2026-11-15", "jr-chuo-rapid", 30.21],
      ["JR総武快速線", "2026-11-15", "jr-sobu-rapid", 38.98],
      /* JR総武本線 is 15.58, not 15.66: one endpoint of the
         佐倉→千葉 ride sits on a reversed leg, and the corrected
         arc math (subtask 1729) moves it to its true traversal
         position, 0.08 km earlier along the path. */
      ["JR総武本線", "2026-11-16", "jr-sobu-local", 15.58],
      /* 京王線 is 4.42, not 4.40: 聖蹟桜ヶ丘 sits on a reversed
         leg (edge:60, leg51), 0.38 m from the track, and the
         corrected arc math (subtask 1729) moves it 0.016 km to
         its true traversal position. */
      ["京王線", "2026-11-22", "keio", 4.42],
      ["JR埼京線", "2026-11-24", "jr-saikyo", 8.58],
      ["りんかい線", "2026-11-24", "rinkai", 3.31],
      ["山手線", "2026-11-24", "yamanote", 1.85],
    ] as const;
    using db = await migratedDb((db) => {
      const insert = db.query(
        "INSERT INTO ridden_lines (name, first_ridden_on, created_at) VALUES (?, ?, 0)",
      );
      for (const [name, date] of restoredRides) insert.run(name, date);
    });
    await applyMigration(db, "0013_ridden_line_link_provenance");
    await applyMigration(db, "0014_ridden_line_sections_unique");
    // Restoring the recorded identity requires the frozen 0011 tuple even for
    // rows that were confirmed before the new column existed.
    db.exec("UPDATE ridden_lines SET service_link_source = 'explicit'");
    await applyMigration(db, "0015_ridden_recorded_service");
    const rows = db.query(`
      SELECT name, service_id AS serviceId, recorded_service_id AS recordedServiceId,
             service_link_source AS serviceLinkSource, ride_state AS rideState,
             from_station_id AS fromStationId, to_station_id AS toStationId,
             path_snapshot AS pathSnapshot
      FROM ridden_lines
      ORDER BY id
    `).all() as Parameters<typeof computeRiddenLineCoverage>[0];
    expect(rows.map((row) => row.recordedServiceId)).toEqual(
      restoredRides.map(([, , serviceId]) => serviceId),
    );
    const coverage = computeRiddenLineCoverage(rows, RIDDEN_LINE_GEOMETRIES, 597);
    for (const [, , serviceId, distance] of restoredRides) {
      expect(coverage.perService.get(serviceId)?.riddenKm).toBeCloseTo(distance, 2);
    }
  });

  test("keeps original links and leaves unproven explicit links out of the backfill", async () => {
    using db = await migratedDb((db) => {
      db.exec(`INSERT INTO ridden_lines (id, name, first_ridden_on, created_at)
        VALUES (1, 'JR中央線（快速）', '2026-11-15', 0),
               (2, '京王線', '2026-11-22', 0)`);
    });
    await applyMigration(db, "0013_ridden_line_link_provenance");
    await applyMigration(db, "0014_ridden_line_sections_unique");
    db.exec(`
      UPDATE ridden_lines SET service_id = 'yamanote', service_link_source = 'explicit' WHERE id = 1;
      UPDATE ridden_lines SET service_id = NULL, service_link_source = 'explicit' WHERE id = 2;
      INSERT INTO ridden_lines
        (id, name, first_ridden_on, service_id, service_link_source, ride_state,
         from_station_id, to_station_id, master_version, created_at)
      VALUES
        (3, '中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', NULL,
         'partial', '003766', '003700', '2026-11-24', 0),
        (4, 'JR中央線（快速）', '2026-11-15', 'yamanote', 'explicit',
         'partial', '003766', '003700', '2026-11-24', 0),
        (5, '京王線', '2026-11-24', 'keio', 'auto',
         'full', NULL, NULL, '2026-11-24', 0);
      INSERT INTO ridden_line_sections (ridden_line_id, from_station_id, to_station_id, block_id, created_at)
      VALUES (1, '003766', '003700', NULL, 0),
             (3, '003766', '003700', NULL, 0),
             (3, '003700', '003634', 'jr-chuo-rapid/b2', 0);
    `);
    await applyMigration(db, "0015_ridden_recorded_service");
    const rows = db.query<{ serviceId: string | null; recordedServiceId: string | null }, []>(`
      SELECT service_id AS serviceId, recorded_service_id AS recordedServiceId
      FROM ridden_lines ORDER BY id
    `).all();
    expect(rows).toEqual([
      { serviceId: "yamanote", recordedServiceId: "jr-chuo-rapid" },
      { serviceId: null, recordedServiceId: "keio" },
      { serviceId: "jr-chuo-rapid", recordedServiceId: "jr-chuo-rapid" },
      { serviceId: "yamanote", recordedServiceId: null },
      { serviceId: "keio", recordedServiceId: "keio" },
    ]);
    const sections = db.query<{ blockId: string | null; recordedServiceId: string | null }, []>(`
      SELECT block_id AS blockId, recorded_service_id AS recordedServiceId
      FROM ridden_line_sections ORDER BY id
    `).all();
    expect(sections).toEqual([
      { blockId: null, recordedServiceId: null },
      { blockId: null, recordedServiceId: "jr-chuo-rapid" },
      { blockId: "jr-chuo-rapid/b2", recordedServiceId: null },
    ]);
  });
});
