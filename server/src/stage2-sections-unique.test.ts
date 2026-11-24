/* Regression tests for the stage-2 sections unique index
   (subtask 1433, review round 1, H-3): the same section added
   twice at once could insert duplicate ridden_line_sections rows
   — the handler's check-then-insert has no constraint behind it.
   Migration 0014 adds the index (and drops exact duplicates
   first, so it builds on live data). The migration SQL is
   verified by APPLYING it to a scratch database (the review round
   1, finding 6 rule: never verify SQL by parsing its text) —
   0011, 0012 and 0013 first, so the sections table lands on the
   real post-0013 shape. Run with:
   bun test server/src/stage2-sections-unique.test.ts */
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
  for (const file of [
    "0011_ridden_lines_service_master.sql",
    "0012_ridden_lines_stage2.sql",
    "0013_ridden_line_link_provenance.sql",
  ]) {
    const sql = await Bun.file(
      new URL(`../../drizzle/${file}`, import.meta.url),
    ).text();
    db.exec(sql);
  }
  return db;
}

async function apply0014(db: Database): Promise<void> {
  const sql = await Bun.file(
    new URL(
      "../../drizzle/0014_ridden_line_sections_unique.sql",
      import.meta.url,
    ),
  ).text();
  db.exec(sql);
}

function insertSection(
  db: Database,
  riddenLineId: number,
  fromStationId: string,
  toStationId: string,
  direction: string | null,
): void {
  db.exec(
    `INSERT INTO ridden_line_sections
       (ridden_line_id, from_station_id, to_station_id, direction, created_at)
     VALUES (${riddenLineId}, '${fromStationId}', '${toStationId}',
       ${direction === null ? "NULL" : `'${direction}'`}, 0)`,
  );
}

function countSections(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM ridden_line_sections").get() as {
      n: number;
    }
  ).n;
}

describe("migration 0014 (stage 2 sections unique index)", () => {
  test("drops exact duplicates before adding the index", async () => {
    const db = await migratedDb();
    insertSection(db, 1, "003766", "004173", null);
    insertSection(db, 1, "003766", "004173", null);
    insertSection(db, 1, "003766", "004173", "inner");
    expect(countSections(db)).toBe(3);
    await apply0014(db);
    // The null-direction pair collapses to one row; the inner
    // section is a different section and stays.
    expect(countSections(db)).toBe(2);
    const index = db
      .query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'ridden_line_sections_unique_section'",
      )
      .get() as { name: string; sql: string };
    expect(index.name).toBe("ridden_line_sections_unique_section");
    expect(index.sql).toContain("COALESCE(direction, '')");
    db.close();
  });

  test("rejects a second identical section", async () => {
    const db = await migratedDb();
    await apply0014(db);
    insertSection(db, 1, "003766", "004173", null);
    expect(() =>
      insertSection(db, 1, "003766", "004173", null),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });

  test("allows the same stations with a different direction or on another row", async () => {
    const db = await migratedDb();
    await apply0014(db);
    insertSection(db, 1, "003766", "004173", null);
    insertSection(db, 1, "003766", "004173", "inner");
    insertSection(db, 1, "003766", "004173", "outer");
    insertSection(db, 2, "003766", "004173", null);
    expect(countSections(db)).toBe(4);
    db.close();
  });
});
