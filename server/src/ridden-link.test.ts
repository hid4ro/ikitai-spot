import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { readdir } from "node:fs/promises";
import { RIDDEN_LINE_GEOMETRIES } from "../../client/src/assets/visited-lines";
import {
  computeRiddenLineCoverage,
  type LineGeometryMap,
} from "../../client/src/line-geometry";
import { serviceFullPathSnapshot } from "../../shared/service-master";
import { Actions, isUniqueConstraintError } from "./actions";
import * as schema from "./schema";

const aRide = { firstRiddenOn: "2026-11-24" };
const GEOMETRIES = RIDDEN_LINE_GEOMETRIES as unknown as LineGeometryMap;
type ActionContext = Parameters<typeof Actions.addRiddenLine.handler>[0];
type TestDatabase = ReturnType<typeof createClient>;

async function withLedger(
  verify: (client: TestDatabase, ctx: ActionContext) => Promise<void>,
  seedBeforeStage2?: (client: TestDatabase) => Promise<unknown>,
  seedBeforeRecordedService?: (client: TestDatabase) => Promise<unknown>,
) {
  const directory = new URL("../../drizzle/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = createClient({ url: ":memory:" });
  try {
    for (const file of migrations) {
      if (file.startsWith("0012_")) await seedBeforeStage2?.(client);
      if (file.startsWith("0015_")) await seedBeforeRecordedService?.(client);
      await client.executeMultiple(await Bun.file(new URL(file, directory)).text());
    }
    const db = drizzle(client, { schema });
    const ctx = { db: () => db, invalidateQueries() {} } as unknown as ActionContext;
    await verify(client, ctx);
  } finally {
    client.close();
  }
}

test("new registrations, imports and link backfills record their provenance", async () => {
  await withLedger(async (client, ctx) => {
    await client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, master_version, created_at)
      VALUES ('武蔵野線', '2026-11-23', 'original-master', 0)`);
    await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "京王線",
      serviceId: "keio",
    });
    await Actions.addRiddenLine.handler(ctx, { ...aRide, name: "山手線" });
    await Actions.importRiddenLines.handler(ctx, {
      entries: [
        { ...aRide, name: "臨海副都心線" },
        { ...aRide, name: "武蔵野線" },
        { ...aRide, name: "武蔵野線 (京王電鉄)" },
      ],
    });
    const rows = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get("京王線")).toMatchObject({
      serviceId: "keio",
      serviceLinkSource: "explicit",
      serviceMatchVersion: null,
    });
    for (const [name, serviceId] of [
      ["山手線", "yamanote"],
      ["臨海副都心線", "rinkai"],
      ["武蔵野線", "jr-musashino"],
      ["武蔵野線 (京王電鉄)", null],
    ] as const) {
      expect(byName.get(name)).toMatchObject({
        serviceId,
        serviceLinkSource: "auto",
        serviceMatchVersion: "3",
      });
    }
    expect(byName.get("武蔵野線")?.masterVersion).toBe("original-master");
  });
});

test("an explicit ID cannot attach a new row to a service contradicted by its name", async () => {
  await withLedger(async (_, ctx) => {
    await expect(
      Actions.addRiddenLine.handler(ctx, {
        ...aRide,
        name: "武蔵野線 (京王電鉄)",
        serviceId: "jr-musashino",
      }),
    ).rejects.toThrow(/serviceId.*match/);
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines).toEqual([]);
  });
});

test("re-registration and re-import keep ambiguous old links and their record version", async () => {
  await withLedger(async (_, ctx) => {
    const before = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    for (const row of before) {
      expect(row.serviceLinkSource).toBeNull();
      expect(row.serviceMatchVersion).toBeNull();
      expect(
        await Actions.addRiddenLine.handler(ctx, { ...aRide, name: row.name }),
      ).toEqual({ created: false, id: row.id });
    }
    expect(await Actions.importRiddenLines.handler(ctx, {
      entries: before.map((row) => ({ ...aRide, name: row.name })),
    })).toEqual({ inserted: 0, skipped: 2 });
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines).toEqual(before);
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', 'historical-master', 0),
           ('武蔵野線 (京王電鉄)', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("a quarantined partial row retains its primary section and rejects section additions", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    expect(before).toMatchObject({
      serviceId: "jr-chuo-rapid",
      rideState: "partial",
      fromStationId: "003700",
      toStationId: "003634",
      masterVersion: "historical-master",
    });
    await expect(
      Actions.addRiddenSection.handler(ctx, {
        riddenLineId: before.id,
        fromStationId: "003634",
        toStationId: "004029",
        blockId: "jr-chuo-rapid/b3",
      }),
    ).rejects.toThrow(/needs confirmation/);
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines).toEqual([before]);
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, ride_state, from_station_id, to_station_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', 'partial', '003700', '003634', 'historical-master', 0)`));
});

