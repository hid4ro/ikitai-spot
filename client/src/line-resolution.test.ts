/* Regression tests for the ledger line-name resolution, run against
   the REAL bundled asset (visited-lines.ts) so a regenerated asset
   that breaks a ledger name fails here first. Resolution is backed
   by the service master (shared/service-master.ts); the old
   LEDGER_LINE_NAME_MAP is gone (stage 1, subtask 1420).
   Run with: bun test client/src/line-resolution.test.ts */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import { serviceByLedgerName } from "../../shared/service-master";
import {
  buildLineKeyByName,
  countRiddenByOperator,
  countRiddenServices,
  resolveRiddenLineKey,
  resolveRiddenLineKeys,
} from "./line-resolution";

const keyByName = buildLineKeyByName(RIDDEN_LINE_GEOMETRIES);
const resolve = (ledgerName: string): string | null =>
  resolveRiddenLineKey(ledgerName, RIDDEN_LINE_GEOMETRIES, keyByName);
const resolveKeys = (ledgerName: string): string[] =>
  resolveRiddenLineKeys(ledgerName, RIDDEN_LINE_GEOMETRIES, keyByName);

/* The nine rows of the live ridden-lines ledger (listRiddenLines,
   ids 1, 3–10 — id 2 was deleted; 西武池袋線 is not a live row)
   and the asset key each must resolve to. 山手線 has no single key
   since stage 1's loop split (review finding 4): it spans 山手線・
   東北線・東海道線, so it resolves like JR埼京線 — via its
   expansion, not a single key. */
const LEDGER_ROWS: [string, string | null][] = [
  ["JR武蔵野線", "武蔵野線|東日本旅客鉄道"],
  ["北総線", "北総線|北総鉄道"],
  ["JR中央線（快速）", "中央線|東日本旅客鉄道"],
  ["JR総武快速線", "総武線|東日本旅客鉄道"],
  ["JR総武本線", "総武線|東日本旅客鉄道"],
  ["京王線", "京王線|京王電鉄"],
  ["JR埼京線", null],
  ["りんかい線", "臨海副都心線|東京臨海高速鉄道"],
  ["山手線", null],
];

describe("the nine ledger rows", () => {
  for (const [ledgerName, key] of LEDGER_ROWS) {
    test(`${ledgerName} → ${key ?? "no single key"}`, () => {
      expect(resolve(ledgerName)).toBe(key);
    });
  }

  test("resolve to six distinct keys （総武快速・総武本線 share 総武線；埼京線・山手線 have none)", () => {
    const keys = new Set(
      LEDGER_ROWS.map(([name]) => resolve(name)).filter((k) => k !== null),
    );
    expect(keys.size).toBe(6);
  });
});

describe("multi-line expansion (JR埼京線）", () => {
  test("JR埼京線 has no single key but expands to four formal lines", () => {
    expect(resolve("JR埼京線")).toBeNull();
    expect(resolveKeys("JR埼京線")).toEqual([
      "山手線|東日本旅客鉄道",
      "赤羽線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
      "川越線|東日本旅客鉄道",
    ]);
  });

  test("single-line services expand to their one key", () => {
    expect(resolveKeys("JR武蔵野線")).toEqual(["武蔵野線|東日本旅客鉄道"]);
    expect(resolveKeys("りんかい線")).toEqual([
      "臨海副都心線|東京臨海高速鉄道",
    ]);
  });

  test("山手線 expands to its three loop keys, in running order", () => {
    // The loop split (review finding 4): 山手線 品川〜田端, 東北線
    // 田端〜東京, 東海道線 東京〜品川. No single key stands for
    // the whole loop, so the single-key resolution is null and the
    // row is framed by its ridden section from stage 2.
    expect(resolve("山手線")).toBeNull();
    expect(resolveKeys("山手線")).toEqual([
      "山手線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
      "東海道線|東日本旅客鉄道",
    ]);
  });

  test("山手線 resolves via the master (the name is ambiguous in the asset)", () => {
    // Premise: 「山手線」 is shared with 神戸市's line, so
    // buildLineKeyByName excludes it and only the master can
    // resolve it to JR East's loop.
    expect(keyByName.has("山手線")).toBe(false);
    expect(resolveKeys("山手線")).toEqual([
      "山手線|東日本旅客鉄道",
      "東北線|東日本旅客鉄道",
      "東海道線|東日本旅客鉄道",
    ]);
  });

  test("りんかい線 resolves to its official name 臨海副都心線", () => {
    // Premise: the asset has no line named 「りんかい線」 at all; the
    // N02 master records the line under its official name only.
    expect(keyByName.has("りんかい線")).toBe(false);
    expect(resolve("りんかい線")).toBe("臨海副都心線|東京臨海高速鉄道");
  });

  test("the N02 master carries no 埼京線 line unit at all", () => {
    expect(
      Object.values(RIDDEN_LINE_GEOMETRIES).some((e) => e.name.includes("埼京")),
    ).toBe(false);
  });
});

