/* The service master （系統マスタ） for the ridden-lines ledger.
 *
 * Agreed at the 2026-11-24 four-party meeting (see
 * ~/workspace/goals/goal-2/files/line_division_meeting_minutes_20261124.md):
 * a service （運行系統, e.g. JR埼京線） is NOT a formal line. The master
 * is the translation layer between the two: each service lists, in
 * order, the formal (N02) lines it runs on, with the stations where
 * it enters and leaves each one. The map overlay and the aggregates
 * work from the formal lines; every displayed name stays the service
 * name (per the user's display rule: 表の名前は全部系統名、正式線名は
 * 裏側の計算と保存だけに使う）.
 *
 * The master is built lazily: only services actually ridden get an
 * entry. All entries start as drafts (verification_status "draft",
 * verified_at null) — a draft only becomes "verified" once a human
 * has checked it against the map. Nothing here is generated from
 * N02: the station order and the service extents are hand-recorded
 * and must be reviewed when a new service is added.
 *
 * Station identity is the N02 station group code (N02_005g): one code
 * per physical station, shared by every line serving it （新宿 =
 * 003700 on 山手線・中央線・京王線 alike; 同名の別駅は別コード）.
 * The name rides along for display; the code is the identity. A
 * ride's section is stored as a pair of station codes, never as a
 * share of the line shape (a share would drift when the shape is
 * re-simplified or the source changes).
 *
 * Stage 2 (subtask 1421) adds the input blocks (each service is
 * partitioned into blocks between boundary stations), the station
 * coordinates (N02 station-point centroids, used to project a
 * section onto the line shape and so to paint only the ridden
 * section and measure its distance), and the path id (a full
 * ride's snapshot keeps the path id + master version it was cut
 * at, so a past full ride reproduces its range even if the master
 * later changes).
 *
 * Shared by the client (display, resolution, expansion) and the
 * server (import defaults for new ledger rows), so it lives in
 * shared/ and stays free of DOM / platform imports. */

export type RideState = "unknown" | "partial" | "full";

export type VerificationStatus = "draft" | "verified";

/* One station, by N02 station group code (N02_005g) and name.
   lng/lat is the station's N02 station-point centroid (the mean of
   the station's N02_005 feature geometries, 5 decimals) — the point
   the stage-2 geometry code projects onto the line shape to find
   where a section starts and ends. It is a point ON the station,
   not the station building: spreads between a station's per-line
   features are at most ~300 m (新宿), so a section endpoint
   projects onto its line within a few hundred metres; a larger
   projection distance means the shape itself is missing there
   （東京 on 中央線 — the shape starts at 神田）, and the section
   is flagged approximate. */
export type StationRef = {
  id: string;
  name: string;
  lng: number;
  lat: number;
};

/* One block of a service (stage 2): the input granularity for
   long services. A block is a contiguous run of the service
   between two boundary stations; blocks partition the service in
   running order, so a ride recorded block by block accumulates
   into whole-service coverage without ever storing a share of the
   line shape. The endpoints are station IDs — the saved record —
   and the geometry/distance are derived at draw time. `direction`
   only loop services carry: it says which side of the loop the
   block runs on. */
export type ServiceBlock = {
  id: string;
  from: StationRef;
  to: StationRef;
  direction?: "inner" | "outer";
};

/* An N02 station group code is six digits — the only station
   identity this codebase carries (see the "station ids are
   six-digit N02 group codes" test). A partial ride's endpoints must
   be codes in this shape; anything else ("bad", a name, a blank)
   is not a station and must be rejected at save time (review round
   2, high). This checks the shape, not membership in the full N02
   station table — no such table is bundled — so a well-formed but
   nonexistent code is still possible; the master itself is the
   reference for real stations. */
export function isN02StationId(id: string): boolean {
  return /^\d{6}$/.test(id);
}

/* One stretch of a service: the formal line it runs on between two
   stations. `formalLineKey` is the asset key "路線名|運営会社" in
   RIDDEN_LINE_GEOMETRIES. */
export type ServiceSegment = {
  formalLineName: string;
  formalLineKey: string;
  from: StationRef;
  to: StationRef;
  /* True when the geometry behind this segment is a stand-in rather
     than the line itself — any distance drawn from it is an
     approximation, and the segment must be recorded as such. */
  approximate?: boolean;
  /* Which side of a loop line this segment runs on ("inner" =
     内回り, "outer" = 外回り). Only loop services carry it; stage 2
     uses it to tell which side of the loop a ride took. */
  direction?: "inner" | "outer";
  note?: string;
};