test("confirming a quarantined link records it explicit and lifts the quarantine", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-chuo-rapid",
      }),
    ).toEqual({ ok: true, serviceId: "jr-chuo-rapid" });
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after).toMatchObject({
      serviceId: "jr-chuo-rapid",
      serviceLinkSource: "explicit",
      serviceMatchVersion: null,
      // The ride itself is untouched: only the link columns change.
      rideState: "partial",
      fromStationId: "003700",
      toStationId: "003634",
      masterVersion: "historical-master",
    });
    // The row now resolves, so section additions work again.
    const added = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: before.id,
      fromStationId: "003634",
      toStationId: "004029",
      blockId: "jr-chuo-rapid/b3",
    });
    expect(added.created).toBe(true);
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, ride_state, from_station_id, to_station_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', 'partial', '003700', '003634', 'historical-master', 0)`));
});

test("confirmation can relink to a different service", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    // The name contradicts the saved link, so the human's choice —
    // not the name rule — decides: relink to the Keio service.
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "keio",
      }),
    ).toEqual({ ok: true, serviceId: "keio" });
    const [relinked] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(relinked).toMatchObject({
      serviceId: "keio",
      serviceLinkSource: "explicit",
      serviceMatchVersion: null,
      rideState: "unknown",
    });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('武蔵野線 (京王電鉄)', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("confirmation can unlink, and an unlink can be undone by confirming again", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    // Unlinking is a valid confirmation outcome ("no service fits").
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: null,
      }),
    ).toEqual({ ok: true, serviceId: null });
    const [unlinked] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(unlinked).toMatchObject({
      serviceId: null,
      serviceLinkSource: "explicit",
      serviceMatchVersion: null,
    });
    // An explicit unlink stays reviewable, so it can be undone.
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "keio",
      }),
    ).toEqual({ ok: true, serviceId: "keio" });
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines[0]).toMatchObject({
      serviceId: "keio",
      serviceLinkSource: "explicit",
    });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('武蔵野線 (京王電鉄)', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("confirmation rejects rows that do not need it, unknown services, and unknown rows", async () => {
  await withLedger(async (_, ctx) => {
    await Actions.addRiddenLine.handler(ctx, { ...aRide, name: "京王線" });
    const rows = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    const clean = rows.find((row) => row.name === "京王線");
    const quarantined = rows.find((row) => row.name === "武蔵野線 (京王電鉄)");
    if (!clean || !quarantined) throw new Error("Missing ledger rows");
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: clean.id,
        serviceId: "keio",
      }),
    ).rejects.toThrow(/does not need/);
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: quarantined.id,
        serviceId: "does-not-exist",
      }),
    ).rejects.toThrow(/unknown service/);
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: 9999,
        serviceId: "keio",
      }),
    ).rejects.toThrow(/unknown ridden line/);
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines).toEqual(rows);
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('武蔵野線 (京王電鉄)', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("confirming a link the recorded full ride does not fit is refused (integrated review round 1, high)", async () => {
  await withLedger(async (client, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    /* The row's record is a FULL ride on 中央線快速: its stored
       path snapshot is that service's path. Relinking the row
       must not hand 京王線 a completion built from 中央線's
       shape and kilometres. */
    await client.execute({
      sql: "UPDATE ridden_lines SET ride_state = 'full', path_snapshot = ? WHERE id = ?",
      args: [
        JSON.stringify(serviceFullPathSnapshot("jr-chuo-rapid")),
        before.id,
      ],
    });
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "keio",
      }),
    ).rejects.toThrow(/cannot be linked/);
    /* The refusal leaves the stored link exactly as it was. */
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after).toMatchObject({
      serviceId: "jr-musashino",
      rideState: "full",
    });
    /* Confirming the service the ride was recorded on fits. */
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-chuo-rapid",
      }),
    ).toEqual({ ok: true, serviceId: "jr-chuo-rapid" });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('武蔵野線 (京王電鉄)', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("confirming a partial ride onto a service that does not serve its endpoints is refused", async () => {
  await withLedger(async (client, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    /* Primary section 新宿→立川 (both 中央線 stations), saved
       link 京王線. 山手線 serves neither endpoint. */
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "yamanote",
      }),
    ).rejects.toThrow(/cannot be linked/);
    /* An additional section counts too: this one ends at 調布,
       which 中央線 does not serve, so even the fitting service
       is refused while the foreign section is on the record. */
    await client.execute(
      `INSERT INTO ridden_line_sections
         (ridden_line_id, from_station_id, to_station_id, from_station_name, to_station_name, created_at)
       VALUES (${before.id}, '003700', '003966', '新宿', '調布', 0)`,
    );
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-chuo-rapid",
      }),
    ).rejects.toThrow(/cannot be linked/);
    /* With the foreign section gone, the relink fits and lands. */
    await client.execute(
      `DELETE FROM ridden_line_sections WHERE ridden_line_id = ${before.id}`,
    );
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-chuo-rapid",
      }),
    ).toEqual({ ok: true, serviceId: "jr-chuo-rapid" });
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after).toMatchObject({
      serviceId: "jr-chuo-rapid",
      serviceLinkSource: "explicit",
      rideState: "partial",
      fromStationId: "003700",
      toStationId: "003634",
    });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, ride_state, from_station_id, to_station_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'keio', 'partial', '003700', '003634', 'historical-master', 0)`));
});

test("an explicit unlink survives re-registration and re-import (integrated review round 1, medium)", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    /* The row's name resolves to 京王線 by the name rule; the
       human confirms "no service" instead. */
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: null,
      }),
    ).toEqual({ ok: true, serviceId: null });
    /* Re-registering the name must not silently restore the
       link the human removed... */
    expect(
      await Actions.addRiddenLine.handler(ctx, { ...aRide, name: "京王線" }),
    ).toEqual({ created: false, id: before.id });
    /* ...and neither must re-importing it. */
    await Actions.importRiddenLines.handler(ctx, {
      entries: [{ ...aRide, name: "京王線" }],
    });
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after).toMatchObject({
      serviceId: null,
      serviceLinkSource: "explicit",
      serviceMatchVersion: null,
    });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, master_version, created_at)
    VALUES ('京王線', '2026-11-23', 'jr-musashino', 'historical-master', 0)`));
});

