import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { readdir } from "node:fs/promises";
import { Actions } from "./actions";
import * as schema from "./schema";

const aRide = { firstRiddenOn: "2026-11-24" };
type ActionContext = Parameters<typeof Actions.addRiddenLine.handler>[0];
type TestDatabase = ReturnType<typeof createClient>;

async function withLedger(
  verify: (client: TestDatabase, ctx: ActionContext) => Promise<void>,
  seedBeforeStage2?: (client: TestDatabase) => Promise<unknown>,
) {
  const directory = new URL("../../drizzle/", import.meta.url);
  const migrations = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const client = createClient({ url: ":memory:" });
  try {
    for (const file of migrations) {
      if (file.startsWith("0012_")) await seedBeforeStage2?.(client);
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