export type ServiceMasterEntry = {
  /* Stable id for the service, used as the ledger rows' service_id. */
  id: string;
  /* The path this entry describes, as recorded at stage 2: the
     service id names the path (one path per service for now — a
     loop's two sides are the same path run in opposite directions,
     told apart by the segment/block `direction`). A full ride's
     snapshot stores this id with the master version, so a past
     full ride keeps reproducing the range it was recorded at even
     if the master later changes. */
  pathId: string;
  /* The name as ridden and as the ledger records it — the display
     name everywhere (台帳・リスト・凡例・グラフ). */
  displayName: string;
  /* Ledger spellings that mean this service; the first is canonical.
     Aliases cover spellings the ledger has used （「JR中央線」 for the
     rapid service). */
  ledgerNames: string[];
  /* The operator of the service (all of its segments share one). */
  operator: string;
  /* The formal lines, in running order. */
  segments: ServiceSegment[];
  /* The stage-2 input blocks, in running order: a partition of
     the service between boundary stations (see ServiceBlock).
     Single-block services (りんかい線・北総線) have one block =
     the whole service. */
  blocks: ServiceBlock[];
  /* Where this entry came from (N02 edition, ledger notes, …). */
  sources: string[];
  /* YYYY-MM-DD once a human has verified the entry; null while draft. */
  verifiedAt: string | null;
  verificationStatus: VerificationStatus;
  note?: string;
};

/* Bump when any entry's segments change. Full rides keep the version
   they were recorded at, so a later extension never silently claims
   a stretch the rider never rode. */
export const SERVICE_MASTER_VERSION = "2026-11-24";

const N02_SOURCE = "国土数値情報「鉄道データ」N02（2025年度版）";
const LEDGER_SOURCE = "location-trivia/seen_lines.md（台帳の乗車記録）";

