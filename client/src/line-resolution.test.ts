/* Regression tests for the ledger line-name resolution, run against
   the REAL bundled asset (visited-lines.ts) so a regenerated asset
   that breaks a ledger name fails here first.
   Run with: bun test client/src/line-resolution.test.ts */
import { describe, expect, test } from "bun:test";
import {
  LEDGER_LINE_NAME_MAP,
  RIDDEN_LINE_GEOMETRIES,
} from "./assets/visited-lines";
import {
  buildLineKeyByName,
  countRiddenByOperator,
  resolveRiddenLineKey,
} from "./line-resolution";

const keyByName = buildLineKeyByName(RIDDEN_LINE_GEOMETRIES);
const resolve = (ledgerName: string): string | null =>
  resolveRiddenLineKey(
    ledgerName,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
    LEDGER_LINE_NAME_MAP,
  );

/* The seven rows of the ridden-lines ledger as of 2026-11-23
   (riddenLines ids 1–7) and the asset key each must resolve to. */
const LEDGER_ROWS: [string, string][] = [
  ["JR武蔵野線", "武蔵野線|東日本旅客鉄道"],
  ["西武池袋線", "池袋線|西武鉄道"],
  ["北総線", "北総線|北総鉄道"],
  ["JR中央線（快速）", "中央線|東日本旅客鉄道"],
  ["JR総武快速線", "総武線|東日本旅客鉄道"],
  ["JR総武本線", "総武線|東日本旅客鉄道"],
  ["京王線", "京王線|京王電鉄"],
];

describe("the seven ledger rows", () => {
  for (const [ledgerName, key] of LEDGER_ROWS) {
    test(`${ledgerName} → ${key}`, () => {
      expect(resolve(ledgerName)).toBe(key);
    });
  }

  test("resolve to six distinct keys （総武快速・総武本線 share 総武線）", () => {
    const keys = new Set(LEDGER_ROWS.map(([name]) => resolve(name)));
    expect(keys.size).toBe(6);
    expect(keys.has(null)).toBe(false);
  });
});

/* The three rows added to the ledger on 2026-11-24 (riddenLines
   ids 8–10, confirmed against the live ledger before this fix).
   All three used to fall out of the map overlay and the
   per-operator chart. */
describe("the 2026-11-24 ledger rows", () => {
  test("山手線 resolves to the JR East line via the ledger map", () => {
    // Premise: 「山手線」 is an ambiguous name in the asset — JR East's
    // loop and a Kobe municipal line share it — so buildLineKeyByName
    // excludes it and only the explicit map entry can resolve it.
    expect(keyByName.has("山手線")).toBe(false);
    expect(LEDGER_LINE_NAME_MAP["山手線"]).toBe("山手線|東日本旅客鉄道");
    expect(resolve("山手線")).toBe("山手線|東日本旅客鉄道");
  });

  test("りんかい線 resolves to its official name 臨海副都心線", () => {
    // Premise: the asset has no line named 「りんかい線」 at all; the
    // N02 master records the line under its official name only.
    expect(keyByName.has("りんかい線")).toBe(false);
    expect(LEDGER_LINE_NAME_MAP["りんかい線"]).toBe("臨海副都心線|東京臨海高速鉄道");
    expect(resolve("りんかい線")).toBe("臨海副都心線|東京臨海高速鉄道");
  });

  test("JR埼京線 is explicitly recorded as unresolved (N02 master gap)", () => {
    // The N02 2025 master has no 埼京線 line unit at all — the
    // corridor is recorded as parts of 山手線・赤羽線・東北本線・川越線 —
    // so the map entry is an explicit null, not a missing key: the
    // gap is a recorded decision, not a silent omission.
    expect(Object.hasOwn(LEDGER_LINE_NAME_MAP, "JR埼京線")).toBe(true);
    expect(LEDGER_LINE_NAME_MAP["JR埼京線"]).toBeNull();
    expect(
      Object.values(RIDDEN_LINE_GEOMETRIES).some((e) => e.name.includes("埼京")),
    ).toBe(false);
    expect(resolve("JR埼京線")).toBeNull();
  });
});

/* The 事業者別 chart counts ledger ROWS, not distinct resolved
   keys: JR総武快速線 and JR総武本線 are two rides on the one asset
   line 「総武線」, and both must show. All ten ledger rows as of
   2026-11-24 (the seven above plus the three new ones). */
describe("per-operator counts", () => {
  const ALL_LEDGER_NAMES = [
    ...LEDGER_ROWS.map(([name]) => name),
    "山手線",
    "りんかい線",
    "JR埼京線",
  ];
  const counts = countRiddenByOperator(
    ALL_LEDGER_NAMES,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
    LEDGER_LINE_NAME_MAP,
  );

  test("総武快速線 and 総武本線 count as two JR East rides", () => {
    // 武蔵野線・中央線・総武快速線・総武本線・山手線 = 5 rows. Counting
    // distinct resolved keys instead would give 4 — the collapse
    // this counting rule exists to prevent.
    expect(counts.get("東日本旅客鉄道")).toBe(5);
    const distinctKeys = new Set(
      ALL_LEDGER_NAMES.map((n) => resolve(n)).filter((k) => k !== null),
    );
    expect(distinctKeys.size).toBe(8);
  });

  test("every operator with a resolved row appears once per ride", () => {
    expect(counts.get("西武鉄道")).toBe(1);
    expect(counts.get("北総鉄道")).toBe(1);
    expect(counts.get("京王電鉄")).toBe(1);
    expect(counts.get("東京臨海高速鉄道")).toBe(1);
    expect(counts.size).toBe(5);
  });

  test("the unresolved JR埼京線 counts for no operator", () => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(9);
  });
});

describe("normalization fallback", () => {
  test("京王線 resolves by exact name, not by stripping 京王 down to 「線」", () => {
    // 京王線 is not in LEDGER_LINE_NAME_MAP, so this exercises the
    // fallback — the path that used to return null for it.
    expect(LEDGER_LINE_NAME_MAP["京王線"]).toBeUndefined();
    expect(resolve("京王線")).toBe("京王線|京王電鉄");
  });

  test("an operator brand is stripped when the remainder is a real line name", () => {
    expect(resolve("京王相模原線")).toBe("相模原線|京王電鉄");
    expect(resolve("西武新宿線")).toBe("新宿線|西武鉄道");
  });

  test("JR中央線 without the （快速）suffix resolves via the ledger map", () => {
    expect(resolve("JR中央線")).toBe("中央線|東日本旅客鉄道");
  });

  test("an unknown name resolves to null", () => {
    expect(resolve("存在しない線")).toBeNull();
  });

  test("a name shared by several operators stays unresolved by name alone", () => {
    // 「本線」 names many operators' lines; buildLineKeyByName leaves
    // it out, so the fallback must not guess one operator's track.
    expect(keyByName.has("本線")).toBe(false);
    expect(resolve("本線")).toBeNull();
  });
});
