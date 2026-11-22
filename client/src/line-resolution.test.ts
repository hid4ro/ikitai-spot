/* Regression tests for the ledger line-name resolution, run against
   the REAL bundled asset (visited-lines.ts) so a regenerated asset
   that breaks a ledger name fails here first.
   Run with: bun test client/src/line-resolution.test.ts */
import { describe, expect, test } from "bun:test";
import {
  LEDGER_LINE_NAME_MAP,
  RIDDEN_LINE_GEOMETRIES,
} from "./assets/visited-lines";
import { buildLineKeyByName, resolveRiddenLineKey } from "./line-resolution";

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