test("isUniqueConstraintError sees through Drizzle's error wrapping (integrated review round 1, H-3)", () => {
  /* The raw SQLite error, as the old message check expected. */
  expect(
    isUniqueConstraintError(
      new Error("UNIQUE constraint failed: ridden_line_sections.ridden_line_id"),
    ),
  ).toBe(true);
  /* Drizzle wraps driver errors: the constraint text lives on
     the cause, not on the outer "Failed query" message — the
     shape the parallel-registration race actually produces. */
  const wrapped = new Error("Failed query: insert into `ridden_line_sections` ...", {
    cause: new Error("UNIQUE constraint failed: ridden_line_sections.ridden_line_id"),
  });
  expect(isUniqueConstraintError(wrapped)).toBe(true);
  const deep = new Error("outer", {
    cause: new Error("middle", {
      cause: new Error("UNIQUE constraint failed: x"),
    }),
  });
  expect(isUniqueConstraintError(deep)).toBe(true);
  expect(isUniqueConstraintError(new Error("some other failure"))).toBe(false);
  expect(isUniqueConstraintError(undefined)).toBe(false);
});

test("an ambiguous primary section can return to its original link after unlinking", async () => {
  await withLedger(async (_, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    /* The record is 中央線（快速）'s 東京→新宿 — that service's
       first block. 山手線 serves both endpoints too, but over a
       different route, so the pair alone cannot say the ride
       was 山手線's: the relink is refused and the row is left
       exactly as stored. */
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "yamanote",
      }),
    ).rejects.toThrow(/cannot be linked/);
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after).toEqual(before);
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: null,
      }),
    ).toEqual({ ok: true, serviceId: null });
    const [unlinked] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(unlinked).toMatchObject({
      serviceId: null,
      recordedServiceId: "jr-chuo-rapid",
    });
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "yamanote",
      }),
    ).rejects.toThrow(/cannot be linked/);
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-chuo-rapid",
      }),
    ).toEqual({ ok: true, serviceId: "jr-chuo-rapid" });
    const { lines } = await Actions.listRiddenLines.handler(ctx, {});
    expect(lines[0]).toMatchObject({
      serviceId: "jr-chuo-rapid",
      recordedServiceId: "jr-chuo-rapid",
    });
    const coverage = computeRiddenLineCoverage(lines, GEOMETRIES, 597);
    expect(coverage.perService.get("jr-chuo-rapid")?.riddenKm).toBeCloseTo(9.1, 1);
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, ride_state, from_station_id, to_station_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', 'partial', '003766', '003700', 'historical-master', 0)`));
});