/* The 事業者別 chart counts DISTINCT SERVICES, not ledger rows
   and not distinct resolved keys: JR総武快速線 and JR総武本線 are
   two rides on two services that share the one asset line 「総武線」,
   and both must show — while two spellings of ONE service （「JR中央線」
   and 「JR中央線（快速）」) count once. All nine live ledger rows. */
describe("per-operator counts", () => {
  const ALL_LEDGER_ROWS = LEDGER_ROWS.map(([name]) => ({
    name,
    serviceId: serviceByLedgerName(name)?.id ?? null,
  }));
  const counts = countRiddenByOperator(
    ALL_LEDGER_ROWS,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
  );

  test("総武快速線 and 総武本線 count as two JR East rides", () => {
    // 武蔵野線・中央線・総武快速線・総武本線・山手線・埼京線 = 6 services.
    // Counting distinct resolved keys instead would give 4 — the
    // collapse this counting rule exists to prevent.
    expect(counts.get("東日本旅客鉄道")).toBe(6);
    const distinctKeys = new Set(
      ALL_LEDGER_ROWS.map((r) => resolve(r.name)).filter((k) => k !== null),
    );
    expect(distinctKeys.size).toBe(6);
  });

  test("every operator with a ridden row appears once per service", () => {
    expect(counts.get("北総鉄道")).toBe(1);
    expect(counts.get("京王電鉄")).toBe(1);
    expect(counts.get("東京臨海高速鉄道")).toBe(1);
    expect(counts.size).toBe(4);
  });

  test("all nine rows count for an operator now (埼京線 included)", () => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(9);
  });

  test("two spellings of one service count once (review finding 5)", () => {
    // 「JR中央線」 is the rapid service's alias: both rows are
    // jr-chuo-rapid, so JR East gains one service, not two.
    const aliasCounts = countRiddenByOperator(
      [
        { name: "JR中央線", serviceId: "jr-chuo-rapid" },
        { name: "JR中央線（快速）", serviceId: "jr-chuo-rapid" },
      ],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    expect(aliasCounts.get("東日本旅客鉄道")).toBe(1);
    // The same for りんかい線 under its formal name: both rows are
    // rinkai, so 東京臨海高速鉄道 stays at one — the 2/1 the
    // review reproduced is gone.
    const rinkaiCounts = countRiddenByOperator(
      [
        { name: "りんかい線", serviceId: "rinkai" },
        { name: "臨海副都心線", serviceId: "rinkai" },
      ],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    expect(rinkaiCounts.get("東京臨海高速鉄道")).toBe(1);
  });

  test("りんかい線 under both spellings counts once even with no saved service_id (review round 2)", () => {
    // The reviewer's exact reproduction: both rows registered by
    // name only, so neither carries a saved service_id — the second
    // spelling （「臨海副都心線（りんかい線）」) matched no ledger
    // name and fell back to its map key, double-counting the
    // operator. The parenthetical spelling now resolves to rinkai
    // through the master, so both rows are one service.
    const counts = countRiddenByOperator(
      [
        { name: "りんかい線", serviceId: null },
        { name: "臨海副都心線（りんかい線）", serviceId: null },
      ],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    expect(counts.get("東京臨海高速鉄道")).toBe(1);
  });

  test("武蔵野線 under both spellings counts once even with no saved service_id (review round 3)", () => {
    // The reviewer's exact reproduction: both rows registered by
    // name only, so neither carries a saved service_id — the JR-less
    // spelling （「武蔵野線」) matched no ledger name and fell back
    // to its map key, double-counting the operator 2/1 and the
    // national donut 2/597. The JR prefix is stripped for the
    // lookup now, so both rows are one service.
    const rows = [
      { name: "JR武蔵野線", serviceId: null },
      { name: "武蔵野線", serviceId: null },
    ];
    expect(
      countRiddenByOperator(rows, RIDDEN_LINE_GEOMETRIES, keyByName).get(
        "東日本旅客鉄道",
      ),
    ).toBe(1);
    expect(countRiddenServices(rows, RIDDEN_LINE_GEOMETRIES, keyByName)).toBe(
      1,
    );
  });

  test("a saved service_id wins over the recorded name", () => {
    // A row recorded as 「臨海副都心線」 with no saved id still
    // resolves through the master's alias; with a saved id it
    // resolves from the id even if the name were mistyped.
    const byName = countRiddenByOperator(
      [{ name: "臨海副都心線", serviceId: null }],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    expect(byName.get("東京臨海高速鉄道")).toBe(1);
  });
});

describe("national donut numerator (review round 2)", () => {
  const ALL_LEDGER_ROWS = LEDGER_ROWS.map(([name]) => ({
    name,
    serviceId: serviceByLedgerName(name)?.id ?? null,
  }));

  test("the nine legacy rows count as nine services, not six keys", () => {
    // The donut used to show 6 / 597 (distinct resolved keys):
    // 総武快速線・総武本線 share one key, and JR埼京線・山手線
    // have no single key at all in stage 1. The numerator now
    // counts distinct services, agreeing with the 事業者別 chart.
    expect(countRiddenServices(ALL_LEDGER_ROWS, RIDDEN_LINE_GEOMETRIES, keyByName)).toBe(9);
  });

  test("a row with no known service still counts once by its resolved key", () => {
    // 西武池袋線 is not in the master, but it names a real line,
    // so it counts once for its operator — the donut must not drop
    // rides the master has not learned yet.
    expect(
      countRiddenServices(
        [{ name: "西武池袋線", serviceId: null }],
        RIDDEN_LINE_GEOMETRIES,
        keyByName,
      ),
    ).toBe(1);
    expect(
      countRiddenServices(
        [{ name: "存在しない線", serviceId: null }],
        RIDDEN_LINE_GEOMETRIES,
        keyByName,
      ),
    ).toBe(0);
  });
});

describe("normalization fallback", () => {
  test("a brand-plus-線 name resolves by exact name, not by stripping the brand down to 「線」", () => {
    // The master answers the real 京王線 first, so the fallback's
    // exact-match rule is exercised here on a synthetic asset instead,
    // keeping the rule itself covered for names the master does not know.
    const fakeGeometries = {
      "東急線|東急電鉄": { name: "東急線" },
    } as Record<string, { name: string }>;
    const fakeKeyByName = buildLineKeyByName(fakeGeometries);
    expect(
      resolveRiddenLineKey("東急線", fakeGeometries, fakeKeyByName),
    ).toBe("東急線|東急電鉄");
  });

  test("an operator brand is stripped when the remainder is a real line name", () => {
    expect(resolve("京王相模原線")).toBe("相模原線|京王電鉄");
    expect(resolve("西武新宿線")).toBe("新宿線|西武鉄道");
  });

  test("西武池袋線 still resolves via the fallback (no live row, old spelling)", () => {
    // Not in the master — no live ledger row carries it — but the
    // spelling still names a real line, so the fallback resolves it.
    expect(resolve("西武池袋線")).toBe("池袋線|西武鉄道");
    expect(resolveKeys("西武池袋線")).toEqual(["池袋線|西武鉄道"]);
  });

  test("JR中央線 without the （快速）suffix resolves via the master alias", () => {
    expect(resolve("JR中央線")).toBe("中央線|東日本旅客鉄道");
  });

  test("an unknown name resolves to null", () => {
    expect(resolve("存在しない線")).toBeNull();
    expect(resolveKeys("存在しない線")).toEqual([]);
  });

  test("a name shared by several operators stays unresolved by name alone", () => {
    // 「本線」 names many operators' lines; buildLineKeyByName leaves
    // it out, so the fallback must not guess one operator's track.
    expect(keyByName.has("本線")).toBe(false);
    expect(resolve("本線")).toBeNull();
  });
});