export const SERVICE_MASTER: readonly ServiceMasterEntry[] = [
  {
    id: "jr-musashino",
    pathId: "jr-musashino",
    displayName: "JR武蔵野線",
    ledgerNames: ["JR武蔵野線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "003876", name: "府中本町", lng: 139.47718, lat: 35.66583 },
        to: { id: "003547", name: "西船橋", lng: 139.95907, lat: 35.70737 },
      },
    ],
    blocks: [
      {
        id: "jr-musashino/b1",
        from: { id: "003876", name: "府中本町", lng: 139.47718, lat: 35.66583 },
        to: { id: "003004", name: "南浦和", lng: 139.66878, lat: 35.84796 },
      },
      {
        id: "jr-musashino/b2",
        from: { id: "003004", name: "南浦和", lng: 139.66878, lat: 35.84796 },
        to: { id: "003547", name: "西船橋", lng: 139.95907, lat: 35.70737 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "hokuso",
    pathId: "hokuso",
    displayName: "北総線",
    ledgerNames: ["北総線"],
    operator: "北総鉄道",
    segments: [
      {
        formalLineName: "北総線",
        formalLineKey: "北総線|北総鉄道",
        from: { id: "003248", name: "京成高砂", lng: 139.86659, lat: 35.75087 },
        to: { id: "003125", name: "印旛日本医大", lng: 140.20276, lat: 35.78782 },
      },
    ],
    blocks: [
      {
        id: "hokuso/b1",
        from: { id: "003248", name: "京成高砂", lng: 139.86659, lat: 35.75087 },
        to: { id: "003125", name: "印旛日本医大", lng: 140.20276, lat: 35.78782 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-chuo-rapid",
    pathId: "jr-chuo-rapid",
    displayName: "JR中央線（快速）",
    ledgerNames: ["JR中央線（快速）", "JR中央線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "中央線",
        formalLineKey: "中央線|東日本旅客鉄道",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "003677", name: "神田", lng: 139.77088, lat: 35.69242 },
        approximate: true,
        note:
          "N02の中央線形状は神田で途切れる（形状の東端は神田付近で、東京駅から約1.1km）。東京〜神田は運行区間として明示するが、N02に形状が無いため描画・距離は神田以西の形状に限る（近似）。神田のグループコード003677はN02の（神田, 中央線）行で確認済み。",
      },
      {
        formalLineName: "中央線",
        formalLineKey: "中央線|東日本旅客鉄道",
        from: { id: "003677", name: "神田", lng: 139.77088, lat: 35.69242 },
        to: { id: "004029", name: "高尾", lng: 139.28217, lat: 35.64202 },
        note:
          "快速の運行範囲は東京〜高尾。N02の中央線単位はさらに先（塩尻方面）まで延びるが、快速としてはここまで。なおN02の駅ポイントに（東京, 中央線）の行は無い（東京駅のグループコード003766は他のJR線の行で確認済み）。駅IDは物理駅のコードであり、中央線が東京駅に発着することに変わりはない。",
      },
    ],
    blocks: [
      {
        id: "jr-chuo-rapid/b1",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
      },
      {
        id: "jr-chuo-rapid/b2",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003634", name: "立川", lng: 139.41396, lat: 35.69793 },
      },
      {
        id: "jr-chuo-rapid/b3",
        from: { id: "003634", name: "立川", lng: 139.41396, lat: 35.69793 },
        to: { id: "004029", name: "高尾", lng: 139.28217, lat: 35.64202 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-sobu-rapid",
    pathId: "jr-sobu-rapid",
    displayName: "JR総武快速線",
    ledgerNames: ["JR総武快速線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "総武線",
        formalLineKey: "総武線|東日本旅客鉄道",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
      },
    ],
    blocks: [
      {
        id: "jr-sobu-rapid/b1",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "003589", name: "船橋", lng: 139.98422, lat: 35.70195 },
      },
      {
        id: "jr-sobu-rapid/b2",
        from: { id: "003589", name: "船橋", lng: 139.98422, lat: 35.70195 },
        to: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-sobu-local",
    pathId: "jr-sobu-local",
    displayName: "JR総武本線",
    ledgerNames: ["JR総武本線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "総武線",
        formalLineKey: "総武線|東日本旅客鉄道",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "003397", name: "銚子", lng: 140.82747, lat: 35.72933 },
      },
    ],
    blocks: [
      {
        id: "jr-sobu-local/b1",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
      },
      {
        id: "jr-sobu-local/b2",
        from: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
        to: { id: "003531", name: "佐倉", lng: 140.22675, lat: 35.70974 },
      },
      {
        id: "jr-sobu-local/b3",
        from: { id: "003531", name: "佐倉", lng: 140.22675, lat: 35.70974 },
        to: { id: "003397", name: "銚子", lng: 140.82747, lat: 35.72933 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "keio",
    pathId: "keio",
    displayName: "京王線",
    ledgerNames: ["京王線"],
    operator: "京王電鉄",
    segments: [
      {
        formalLineName: "京王線",
        formalLineKey: "京王線|京王電鉄",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003934", name: "京王八王子", lng: 139.34298, lat: 35.65805 },
      },
    ],
    blocks: [
      {
        id: "keio/b1",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003966", name: "調布", lng: 139.54474, lat: 35.65177 },
      },
      {
        id: "keio/b2",
        from: { id: "003966", name: "調布", lng: 139.54474, lat: 35.65177 },
        to: { id: "003821", name: "府中", lng: 139.4801, lat: 35.67219 },
      },
      {
        id: "keio/b3",
        from: { id: "003821", name: "府中", lng: 139.4801, lat: 35.67219 },
        to: { id: "003934", name: "京王八王子", lng: 139.34298, lat: 35.65805 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-saikyo",
    pathId: "jr-saikyo",
    displayName: "JR埼京線",
    ledgerNames: ["JR埼京線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "山手線",
        formalLineKey: "山手線|東日本旅客鉄道",
        from: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
        to: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        approximate: true,
        direction: "outer",
        note:
          "山手貨物線の区間。N02 2025に貨物線の路線単位が無いため山手線（旅客）の形状で代用し、概算として扱う。外回り側（大崎→五反田→目黒→渋谷→新宿→池袋）を通る。",
      },
      {
        formalLineName: "赤羽線",
        formalLineKey: "赤羽線|東日本旅客鉄道",
        from: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        to: { id: "003155", name: "赤羽", lng: 139.72105, lat: 35.77754 },
      },
      {
        formalLineName: "東北線",
        formalLineKey: "東北線|東日本旅客鉄道",
        from: { id: "003155", name: "赤羽", lng: 139.72105, lat: 35.77754 },
        to: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        note: "通称・東北本線。N02の路線単位名は東北線。",
      },
      {
        formalLineName: "川越線",
        formalLineKey: "川越線|東日本旅客鉄道",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "002909", name: "川越", lng: 139.48307, lat: 35.90705 },
      },
    ],
    blocks: [
      {
        id: "jr-saikyo/b1",
        from: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
        to: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        direction: "outer",
      },
      {
        id: "jr-saikyo/b2",
        from: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        to: { id: "003155", name: "赤羽", lng: 139.72105, lat: 35.77754 },
      },
      {
        id: "jr-saikyo/b3",
        from: { id: "003155", name: "赤羽", lng: 139.72105, lat: 35.77754 },
        to: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
      },
      {
        id: "jr-saikyo/b4",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "002909", name: "川越", lng: 139.48307, lat: 35.90705 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note:
      "N02 2025に埼京線の路線単位は存在しない（区間データに「埼京」の文字列自体が無い）。合成ジオメトリは作らず、4つの正式線への展開で扱う。",
  },
  {
    id: "rinkai",
    pathId: "rinkai",
    displayName: "りんかい線",
    /* The formal name 臨海副都心線 is a ledger spelling too — a row
       recorded under it is the same service, so it must link to
       this entry (and count once with りんかい線) rather than
       resolving as a separate line. */
    ledgerNames: ["りんかい線", "臨海副都心線"],
    operator: "東京臨海高速鉄道",
    segments: [
      {
        formalLineName: "臨海副都心線",
        formalLineKey: "臨海副都心線|東京臨海高速鉄道",
        from: { id: "003997", name: "新木場", lng: 139.82668, lat: 35.64587 },
        to: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
      },
    ],
    blocks: [
      {
        id: "rinkai/b1",
        from: { id: "003997", name: "新木場", lng: 139.82668, lat: 35.64587 },
        to: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "yamanote",
    pathId: "yamanote",
    displayName: "山手線",
    ledgerNames: ["山手線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "山手線",
        formalLineKey: "山手線|東日本旅客鉄道",
        from: { id: "004095", name: "品川", lng: 139.73896, lat: 35.62851 },
        to: { id: "003335", name: "田端", lng: 139.76157, lat: 35.73748 },
        direction: "outer",
        note:
          "環状線の外回り側（品川→大崎→渋谷→新宿→池袋→田端）。田端のグループコード003335はN02の（田端, 山手線）行で確認済み。",
      },
      {
        formalLineName: "東北線",
        formalLineKey: "東北線|東日本旅客鉄道",
        from: { id: "003335", name: "田端", lng: 139.76157, lat: 35.73748 },
        to: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        direction: "outer",
        note: "通称・東北本線。N02の路線単位名は東北線。",
      },
      {
        formalLineName: "東海道線",
        formalLineKey: "東海道線|東日本旅客鉄道",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "004095", name: "品川", lng: 139.73896, lat: 35.62851 },
        direction: "outer",
      },
    ],
    blocks: [
      {
        id: "yamanote/b1",
        from: { id: "004095", name: "品川", lng: 139.73896, lat: 35.62851 },
        to: { id: "003922", name: "渋谷", lng: 139.70165, lat: 35.65898 },
        direction: "outer",
      },
      {
        id: "yamanote/b2",
        from: { id: "003922", name: "渋谷", lng: 139.70165, lat: 35.65898 },
        to: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        direction: "outer",
      },
      {
        id: "yamanote/b3",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        direction: "outer",
      },
      {
        id: "yamanote/b4",
        from: { id: "003390", name: "池袋", lng: 139.71108, lat: 35.72981 },
        to: { id: "003335", name: "田端", lng: 139.76157, lat: 35.73748 },
        direction: "outer",
      },
      {
        id: "yamanote/b5",
        from: { id: "003335", name: "田端", lng: 139.76157, lat: 35.73748 },
        to: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        direction: "outer",
      },
      {
        id: "yamanote/b6",
        from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
        to: { id: "004095", name: "品川", lng: 139.73896, lat: 35.62851 },
        direction: "outer",
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note: "環状線のため3区間で一周を表す（品川→田端→東京→品川、外回り）。移行した乗車（大崎→目黒）は外回りの観測順で、端点はそのまま使える。",
  },
];

export function serviceById(id: string): ServiceMasterEntry | undefined {
  return SERVICE_MASTER.find((entry) => entry.id === id);
}

/* A station of the master by its N02 group code, with the
   coordinates the stage-2 geometry code needs: the client
   resolves a ledger row's stored station ids through this (its
   primary section carries ids and names, but no coordinates),
   and the server fills in station names for an added section.
   Segments carry every terminus, blocks every boundary, and
   the migrated rides carry their restored endpoints （国分寺・
   聖蹟桜ヶ丘・品川シーサイド・目黒 are no block boundary) — all
   three are searched, first match wins. One code names one
   physical station, wherever it appears, so the matches agree. */
export function stationRefById(stationId: string): StationRef | undefined {
  for (const entry of SERVICE_MASTER) {
    for (const segment of entry.segments) {
      if (segment.from.id === stationId) return segment.from;
      if (segment.to.id === stationId) return segment.to;
    }
    for (const block of entry.blocks) {
      if (block.from.id === stationId) return block.from;
      if (block.to.id === stationId) return block.to;
    }
  }
  for (const ride of Object.values(MIGRATED_RIDES)) {
    if (ride.from?.id === stationId) return ride.from;
    if (ride.to?.id === stationId) return ride.to;
  }
  return undefined;
}

/* Half-width parentheses and the spaces around them are the same
   qualifier shape as the full-width form: 「武蔵野線 (JR東日本)」
   is the same spelling as 「武蔵野線（JR東日本）」 (review round 4,
   low). The spaces INSIDE the parentheses are the same shape too:
   「中央線 ( 快速 )」 is 「中央線（快速）」 (review round 5, low)
   — only the padding goes, the identifying word inside is kept.
   Only the shape is normalized here; whether the qualifier itself
   is dropped is decided by isRedundantQualifierFor below.
   Exported so the map fallback (client/src/line-resolution.ts)
   unifies the same shapes before it strips a note (review round
   5, low). */
export function normalizeParentheses(name: string): string {
  return name
    .trim()
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/[ 　]+（/g, "（")
    .replace(/）[ 　]+/g, "）")
    .replace(/（[ 　]+/g, "（")
    .replace(/[ 　]+）/g, "）");
}

/* A ledger name with no parenthetical handling — trim and a leading
   JR / ＪＲ operator prefix only. Used inside the redundancy check
   so it never recurses into canonicalLedgerName. */
function bareLedgerName(name: string): string {
  return name.trim().replace(/^(?:JR|ＪＲ)/, "");
}

/* Whether a trailing （…） qualifier is redundant FOR ONE
   CANDIDATE entry — i.e. dropping it cannot change which service
   the name means. Two shapes count, both scoped to the candidate
   the rest of the name already names (review round 5, medium —
   round 4 scoped the check to "the same service's name or an
   operator name" but still asked ANY entry in the master, so
   「総武本線（総武快速線）」 dropped its qualifier because
   「総武快速線」 is a ledger spelling somewhere, and
   「武蔵野線（京王電鉄）」 dropped it because 京王電鉄 is some
   entry's operator):
   (a) the qualifier names the candidate itself, by its display
       name or one of its ledger spellings （「臨海副都心線
       （りんかい線）」 — 「りんかい線」 is rinkai's own name);
   (b) the qualifier names the candidate's operator （「武蔵野線
       (JR東日本)」 — the company abbreviation counts: a leading
       JR is stripped and the rest must start the operator's name,
       so 「東日本」 matches 東日本旅客鉄道).
   Anything else — 「快速」, 「各駅停車」, another service's name,
   another operator's name — tells services apart (or contradicts
   the candidate) and is kept: 「総武本線（総武快速線）」 and
   「武蔵野線（京王電鉄）」 stay unlinked rather than attaching
   to the wrong service. */
function isRedundantQualifierFor(
  content: string,
  candidate: ServiceMasterEntry,
): boolean {
  const q = content.trim();
  if (!q) return false;
  const names = [candidate.displayName, ...candidate.ledgerNames];
  if (names.some((n) => bareLedgerName(n) === bareLedgerName(q))) {
    return true;
  }
  const company = q.replace(/^(?:JR|ＪＲ)/, "");
  if (!company) return false;
  return (
    candidate.operator.startsWith(company) ||
    company.startsWith(candidate.operator)
  );
}

/* Canonical form for ledger-name lookup: trims, unifies half-width
   parentheses, drops a REDUNDANT trailing （…） qualifier, and
   drops a leading JR / ＪＲ operator prefix. "JR武蔵野線" and
   "武蔵野線" are the same service (review round 3: the JR-less
   spelling registered with serviceId null and double-counted its
   operator 2/1, because the map side already strips the JR prefix
   while the master lookup did not). Only the lookup is normalized;
   the recorded name itself is untouched.
   The qualifier is dropped only when it is redundant FOR THE
   CANDIDATE the outer part already names (see
   isRedundantQualifierFor): the candidate is found from the part
   before the qualifier, and the qualifier must name that
   candidate's own alias or its own operator. Round 4's version
   asked whether the qualifier named ANY service or ANY operator in
   the master, which let a contradicting qualifier through
   (review round 5): 「総武本線（総武快速線）」 dropped
   「総武快速線」 because it is a ledger spelling somewhere, and
   「武蔵野線（京王電鉄）」 dropped 「京王電鉄」 because it is
   some entry's operator — both attached to the wrong service.
   Exported for the uniqueness test: two entries must never
   canonicalize to the same key, or a JR-less spelling could attach
   to the wrong service. */
export function canonicalLedgerName(name: string): string {
  const unified = normalizeParentheses(name).replace(/^(?:JR|ＪＲ)/, "");
  const m = unified.match(/（([^）]*)）$/);
  if (!m) return unified;
  const outer = unified.slice(0, m.index);
  const candidate = SERVICE_MASTER.find((entry) =>
    [entry.displayName, ...entry.ledgerNames].some(
      (n) => bareLedgerName(n) === bareLedgerName(outer),
    ),
  );
  if (candidate && isRedundantQualifierFor(m[1]!, candidate)) {
    return outer;
  }
  return unified;
}

/* The pre-round-4 lookup (commits 141eacb–6ab413a), kept to
   recognize the links it produced: the trailing （…） was dropped
   unconditionally and the leading JR stripped, so
   「中央線（各駅停車）」 attached to jr-chuo-rapid and
   「総武本線（総武快速線）」 to jr-sobu-local. Half-width
   parentheses were not unified then, so a half-width spelling
   resolved to nothing. The structure mirrors the old
   serviceByLedgerName exactly (exact match, stripped match,
   canonical match) so the reproduction is faithful, not a guess. */
function legacyCanonicalLedgerName(name: string): string {
  return name
    .trim()
    .replace(/（[^）]*）$/, "")
    .replace(/^(?:JR|ＪＲ)/, "");
}

export function legacyServiceByLedgerName(
  ledgerName: string,
): ServiceMasterEntry | undefined {
  const name = ledgerName.trim();
  const exact = SERVICE_MASTER.find((entry) =>
    entry.ledgerNames.includes(name),
  );
  if (exact) return exact;
  const stripped = name.replace(/（[^）]*）$/, "");
  if (stripped !== name) {
    const byStripped = SERVICE_MASTER.find((entry) =>
      entry.ledgerNames.includes(stripped),
    );
    if (byStripped) return byStripped;
  }
  const canonical = legacyCanonicalLedgerName(name);
  return SERVICE_MASTER.find((entry) =>
    entry.ledgerNames.some(
      (ledgerName) => legacyCanonicalLedgerName(ledgerName) === canonical,
    ),
  );
}

/* Whether a saved service_id is a stale link the old auto-link
   produced (review round 5, medium): the pre-round-4 lookup linked
   the recorded name to the saved id, but the current rules do not
   — so the link can only have come from the old auto-link, and it
   is safe to clear on re-registration / re-import. A link the
   current rules still agree with is not stale, and a link the old
   code could not have produced either (a different service, or an
   id the master never knew) is left for individual confirmation —
   never auto-cleared, because the row may carry an explicit link
   a caller chose. A null / missing id is never stale. */
export function isStaleAutoLink(
  ledgerName: string,
  savedServiceId: string | null | undefined,
): boolean {
  if (!savedServiceId) return false;
  if (!serviceById(savedServiceId)) return false;
  return (
    legacyServiceByLedgerName(ledgerName)?.id === savedServiceId &&
    serviceByLedgerName(ledgerName)?.id !== savedServiceId
  );
}

export function serviceByLedgerName(
  ledgerName: string,
): ServiceMasterEntry | undefined {
  const name = normalizeParentheses(ledgerName);
  const exact = SERVICE_MASTER.find((entry) =>
    entry.ledgerNames.includes(name),
  );
  if (exact) return exact;
  // A redundant trailing qualifier and a leading JR prefix do not
  // make a different service: 「臨海副都心線（りんかい線）」 is
  // the rinkai service, same as 「臨海副都心線」 (review round 2),
  // and 「武蔵野線」 is the jr-musashino service, same as
  // 「JR武蔵野線」 (review round 3). The qualifier is stripped
  // only for the lookup — and only when it is redundant — so a
  // distinguishing qualifier （各駅停車） keeps the name from
  // attaching to the wrong service (review round 4). The recorded
  // name itself is untouched.
  const canonical = canonicalLedgerName(name);
  return SERVICE_MASTER.find((entry) =>
    entry.ledgerNames.some(
      (ledgerName) => canonicalLedgerName(ledgerName) === canonical,
    ),
  );
}

/* Expands a service into its formal lines, in running order —
   the 系統→正式線名 translation the map and the aggregates use. */
export function expandService(
  serviceId: string,
): readonly ServiceSegment[] {
  return serviceById(serviceId)?.segments ?? [];
}

/* The blocks of a service, in running order — the stage-2 input
   granularity (see ServiceBlock). */
export function blocksForService(serviceId: string): readonly ServiceBlock[] {
  return serviceById(serviceId)?.blocks ?? [];
}

export function blockById(
  serviceId: string,
  blockId: string,
): ServiceBlock | undefined {
  return blocksForService(serviceId).find((block) => block.id === blockId);
}

/* The boundary stations of a service, in running order: the first
   block's from, then every block's to. A loop service's last
   boundary is its first station again （品川 closes the 山手線）,
   so the list has blocks.length + 1 entries for a loop, and the
   same count for a line (its last to is its terminus). */
export function serviceBoundaryStations(
  serviceId: string,
): readonly StationRef[] {
  const blocks = blocksForService(serviceId);
  if (blocks.length === 0) return [];
  const stations: StationRef[] = [blocks[0]!.from];
  for (const block of blocks) stations.push(block.to);
  return stations;
}

/* Is this service a loop (its last block returns to its first
   station)? Only loops need a direction to tell which side a
   section runs on. */
export function serviceIsLoop(serviceId: string): boolean {
  const boundaries = serviceBoundaryStations(serviceId);
  return (
    boundaries.length > 1 &&
    boundaries[0]!.id === boundaries[boundaries.length - 1]!.id
  );
}

/* Validates a section (an added ride between two stations) for the
   stage-2 block input. The endpoints must be boundary stations of
   the service, in running order — a section may span several whole
   blocks, but it may not start or end mid-block (arbitrary
   stations are stage 3). On a loop the caller must also give the
   direction, since the same two stations can be joined either way
   round. Returns an error string, or null when the section is
   valid. This is the rule the server's addRiddenSection enforces;
   the client checks it first so a bad tap never reaches the
   server. */
export function validateSectionEndpoints(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
  direction?: "inner" | "outer" | null,
): string | null {
  const service = serviceById(serviceId);
  if (!service) return `unknown service "${serviceId}"`;
  if (fromStationId === toStationId) {
    return "a section needs two different stations";
  }
  const boundaries = serviceBoundaryStations(serviceId);
  const fromIndex = boundaries.findIndex((s) => s.id === fromStationId);
  const toIndex = boundaries.findIndex((s) => s.id === toStationId);
  if (fromIndex < 0) {
    return `"${fromStationId}" is not a boundary station of ${service.displayName}`;
  }
  if (toIndex < 0) {
    return `"${toStationId}" is not a boundary station of ${service.displayName}`;
  }
  if (serviceIsLoop(serviceId)) {
    if (!direction) {
      return `${service.displayName} is a loop: a section needs a direction (inner/outer)`;
    }
    // Any two distinct boundaries join either way round a loop;
    // the direction says which way. The blocks' own direction
    // must agree when the section is a single block.
    const blocks = blocksForService(serviceId);
    const block = blocks.find(
      (b) =>
        (b.from.id === fromStationId && b.to.id === toStationId) ||
        (b.from.id === toStationId && b.to.id === fromStationId),
    );
    if (block?.direction && block.direction !== direction) {
      return `block ${block.from.name}〜${block.to.name} runs ${block.direction}, not ${direction}`;
    }
    return null;
  }
  if (fromIndex >= toIndex) {
    return "the section runs against the service's running order";
  }
  return null;
}

/* The versioned path of a service, as a full ride records it: the
   path id, the master version it was cut at, and the segment list
   (formal line, endpoints, direction, approximate flag) as it
   stood then. A later master change never rewrites a stored
   snapshot, so a past full ride keeps reproducing the range it
   was recorded at — the 版付き経路 the stage-1 review asked
   stage 2 to provide. */
export type FullPathSnapshot = {
  pathId: string;
  masterVersion: string;
  segments: {
    formalLineKey: string;
    from: StationRef;
    to: StationRef;
    direction?: "inner" | "outer";
    approximate?: boolean;
  }[];
};

export function serviceFullPathSnapshot(
  serviceId: string,
): FullPathSnapshot | null {
  const service = serviceById(serviceId);
  if (!service) return null;
  return {
    pathId: service.pathId,
    masterVersion: SERVICE_MASTER_VERSION,
    segments: service.segments.map((segment) => ({
      formalLineKey: segment.formalLineKey,
      from: segment.from,
      to: segment.to,
      ...(segment.direction ? { direction: segment.direction } : {}),
      ...(segment.approximate ? { approximate: true } : {}),
    })),
  };
}
export function formalLineNames(serviceId: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const segment of expandService(serviceId)) {
    if (!seen.has(segment.formalLineName)) {
      seen.add(segment.formalLineName);
      names.push(segment.formalLineName);
    }
  }
  return names;
}

/* The asset keys a service expands to, in running order — the keys
   the map overlay paints (stage 2 paints only the ridden section of
   these; stage 1 keeps painting whole single-key lines as before).
   De-duplicated: a loop or a service whose segments share one
   formal line （中央線（快速） runs 東京〜神田 and 神田〜高尾 on the
   one 中央線 key) must still resolve as a single-key service. */
export function assetKeysForService(serviceId: string): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const segment of expandService(serviceId)) {
    if (!seen.has(segment.formalLineKey)) {
      seen.add(segment.formalLineKey);
      keys.push(segment.formalLineKey);
    }
  }
  return keys;
}

/* ------------------------------------------------------------------ */
/* The nine old ledger rows, migrated to the master — the mirror of
   the SQL backfill in drizzle/0011 (SQL cannot import this table).
   This table is the MIGRATION's reference only: new registrations
   never restore a section from it (a fresh 「京王線」 row starts
   unknown — see resolveRideFields in server/src/actions.ts). Only
   the SQL migration, which identifies the nine live rows by name
   AND first-ride date, applies these sections. */
/*                                                                     */
/* The restored section of each ride comes from the trip context and   */
/* the delivery note recorded at the time (live ledger rows +          */
/* seen_lines.md). Where the record pins down a section, the ride is   */
/* partial with that section; where it does not, the ride stays        */
/* unknown — never guessed, never stretched to a full line.            */
/*                                                                     */
/* - JR中央線（快速）: context「佐倉MC実習の前泊への移動（国分寺→東京）」 */
/*   + note「国分寺21:31発→東京」→ 国分寺→東京                       */
/* - JR総武快速線: context「（東京→千葉）」+ note「東京22:21発→千葉」 */
/*   → 東京→千葉                                                      */
/* - JR総武本線: context「佐倉MC実習の移動（佐倉→千葉）」+ note     */
/*   「佐倉16:56発 普通 千葉行」「四街道市亀崎付近を通過中」→         */
/*   佐倉→千葉（亀崎は物井駅のある地区で、通過点の記録）             */
/* - 京王線: seen_lines「府中→聖蹟桜ヶ丘の乗車中」+ context          */
/*   「聖蹟桜ヶ丘へ移動」→ 府中→聖蹟桜ヶ丘                           */
/* - JR埼京線: context「京王線から新宿で乗り換え、りんかい線直通で   */
/*   向かう途中」+ りんかい線の記録「大崎でりんかい線区間へ」→       */
/*   埼京線の区間は新宿→大崎                                         */
/* - りんかい線: context「新宿で埼京線からりんかい線直通で移動中」   */
/*   + seen_lines「大崎〜品川シーサイド間で配信」→ 大崎→品川シーサイド */
/* - 山手線: seen_lines「大崎17:25→五反田付近17:29→目黒駅17:32の   */
/*   内回り」「新宿方面へ移動中」→ 観測できた区間は大崎→目黒。     */
/*   降車駅は記録が無いため、目黒より先は伸ばさない。                 */
/* - JR武蔵野線: noteは「メイン会話で初回配信」のみで駅の記録なし →  */
/*   unknown                                                         */
/* - 北総線: noteは「東松戸駅付近で乗車中」の1点のみで区間が定まら   */
/*   ない → unknown                                                  */
/* ------------------------------------------------------------------ */

export type RestoredRide = {
  serviceId: string;
  rideState: RideState;
  from: StationRef | null;
  to: StationRef | null;
  masterVersion: string;
};

/* The master version the nine migrated rides were cut at, frozen
   as a literal: it must NOT track SERVICE_MASTER_VERSION. When the
   master is next bumped, these rows keep the version they were
   migrated at (a later extension must never silently claim a
   stretch the rider never rode). */
export const MIGRATED_MASTER_VERSION = "2026-11-24";

/* The master versions a full ride may be recorded at: the current
   version, or the frozen version the nine migrated rides were cut
   at. A full ride's range must be reproducible from its version, so
   an unknown version ("bogus", a blank, whitespace) must be
   rejected at save time (review round 2, high). */
export function isKnownMasterVersion(version: string): boolean {
  const v = version.trim();
  return v === SERVICE_MASTER_VERSION || v === MIGRATED_MASTER_VERSION;
}

export const MIGRATED_RIDES: Readonly<Record<string, RestoredRide>> = {
  "JR武蔵野線": {
    serviceId: "jr-musashino",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "北総線": {
    serviceId: "hokuso",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "JR中央線（快速）": {
    serviceId: "jr-chuo-rapid",
    rideState: "partial",
    from: { id: "003606", name: "国分寺", lng: 139.48013, lat: 35.70045 },
    to: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "JR総武快速線": {
    serviceId: "jr-sobu-rapid",
    rideState: "partial",
    from: { id: "003766", name: "東京", lng: 139.76675, lat: 35.68128 },
    to: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "JR総武本線": {
    serviceId: "jr-sobu-local",
    rideState: "partial",
    from: { id: "003531", name: "佐倉", lng: 140.22675, lat: 35.70974 },
    to: { id: "004173", name: "千葉", lng: 140.1136, lat: 35.61275 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "京王線": {
    serviceId: "keio",
    rideState: "partial",
    from: { id: "003821", name: "府中", lng: 139.4801, lat: 35.67219 },
    to: { id: "003971", name: "聖蹟桜ヶ丘", lng: 139.44687, lat: 35.65079 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "JR埼京線": {
    serviceId: "jr-saikyo",
    rideState: "partial",
    from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
    to: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "りんかい線": {
    serviceId: "rinkai",
    rideState: "partial",
    from: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
    to: { id: "004182", name: "品川シーサイド", lng: 139.7498, lat: 35.60979 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
  "山手線": {
    serviceId: "yamanote",
    rideState: "partial",
    from: { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
    to: { id: "004072", name: "目黒", lng: 139.71568, lat: 35.63272 },
    masterVersion: MIGRATED_MASTER_VERSION,
  },
};
