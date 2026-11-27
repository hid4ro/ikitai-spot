/* Tests for the temporary-display lists (subtask 1623).
   Run with: bun test client/src/unridden-lists.test.ts */
import { describe, expect, test } from "bun:test";
import type { GeoJsonGeometry } from "./geojson";
import type { LineCoverage, LineGeometryMap } from "./line-geometry";
import {
  groupUnriddenLinesByOperator,
  groupUnvisitedByPrefecture,
  unriddenFormalLines,
  unvisitedMunicipalities,
  type UnriddenFormalLine,
} from "./unridden-lists";

const polygon = (x: number): GeoJsonGeometry =>
  ({
    type: "Polygon",
    coordinates: [
      [
        [x, 0],
        [x + 1, 0],
        [x + 1, 1],
        [x, 1],
        [x, 0],
      ],
    ],
  }) as unknown as GeoJsonGeometry;

/* A coverage whose only painted leg is one 中央線 leg: the
   minimal shape unriddenFormalLines reads (perServiceLegs). */
function coverageWithLegs(
  legs: { key: string; coords: readonly [number, number][] }[],
): LineCoverage {
  return {
    perService: new Map(),
    perServiceLegs: new Map([
      ["jr-chuo", { legs: legs as never, unknown: false }],
    ]),
    perServiceUnriddenLegs: new Map(),
    perKeyKm: new Map(),
    perOperatorKm: new Map(),
    networkRiddenKm: 0,
    completeServiceIds: [],
    unpreparedLines: 0,
  } as unknown as LineCoverage;
}

const GEOMETRIES = {
  "中央線|東日本旅客鉄道": {
    name: "中央線",
    operator: "東日本旅客鉄道",
    color: "#F15A22",
    geometry: { type: "MultiLineString", coordinates: [] },
  },
  "山手線|東日本旅客鉄道": {
    name: "山手線",
    operator: "東日本旅客鉄道",
    color: "#80C241",
    geometry: { type: "MultiLineString", coordinates: [] },
  },
  "京王線|京王電鉄": {
    name: "京王線",
    operator: "京王電鉄",
    color: "#E60012",
    geometry: { type: "MultiLineString", coordinates: [] },
  },
} as unknown as LineGeometryMap;

describe("unriddenFormalLines (subtask 1623)", () => {
  test("a line with a painted leg is ridden; the rest list with name, operator, color and total", () => {
    const lines = unriddenFormalLines(
      coverageWithLegs([
        { key: "中央線|東日本旅客鉄道", coords: [[139.7, 35.68], [139.8, 35.68]] },
      ]),
      GEOMETRIES,
    );
    expect(lines.map((l) => l.key)).toEqual([
      "山手線|東日本旅客鉄道",
      "京王線|京王電鉄",
    ]);
    const yamanote = lines.find((l) => l.key === "山手線|東日本旅客鉄道")!;
    expect(yamanote.name).toBe("山手線");
    expect(yamanote.operator).toBe("東日本旅客鉄道");
    expect(yamanote.color).toBe("#80C241");
    /* The totals table carries the real 山手線 length. */
    expect(yamanote.totalKm).toBeGreaterThan(0);
  });

  test("an unknown ride paints its whole path, so its line stays out", () => {
    const coverage = coverageWithLegs([
      { key: "山手線|東日本旅客鉄道", coords: [[139.7, 35.68], [139.8, 35.68]] },
    ]);
    (coverage.perServiceLegs.get("jr-chuo") as { unknown: boolean }).unknown =
      true;
    const lines = unriddenFormalLines(coverage, GEOMETRIES);
    expect(lines.map((l) => l.key)).not.toContain(
      "山手線|東日本旅客鉄道",
    );
  });

  test("no painted legs lists every line", () => {
    const lines = unriddenFormalLines(
      coverageWithLegs([]),
      GEOMETRIES,
    );
    expect(lines).toHaveLength(3);
  });
});

