/* Regression tests for the ledger line-name resolution, run against
   the REAL bundled asset (visited-lines.ts) so a regenerated asset
   that breaks a ledger name fails here first. Resolution is backed
   by the service master (shared/service-master.ts); the old
   LEDGER_LINE_NAME_MAP is gone (stage 1, subtask 1420).
   Run with: bun test client/src/line-resolution.test.ts */
import { describe, expect, test } from "bun:test";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import {
  buildLineKeyByName,
  countRiddenByOperator,
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
   and the asset key each must resolve to. */
const LEDGER_ROWS: [string, string | null][] = [
  ["JR武蔵野線", "武蔵野線|東日本旅客鉄道"],
  ["北総線", "北総線|北総鉄道"],
  ["JR中央線（快速）", "中央線|東日本旅客鉄道"],
  ["JR総武快速線", "総武線|東日本旅客鉄道"],
  ["JR総武本線", "総武線|東日本旅客鉄道"],
  ["京王線", "京王線|京王電鉄"],
  ["JR埼京線", null],
  ["りんかい線", "臨海副都心線|東京臨海高速鉄道"],
  ["山手線", "山手線|東日本旅客鉄道"],
];

describe("the nine ledger rows", () => {
  for (const [ledgerName, key] of LEDGER_ROWS) {
    test(`${ledgerName} → ${key ?? "no single key"}`, () => {
      expect(resolve(ledgerName)).toBe(key);
    });
  }

  test("resolve to seven distinct keys （総武快速・総武本線 share 総武線；埼京線 has none)", () => {
    const keys = new Set(
      LEDGER_ROWS.map(([name]) => resolve(name)).filter((k) => k !== null),
    );
    expect(keys.size).toBe(7);
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
    expect(resolveKeys("山手線")).toEqual(["山手線|東日本旅客鉄道"]);
  });

  test("山手線 resolves via the master (the name is ambiguous in the asset)", () => {
    // Premise: 「山手線」 is shared with 神戸市's line, so
    // buildLineKeyByName excludes it and only the master can
    // resolve it to JR East's loop.
    expect(keyByName.has("山手線")).toBe(false);
    expect(resolve("山手線")).toBe("山手線|東日本旅客鉄道");
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

/* The 事業者別 chart counts ledger ROWS, not distinct resolved
   keys: JR総武快速線 and JR総武本線 are two rides on the one asset
   line 「総武線」, and both must show. All nine live ledger rows. */
describe("per-operator counts", () => {
  const ALL_LEDGER_NAMES = LEDGER_ROWS.map(([name]) => name);
  const counts = countRiddenByOperator(
    ALL_LEDGER_NAMES,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
  );

  test("総武快速線 and 総武本線 count as two JR East rides", () => {
    // 武蔵野線・中央線・総武快速線・総武本線・山手線・埼京線 = 6 rows.
    // Counting distinct resolved keys instead would give 4 — the
    // collapse this counting rule exists to prevent.
    expect(counts.get("東日本旅客鉄道")).toBe(6);
    const distinctKeys = new Set(
      ALL_LEDGER_NAMES.map((n) => resolve(n)).filter((k) => k !== null),
    );
    expect(distinctKeys.size).toBe(7);
  });

  test("every operator with a ridden row appears once per ride", () => {
    expect(counts.get("北総鉄道")).toBe(1);
    expect(counts.get("京王電鉄")).toBe(1);
    expect(counts.get("東京臨海高速鉄道")).toBe(1);
    expect(counts.size).toBe(4);
  });

  test("all nine rows count for an operator now (埼京線 included)", () => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(9);
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