test("a new explicitly recorded Chuo Rapid primary section counts Tokyo to Shinjuku", async () => {
  await withLedger(async (_, ctx) => {
    await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "JR中央線（快速）",
      serviceId: "jr-chuo-rapid",
      rideState: "partial",
      fromStationId: "003766",
      toStationId: "003700",
    });
    const { lines } = await Actions.listRiddenLines.handler(ctx, {});
    expect(lines[0]).toMatchObject({
      serviceId: "jr-chuo-rapid",
      serviceLinkSource: "explicit",
      recordedServiceId: "jr-chuo-rapid",
    });
    const coverage = computeRiddenLineCoverage(lines, GEOMETRIES, 597);
    expect(coverage.perService.get("jr-chuo-rapid")?.riddenKm).toBeCloseTo(9.1, 1);
    expect(coverage.networkRiddenKm).toBeCloseTo(9.1, 1);
    expect(coverage.perService.has("yamanote")).toBe(false);
  });
});

test("a legacy blockless Tokyo to Shinjuku section cannot be relinked to Yamanote", async () => {
  await withLedger(async (_, ctx) => {
    const { lines: before } = await Actions.listRiddenLines.handler(ctx, {});
    const [line] = before;
    if (!line) throw new Error("Missing seeded ledger row");
    expect(line).toMatchObject({
      serviceId: "jr-chuo-rapid",
      fromStationId: null,
      toStationId: null,
      sections: [
        { fromStationId: "003766", toStationId: "003700", blockId: null },
      ],
    });
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: line.id,
        serviceId: "yamanote",
      }),
    ).rejects.toThrow(/cannot be linked/);
    expect((await Actions.listRiddenLines.handler(ctx, {})).lines).toEqual(before);
  }, undefined, (client) => client.executeMultiple(`
    INSERT INTO ridden_lines (id, name, first_ridden_on, service_id, ride_state, created_at)
    VALUES (1, '中央線（各駅停車）', '2026-11-23', 'jr-chuo-rapid', 'partial', 0);
    INSERT INTO ridden_line_sections (ridden_line_id, from_station_id, to_station_id, created_at)
    VALUES (1, '003766', '003700', 0);
  `));
});

test("an already relinked legacy blockless section contributes no Yamanote distance", async () => {
  await withLedger(async (_, ctx) => {
    const { lines } = await Actions.listRiddenLines.handler(ctx, {});
    expect(lines[0]).toMatchObject({
      serviceId: "yamanote",
      serviceLinkSource: "explicit",
      sections: [{ blockId: null, recordedServiceId: null }],
    });
    const coverage = computeRiddenLineCoverage(lines, GEOMETRIES, 597);
    expect(coverage.perService.get("yamanote")?.riddenKm).toBe(0);
    expect(coverage.networkRiddenKm).toBe(0);
  }, undefined, (client) => client.executeMultiple(`
    INSERT INTO ridden_lines (id, name, first_ridden_on, service_id, service_link_source, ride_state, created_at)
    VALUES (1, '中央線（各駅停車）', '2026-11-23', 'yamanote', 'explicit', 'partial', 0);
    INSERT INTO ridden_line_sections (ridden_line_id, from_station_id, to_station_id, created_at)
    VALUES (1, '003766', '003700', 0);
  `));
});