describe("groupUnriddenLinesByOperator", () => {
  const line = (
    key: string,
    name: string,
    operator: string,
  ): UnriddenFormalLine => ({
    key,
    name,
    operator,
    color: "#000000",
    totalKm: 10,
  });

  test("groups by operator, bigger groups first, rows by name", () => {
    const groups = groupUnriddenLinesByOperator([
      line("a|京王電鉄", "京王線", "京王電鉄"),
      line("b|東日本旅客鉄道", "中央線", "東日本旅客鉄道"),
      line("c|東日本旅客鉄道", "山手線", "東日本旅客鉄道"),
      line("d|東日本旅客鉄道", "総武線", "東日本旅客鉄道"),
    ]);
    expect(groups.map((g) => g.operator)).toEqual([
      "東日本旅客鉄道",
      "京王電鉄",
    ]);
    expect(groups[0]!.lines.map((l) => l.name)).toEqual([
      /* localeCompare("ja") sorts by reading: やまのて、そうぶ、ちゅうおう. */
      "山手線",
      "総武線",
      "中央線",
    ]);
  });
});

describe("unvisitedMunicipalities (subtask 1623)", () => {
  test("boundary keys minus the ledger, split into prefecture and name", () => {
    const rows = unvisitedMunicipalities(
      new Set(["東京都|府中市"]),
      new Map([
        ["東京都|府中市", polygon(139.4)],
        ["東京都|調布市", polygon(139.5)],
        ["埼玉県|さいたま市", polygon(139.6)],
      ]),
    );
    expect(rows).toEqual([
      { prefecture: "東京都", name: "調布市", geometry: polygon(139.5) },
      { prefecture: "埼玉県", name: "さいたま市", geometry: polygon(139.6) },
    ]);
  });

  test("a non-Tokyo 区 name is skipped, a Tokyo ward is kept", () => {
    const rows = unvisitedMunicipalities(
      new Set(),
      new Map([
        ["大阪府|北区", polygon(135.5)],
        ["東京都|北区", polygon(139.7)],
      ]),
    );
    expect(rows.map((r) => `${r.prefecture}|${r.name}`)).toEqual([
      "東京都|北区",
    ]);
  });

  test("a key without a separator is skipped", () => {
    const rows = unvisitedMunicipalities(
      new Set(),
      new Map([["no-separator", polygon(0)]]),
    );
    expect(rows).toEqual([]);
  });
});

describe("groupUnvisitedByPrefecture", () => {
  test("prefectures in manifest order, rows by name, totals attached", () => {
    const groups = groupUnvisitedByPrefecture(
      [
        { prefecture: "埼玉県", name: "川越市", geometry: polygon(139.4) },
        { prefecture: "東京都", name: "調布市", geometry: polygon(139.5) },
        { prefecture: "埼玉県", name: "朝霞市", geometry: polygon(139.6) },
      ],
      ["北海道", "埼玉県", "東京都"],
      new Map([
        ["埼玉県", 63],
        ["東京都", 62],
      ]),
    );
    expect(groups.map((g) => g.prefecture)).toEqual(["埼玉県", "東京都"]);
    expect(groups[0]!.total).toBe(63);
    expect(groups[0]!.rows.map((r) => r.name)).toEqual([
      /* localeCompare("ja") sorts by reading: かわごえ、あさか. */
      "川越市",
      "朝霞市",
    ]);
    expect(groups[1]!.total).toBe(62);
  });

  test("a prefecture missing from the order appends in first-appearance order", () => {
    const groups = groupUnvisitedByPrefecture(
      [
        { prefecture: "沖縄県", name: "那覇市", geometry: polygon(127.6) },
        { prefecture: "東京都", name: "調布市", geometry: polygon(139.5) },
      ],
      ["東京都"],
    );
    expect(groups.map((g) => g.prefecture)).toEqual(["東京都", "沖縄県"]);
    expect(groups[1]!.total).toBeNull();
  });
});
