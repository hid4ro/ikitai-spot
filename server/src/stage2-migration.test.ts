/* Regression tests for the stage-2 migration (subtask 1421).
   The migration SQL is verified by APPLYING it to a scratch
   database (the review round 1, finding 6 rule: never verify SQL
   by parsing its text) — 0011 first, then 0012 on top, so the
   column and the sections table land on the real post-0011
   shape. Run with: bun test server/src/stage2-migration.test.ts */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

async function migratedDb(): Promise<Database> {
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
  const sql11 = await Bun.file(
    new URL(
      "../../drizzle/0011_ridden_lines_service_master.sql",
      import.meta.url,
    ),
  ).text();
  db.exec(sql11);
  const sql12 = await Bun.file(
    new URL(
      "../../drizzle/0012_ridden_lines_stage2.sql",
      import.meta.url,
    ),
  ).text();
  db.exec(sql12);
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