test("a new blockless section keeps the service and direction it was recorded on", async () => {
  await withLedger(async (_, ctx) => {
    const { id } = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "山手線",
    });
    if (id == null) throw new Error("Missing 山手線 row");
    await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: id,
      fromStationId: "003766",
      toStationId: "003700",
      direction: "inner",
    });
    const { lines } = await Actions.listRiddenLines.handler(ctx, {});
    expect(lines[0]).toMatchObject({
      rideState: "partial",
      sections: [
        { blockId: null, direction: "inner", recordedServiceId: "yamanote" },
      ],
    });
    const coverage = computeRiddenLineCoverage(lines, GEOMETRIES, 597);
    expect(coverage.perService.get("yamanote")?.riddenKm).toBeCloseTo(16.93, 1);
  });
});

test("relinking a row whose added section names another service's block is refused (integrated review round 2, high)", async () => {
  await withLedger(async (client, ctx) => {
    const [before] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    if (!before) throw new Error("Missing seeded ledger row");
    /* The added section is 総武本線's block b1 （東京→千葉）.
       Its endpoints are stations 総武快速線 serves too, so the
       endpoint check alone would let the relink carry the
       section onto the rapid service; the block ID is the
       section's own record of where it was ridden, and it does
       not belong to 総武快速線. */
    await client.execute(
      `INSERT INTO ridden_line_sections
         (ridden_line_id, from_station_id, to_station_id, from_station_name, to_station_name, block_id, created_at)
       VALUES (${before.id}, '003766', '004173', '東京', '千葉', 'jr-sobu-local/b1', 0)`,
    );
    await expect(
      Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-sobu-rapid",
      }),
    ).rejects.toThrow(/cannot be linked/);
    /* With the block link gone, the same section is an
       endpoints-only record over the shared formal line, and
       the relink fits. */
    await client.execute(
      `UPDATE ridden_line_sections SET block_id = NULL WHERE ridden_line_id = ${before.id}`,
    );
    expect(
      await Actions.confirmRiddenServiceLink.handler(ctx, {
        id: before.id,
        serviceId: "jr-sobu-rapid",
      }),
    ).toEqual({ ok: true, serviceId: "jr-sobu-rapid" });
  }, (client) => client.execute(`INSERT INTO ridden_lines (name, first_ridden_on, service_id, ride_state, from_station_id, to_station_id, master_version, created_at)
    VALUES ('中央線（各駅停車）', '2026-11-23', 'jr-sobu-local', 'partial', '003766', '004173', 'historical-master', 0)`));
});

test("a duplicate section registration adopts the later call's block_id (integrated review round 2, H-3)", async () => {
  await withLedger(async (_, ctx) => {
    /* Hand entry first, block pick second: the surviving row
       must adopt keio/b1, or the ledger can no longer untick
       the block the section covers. */
    const keio = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "京王線",
    });
    if (keio.id == null) throw new Error("Missing 京王線 row");
    const handFirst = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: keio.id,
      fromStationId: "003700",
      toStationId: "003966",
    });
    expect(handFirst.created).toBe(true);
    expect(
      await Actions.addRiddenSection.handler(ctx, {
        riddenLineId: keio.id,
        fromStationId: "003700",
        toStationId: "003966",
        blockId: "keio/b1",
      }),
    ).toEqual({ created: false, id: handFirst.id });
    const keioRow = (await Actions.listRiddenLines.handler(ctx, {})).lines.find(
      (row) => row.name === "京王線",
    );
    expect(keioRow?.sections).toEqual([
      expect.objectContaining({ id: handFirst.id, blockId: "keio/b1" }),
    ]);
    /* Block pick first, hand entry second: the row keeps the
       block it already has. */
    const yamanote = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "山手線",
    });
    if (yamanote.id == null) throw new Error("Missing 山手線 row");
    const blockFirst = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: yamanote.id,
      fromStationId: "004095",
      toStationId: "003922",
      direction: "outer",
      blockId: "yamanote/b1",
    });
    expect(blockFirst.created).toBe(true);
    expect(
      await Actions.addRiddenSection.handler(ctx, {
        riddenLineId: yamanote.id,
        fromStationId: "004095",
        toStationId: "003922",
        direction: "outer",
      }),
    ).toEqual({ created: false, id: blockFirst.id });
    const yamanoteRow = (
      await Actions.listRiddenLines.handler(ctx, {})
    ).lines.find((row) => row.name === "山手線");
    expect(yamanoteRow?.sections).toEqual([
      expect.objectContaining({ id: blockFirst.id, blockId: "yamanote/b1" }),
    ]);
  });
});

