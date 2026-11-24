/* Regression tests for the 路線 tab's two-way linkage decisions
   (事業者別 bar → ledger row, ledger row → map framing), run
   against the REAL bundled asset so a regenerated asset that
   breaks a ledger name fails here first. Operators resolve through
   the service master (shared/service-master.ts).
   Run with: bun test client/src/line-focus.test.ts */
import { describe, expect, test } from "bun:test";
import type { RiddenServiceLink } from "../../shared/service-master";
import { RIDDEN_LINE_GEOMETRIES } from "./assets/visited-lines";
import { buildLineKeyByName, resolveRiddenLineKey } from "./line-resolution";
import {
  firstLineByOperator,
  groupLinesByOperator,
  lineGeometryBounds,
  operatorOfLine,
  UNKNOWN_OPERATOR_GROUP,
} from "./line-focus";

const keyByName = buildLineKeyByName(RIDDEN_LINE_GEOMETRIES);
const operatorOf = (line: string | RiddenServiceLink) =>
  operatorOfLine(line, RIDDEN_LINE_GEOMETRIES, keyByName);

/* The nine rows of the live ridden-lines ledger (listRiddenLines,
   ids 1, 3–10), in ledger order. */
const LEDGER_ROWS = [
  { id: 1, name: "JR武蔵野線" },
  { id: 3, name: "北総線" },
  { id: 4, name: "JR中央線（快速）" },
  { id: 5, name: "JR総武快速線" },
  { id: 6, name: "JR総武本線" },
  { id: 7, name: "京王線" },
  { id: 8, name: "JR埼京線" },
  { id: 9, name: "りんかい線" },
  { id: 10, name: "山手線" },
];

describe("operatorOfLine", () => {
  test("resolves each ledger row to its service's operator", () => {
    expect(operatorOf("JR武蔵野線")).toBe("東日本旅客鉄道");
    expect(operatorOf("北総線")).toBe("北総鉄道");
    expect(operatorOf("京王線")).toBe("京王電鉄");
    /* 山手線 only resolves through the master (the name is
       ambiguous in the asset) — the 1391 fix the linkage builds on. */
    expect(operatorOf("山手線")).toBe("東日本旅客鉄道");
    /* りんかい線 resolves to its official name 臨海副都心線. */
    expect(operatorOf("りんかい線")).toBe("東京臨海高速鉄道");
    /* The formal name is the same service's alias in the master. */
    expect(operatorOf("臨海副都心線")).toBe("東京臨海高速鉄道");
    /* JR埼京線 belongs to JR East via the master, even though it
       has no single asset line. */
    expect(operatorOf("JR埼京線")).toBe("東日本旅客鉄道");
  });

  test("an explicit saved link can still identify the operator after a name mismatch", () => {
    const row = { name: "りんかい線（仮）", serviceId: "rinkai" };
    expect(operatorOf(row)).toBeNull();
    expect(operatorOf({ ...row, serviceLinkSource: "explicit" })).toBe("東京臨海高速鉄道");
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
  );

  test("each operator's target is its FIRST row in ledger order", () => {
    /* JR East has six rows (ids 1, 4, 5, 6, 8, 10); the bar jumps
       to the first of them, not to any later one. */
    expect(first.get("東日本旅客鉄道")?.id).toBe(1);
    expect(first.get("北総鉄道")?.id).toBe(3);
    expect(first.get("京王電鉄")?.id).toBe(7);
    expect(first.get("東京臨海高速鉄道")?.id).toBe(9);
  });

  test("総武快速線・総武本線 share one asset line but stay separate rows", () => {
    /* Both resolve to 「総武線|東日本旅客鉄道」; neither is JR
       East's first row, and the map keeps both rows addressable —
       the first-row map is per OPERATOR, not per asset key. */
    expect(first.size).toBe(4);
    expect([...first.values()].map((r) => r.id)).not.toContain(6);
  });

  test("JR埼京線 is a jump target through its operator, not its track", () => {
    /* It belongs to JR East, but it is not JR East's first row
       (武蔵野線 id 1 is), so the bar still jumps to id 1. */
    expect(first.get("東日本旅客鉄道")?.id).toBe(1);
    expect([...first.values()].map((r) => r.id)).not.toContain(8);
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
    );
    expect(m.get("東日本旅客鉄道")?.id).toBe(6);
  });

  test("a saved link pending review cannot be the operator's target", () => {
    const rows = [
      { id: 11, name: "中央線（各駅停車）", serviceId: "jr-chuo-rapid" },
      { id: 12, name: "JR中央線（快速）", serviceId: "jr-chuo-rapid" },
    ];
    const targets = firstLineByOperator(rows, RIDDEN_LINE_GEOMETRIES, keyByName);
    expect(targets.get("東日本旅客鉄道")?.id).toBe(12);
  });

  test("an empty ledger maps no operator", () => {
    expect(
      firstLineByOperator([], RIDDEN_LINE_GEOMETRIES, keyByName).size,
    ).toBe(0);
  });
});

describe("groupLinesByOperator (the 路線 tab's operator groups)", () => {
  const groups = groupLinesByOperator(
    LEDGER_ROWS,
    RIDDEN_LINE_GEOMETRIES,
    keyByName,
  );

  test("groups appear in first-appearance order, rows in ledger order", () => {
    expect(groups.map((g) => g.operator)).toEqual([
      "東日本旅客鉄道",
      "北総鉄道",
      "京王電鉄",
      "東京臨海高速鉄道",
    ]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual([1, 4, 5, 6, 8, 10]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual([3]);
  });

  test("an unresolvable row lands in the 事業者不明 group, last", () => {
    const withUnknown = groupLinesByOperator(
      [...LEDGER_ROWS, { id: 99, name: "存在しない線" }],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    const last = withUnknown[withUnknown.length - 1]!;
    expect(last.operator).toBe(UNKNOWN_OPERATOR_GROUP);
    expect(last.rows.map((r) => r.id)).toEqual([99]);
  });

  test("a row whose link is pending review groups as 事業者不明", () => {
    /* Same rule as operatorOfLine: an unconfirmed auto link
       names no operator, so the row cannot file itself under
       the operator it merely guesses at. */
    const review = groupLinesByOperator(
      [{ id: 11, name: "中央線（各駅停車）", serviceId: "jr-chuo-rapid" }],
      RIDDEN_LINE_GEOMETRIES,
      keyByName,
    );
    expect(review).toHaveLength(1);
    expect(review[0]!.operator).toBe(UNKNOWN_OPERATOR_GROUP);
  });

  test("an empty ledger groups to nothing", () => {
    expect(groupLinesByOperator([], RIDDEN_LINE_GEOMETRIES, keyByName)).toEqual([]);
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

  test("every single-key ledger line has a usable frame", () => {
    for (const row of LEDGER_ROWS) {
      // JR埼京線 has no single key (it expands to four lines) and
      // 山手線 none either since the loop split (three keys);
      // stage 2 frames their ridden sections instead.
      if (row.name === "JR埼京線" || row.name === "山手線") continue;
      const key = resolveRiddenLineKey(row.name, RIDDEN_LINE_GEOMETRIES, keyByName);
      expect(key).not.toBeNull();
      const entry = key ? RIDDEN_LINE_GEOMETRIES[key] : undefined;
      expect(entry).toBeDefined();
      const bounds = lineGeometryBounds(entry!.geometry);
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
