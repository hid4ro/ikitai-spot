/* Regression tests for the 路線 tab's two-way linkage decisions
   (事業者別 bar → ledger row, ledger row → map framing), run
   against the REAL bundled asset so a regenerated asset that
   breaks a ledger name fails here first.
   Run with: bun test client/src/line-focus.test.ts */
import { describe, expect, test } from "bun:test";
import {
  LEDGER_LINE_NAME_MAP,
  RIDDEN_LINE_GEOMETRIES,
} from "./assets/visited-lines";
import { buildLineKeyByName } from "./line-resolution";
import {
  firstLineByOperator,
  lineGeometryBounds,
  operatorOfLine,
} from "./line-focus";

const keyByName = buildLineKeyByName(RIDDEN_LINE_GEOMETRIES);
const operatorOf = (name: string) =>
  operatorOfLine(name, RIDDEN_LINE_GEOMETRIES, keyByName, LEDGER_LINE_NAME_MAP);

/* All ten rows of the ridden-lines ledger as of 2026-11-24
   (riddenLines ids 1–10), in ledger order. */
const LEDGER_ROWS = [
  { id: 1, name: "JR武蔵野線" },
  { id: 2, name: "西武池袋線" },
  { id: 3, name: "北総線" },
  { id: 4, name: "JR中央線（快速）" },
  { id: 5, name: "JR総武快速線" },
  { id: 6, name: "JR総武本線" },
  { id: 7, name: "京王線" },
  { id: 8, name: "山手線" },
  { id: 9, name: "りんかい線" },
  { id: 10, name: "JR埼京線" },
];

describe("operatorOfLine", () => {
  test("resolves each ledger row to its asset line's operator", () => {
    expect(operatorOf("JR武蔵野線")).toBe("東日本旅客鉄道");
    expect(operatorOf("西武池袋線")).toBe("西武鉄道");
    expect(operatorOf("北総線")).toBe("北総鉄道");
    expect(operatorOf("京王線")).toBe("京王電鉄");
    /* 山手線 only resolves through the ledger map (the name is
       ambiguous in the asset) — the 1391 fix the linkage builds on. */
    expect(operatorOf("山手線")).toBe("東日本旅客鉄道");
    /* りんかい線 resolves to its official name 臨海副都心線. */
    expect(operatorOf("りんかい線")).toBe("東京臨海高速鉄道");
  });

  test("JR埼京線 belongs to no operator (explicit null in the ledger map)", () => {
    expect(operatorOf("JR埼京線")).toBeNull();
  });

  test("an unknown name belongs to no operator", () => {
    expect(operatorOf("存在しない線")).toBeNull();
  });
});

describe("firstLineByOperator (the bar-tap jump target)", () => {
  const first = firstLineByOperator(
    LEDGER_ROWS,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
    LEDGER_LINE_NAME_MAP,
  );

  test("each operator's target is its FIRST row in ledger order", () => {
    /* JR East has five rows (ids 1, 4, 5, 6, 8); the bar jumps to
       the first of them, not to any later one. */
    expect(first.get("東日本旅客鉄道")?.id).toBe(1);
    expect(first.get("西武鉄道")?.id).toBe(2);
    expect(first.get("北総鉄道")?.id).toBe(3);
    expect(first.get("京王電鉄")?.id).toBe(7);
    expect(first.get("東京臨海高速鉄道")?.id).toBe(9);
  });

  test("総武快速線・総武本線 share one asset line but stay separate rows", () => {
    /* Both resolve to 「総武線|東日本旅客鉄道」; neither is JR
       East's first row, and the map keeps both rows addressable —
       the first-row map is per OPERATOR, not per asset key. */
    expect(first.size).toBe(5);
    expect([...first.values()].map((r) => r.id)).not.toContain(6);
  });

  test("the unresolved JR埼京線 is no operator's jump target", () => {
    expect([...first.values()].map((r) => r.id)).not.toContain(10);
  });

  test("ledger order decides: a reordered ledger moves the target", () => {
    const reordered = [
      { id: 6, name: "JR総武本線" },
      { id: 5, name: "JR総武快速線" },
    ];
    const m = firstLineByOperator(
      reordered,
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
      LEDGER_LINE_NAME_MAP,
    );
    expect(m.get("東日本旅客鉄道")?.id).toBe(6);
  });

  test("an empty ledger maps no operator", () => {
    expect(
      firstLineByOperator([], RIDDEN_LINE_GEOMETRIES, keyByName, LEDGER_LINE_NAME_MAP)
        .size,
    ).toBe(0);
  });
});

describe("lineGeometryBounds (the row-tap camera target)", () => {
  test("山手線's bounds frame the Tokyo loop", () => {
    const entry = RIDDEN_LINE_GEOMETRIES["山手線|東日本旅客鉄道"];
    expect(entry).toBeDefined();
    const bounds = lineGeometryBounds(entry!.geometry);
    expect(bounds).not.toBeNull();
    const [[minLng, minLat], [maxLng, maxLat]] = bounds!;
    /* The loop spans roughly lng 139.65–139.77, lat 35.63–35.75;
       assert with slack so a regenerated asset does not flap. */
    expect(minLng).toBeGreaterThan(139.6);
    expect(maxLng).toBeLessThan(139.85);
    expect(minLat).toBeGreaterThan(35.58);
    expect(maxLat).toBeLessThan(35.8);
    /* 新宿 [139.70, 35.69] sits inside the frame. */
    expect(minLng).toBeLessThan(139.7);
    expect(maxLng).toBeGreaterThan(139.7);
    expect(minLat).toBeLessThan(35.69);
    expect(maxLat).toBeGreaterThan(35.69);
  });

  test("every resolved ledger line has a usable frame", () => {
    for (const row of LEDGER_ROWS) {
      if (row.name === "JR埼京線") continue;
      const key = LEDGER_LINE_NAME_MAP[row.name];
      const entry = key ? RIDDEN_LINE_GEOMETRIES[key] : undefined;
      /* 京王線 is not in the ledger map; it resolves by name. */
      const geometry =
        entry?.geometry ??
        RIDDEN_LINE_GEOMETRIES["京王線|京王電鉄"]?.geometry;
      expect(geometry).toBeDefined();
      const bounds = lineGeometryBounds(geometry!);
      expect(bounds).not.toBeNull();
      const [[minLng, minLat], [maxLng, maxLat]] = bounds!;
      expect(maxLng).toBeGreaterThan(minLng);
      expect(maxLat).toBeGreaterThan(minLat);
    }
  });

  test("an empty geometry has no frame", () => {
    expect(
      lineGeometryBounds({ type: "MultiLineString", coordinates: [] }),
    ).toBeNull();
    expect(
      lineGeometryBounds({ type: "MultiLineString", coordinates: [[]] }),
    ).toBeNull();
  });
});