test("an add after a delete sees zero sections keeps the replacement ride partial", async () => {
  await withLedger(async (client, ctx) => {
    const line = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "武蔵野線",
    });
    if (line.id == null) throw new Error("Missing 武蔵野線 row");
    const riddenLineId = line.id;
    const first = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId,
      fromStationId: "003876",
      toStationId: "003004",
    });
    if (first.id == null) throw new Error("Missing initial section");

    const execute = client.execute.bind(client);
    const batch = client.batch.bind(client);
    const statementSql = (statement: Parameters<TestDatabase["execute"]>[0]) =>
      typeof statement === "string" ? statement : statement.sql;
    let replacementId: number | null = null;
    let deletePaused = false;
    const addWhileDeletePaused = async () => {
      deletePaused = true;
      const replacement = await Actions.addRiddenSection.handler(ctx, {
        riddenLineId,
        fromStationId: "003004",
        toStationId: "003547",
      });
      expect(replacement.created).toBe(true);
      replacementId = replacement.id;
    };

    client.execute = async (statement) => {
      const result = await execute(statement);
      // Before the fix, let DELETE read an empty result, finish the competing
      // add, then hand the now-stale result back to the delete handler.
      if (!deletePaused && result.rows.length === 0 &&
          statementSql(statement).startsWith('select "id" from "ridden_line_sections"')) {
        await addWhileDeletePaused();
      }
      return result;
    };
    client.batch = async (statements, mode) => {
      const result = await batch(statements, mode);
      if (statements.some((statement) =>
        statementSql(statement).startsWith('delete from "ridden_line_sections"'),
      )) {
        // The empty section list and unknown state must already be committed
        // together before the competing add can run.
        const [afterDelete] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
        expect(afterDelete).toMatchObject({ rideState: "unknown", sections: [] });
        await addWhileDeletePaused();
      }
      return result;
    };

    expect(await Actions.deleteRiddenSection.handler(ctx, { id: first.id }))
      .toEqual({ ok: true });
    expect(replacementId).not.toBeNull();
    const [after] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(after?.rideState).toBe("partial");
    expect(after?.sections).toEqual([
      expect.objectContaining({
        id: replacementId,
        fromStationId: "003004",
        toStationId: "003547",
      }),
    ]);
  });
});

test("a failed ride-state update rolls back the section add or delete", async () => {
  await withLedger(async (client, ctx) => {
    const line = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "武蔵野線",
    });
    if (line.id == null) throw new Error("Missing 武蔵野線 row");
    const section = {
      riddenLineId: line.id,
      fromStationId: "003876",
      toStationId: "003004",
    };
    const rejectStateUpdates = () => client.execute(`
      CREATE TRIGGER reject_ride_state BEFORE UPDATE OF ride_state ON ridden_lines
      BEGIN
        SELECT RAISE(ABORT, 'ride state update failed');
      END
    `);

    await rejectStateUpdates();
    await expect(Actions.addRiddenSection.handler(ctx, section))
      .rejects.toThrow(/ride state update failed/);
    const [afterFailedAdd] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(afterFailedAdd).toMatchObject({ rideState: "unknown", sections: [] });

    await client.execute("DROP TRIGGER reject_ride_state");
    const added = await Actions.addRiddenSection.handler(ctx, section);
    if (added.id == null) throw new Error("Missing added section");
    await rejectStateUpdates();
    await expect(Actions.deleteRiddenSection.handler(ctx, { id: added.id }))
      .rejects.toThrow(/ride state update failed/);
    const [afterFailedDelete] = (await Actions.listRiddenLines.handler(ctx, {})).lines;
    expect(afterFailedDelete).toMatchObject({
      rideState: "partial",
      sections: [expect.objectContaining({ id: added.id })],
    });
  });
});

test("a duplicate add repairs a row left unknown with a section on record (review round 2, medium)", async () => {
  await withLedger(async (_, ctx) => {
    /* The inconsistent state the review reproduced: a section
       is on record, but the row says unknown (an add that read
       the row before a delete of the last section landed).
       A duplicate add returns the existing row — and must now
       repair the state to partial instead of returning early
       without touching it. */
    const before = (await Actions.listRiddenLines.handler(ctx, {})).lines[0];
    expect(before).toMatchObject({ rideState: "unknown" });
    expect(before?.sections).toHaveLength(1);
    const existingId = before?.sections[0]?.id;
    if (existingId == null) throw new Error("Missing seeded section");
    const result = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: before!.id,
      fromStationId: "003700",
      toStationId: "003922",
      direction: "outer",
    });
    expect(result.created).toBe(false);
    expect(result.id).toBe(existingId);
    const after = (await Actions.listRiddenLines.handler(ctx, {})).lines[0];
    expect(after).toMatchObject({ rideState: "partial" });
    expect(after?.sections).toHaveLength(1);
  }, undefined, (client) => client.executeMultiple(`
    INSERT INTO ridden_lines (id, name, first_ridden_on, service_id, service_link_source, ride_state, created_at)
    VALUES (1, '山手線', '2026-11-24', 'yamanote', 'explicit', 'unknown', 0);
    INSERT INTO ridden_line_sections (ridden_line_id, from_station_id, to_station_id, direction, created_at)
    VALUES (1, '003700', '003922', 'outer', 0);
  `));
});

test("a named loop block must match both its ordered endpoints and direction", async () => {
  await withLedger(async (_, ctx) => {
    const yamanote = await Actions.addRiddenLine.handler(ctx, {
      ...aRide,
      name: "山手線",
    });
    if (yamanote.id == null) throw new Error("Missing 山手線 row");
    /* 新宿→渋谷 outer uses the other five blocks. */
    await expect(
      Actions.addRiddenSection.handler(ctx, {
        riddenLineId: yamanote.id,
        fromStationId: "003700",
        toStationId: "003922",
        direction: "outer",
        blockId: "yamanote/b2",
      }),
    ).rejects.toThrow(/runs 渋谷→新宿, not the given section/);
    /* 渋谷→新宿 inner also goes the long way around. */
    await expect(
      Actions.addRiddenSection.handler(ctx, {
        riddenLineId: yamanote.id,
        fromStationId: "003922",
        toStationId: "003700",
        direction: "inner",
        blockId: "yamanote/b2",
      }),
    ).rejects.toThrow(/runs outer, not inner/);
    const blockFirst = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: yamanote.id,
      fromStationId: "003922",
      toStationId: "003700",
      direction: "outer",
      blockId: "yamanote/b2",
    });
    expect(blockFirst.created).toBe(true);
    /* 新宿→渋谷 inner is the reverse ride and can be entered by hand. */
    await expect(
      Actions.addRiddenSection.handler(ctx, {
        riddenLineId: yamanote.id,
        fromStationId: "003700",
        toStationId: "003922",
        direction: "inner",
        blockId: "yamanote/b2",
      }),
    ).rejects.toThrow(/runs 渋谷→新宿, not the given section/);
    const handEntry = await Actions.addRiddenSection.handler(ctx, {
      riddenLineId: yamanote.id,
      fromStationId: "003700",
      toStationId: "003922",
      direction: "inner",
    });
    expect(handEntry.created).toBe(true);
    const row = (await Actions.listRiddenLines.handler(ctx, {})).lines.find(
      (line) => line.name === "山手線",
    );
    expect(row?.sections).toHaveLength(2);
    expect(row?.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: blockFirst.id,
        blockId: "yamanote/b2",
        direction: "outer",
      }),
      expect.objectContaining({
        id: handEntry.id,
        blockId: null,
        direction: "inner",
      }),
    ]));
  });
});
