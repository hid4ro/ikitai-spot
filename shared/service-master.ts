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
   block runs on. `stations` (stage 3, subtask 1455) lists the
   stations the block passes between its endpoints, in running
   order — stations the service is known to serve that are no
   block boundary, so a ride between two of them can be recorded
   as a section without splitting the block (splitting would bake
   one ride into the input granularity for every later ride).
   Only stations listed here count as section endpoints; a
   station merely known from a migrated ride does not. */
export type ServiceBlock = {
  id: string;
  from: StationRef;
  to: StationRef;
  direction?: "inner" | "outer";
  stations?: StationRef[];
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
  /* Stations the segment's route must run through, in running
     order — the branch a formal line cannot tell apart on its
     own. One formal-line key can carry two branches between the
     same endpoints （京王線本線 and 京王新線 both run 新宿→笹塚
     on 京王線|京王電鉄, on different edges); the graph's shortest
     path alone would always pick the same branch, so the segment
     names the stations its branch passes through and the path is
     routed leg by leg through them (subtask 1613). */
  via?: StationRef[];
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
  /* Optional: the formal-line key whose asset color paints ALL
     of this service's legs on the map, instead of each leg's own
     formal-line color. For a service the reader knows as ONE
     named line whose path happens to run over several formal
     lines — 山手線's loop runs on 山手線・東北線・東海道線,
     whose own colors (green / dark blue / orange) would paint
     the one loop in three colors, the 東海道線 stretch
     indistinguishable from 中央線's orange (subtask 1680).
     Coverage and distance stay per formal-line key; only the
     paint color is unified. Unset services keep the per-leg
     formal-line colors. */
  paintColorKey?: string;
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
export const SERVICE_MASTER_VERSION = "2026-11-27";

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
        /* Stage 3 (subtask 1455): the 2026-11-12 return ride
           東松戸〜北府中, estimated from the return-trip record
           （印西牧の原での実習への行き帰り) — 北府中 sits inside
           this block, so it is listed here rather than splitting
           it. 東松戸 belongs to b2 （南浦和〜西船橋), not here:
           the running order is 府中本町→北府中→…→南浦和→…→
           東松戸→…→西船橋 (review round 1, high — the first
           version listed 東松戸 on b1 ahead of 北府中, which put
           it before 南浦和 and rejected the return ride).
           Coordinates are the N02 station-point centroids (mean
           over the station's N02_005 features). */
        stations: [
          { id: "003771", name: "北府中", lng: 139.47179, lat: 35.68086 },
        ],
      },
      {
        id: "jr-musashino/b2",
        from: { id: "003004", name: "南浦和", lng: 139.66878, lat: 35.84796 },
        to: { id: "003547", name: "西船橋", lng: 139.95907, lat: 35.70737 },
        /* Stage 3 (subtask 1455): 東松戸 sits inside this block
           (see the b1 note for the running order). */
        stations: [
          { id: "003187", name: "東松戸", lng: 139.94311, lat: 35.77013 },
        ],
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-musashino-omiya",
    pathId: "jr-musashino-omiya",
    displayName: "むさしの号",
    ledgerNames: ["むさしの号"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "003876", name: "府中本町", lng: 139.47718, lat: 35.66583 },
        to: { id: "003014", name: "西浦和", lng: 139.62777, lat: 35.84419 },
      },
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "003014", name: "西浦和", lng: 139.62777, lat: 35.84419 },
        to: { id: "002947", name: "与野", lng: 139.63899, lat: 35.88437 },
        note:
          "大宮支線（西浦和－別所信号場－与野）。正式線名は武蔵野線のままで、N02の武蔵野線形状に支線のポリラインが含まれている。",
      },
      {
        formalLineName: "東北線",
        formalLineKey: "東北線|東日本旅客鉄道",
        from: { id: "002947", name: "与野", lng: 139.63899, lat: 35.88437 },
        to: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        note: "通称・東北本線。N02の路線単位名は東北線。",
      },
    ],
    blocks: [
      {
        id: "jr-musashino-omiya/b1",
        from: { id: "003876", name: "府中本町", lng: 139.47718, lat: 35.66583 },
        to: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        /* One block for the whole service: block boundaries
           are stations the service stops at, and むさしの号
           does not stop at 西浦和 — it is only the junction
           where the path leaves the 武蔵野線 main line for
           the 大宮支線, so it stays a segment endpoint and
           never a block boundary (the same shape as
           jr-shimousa's b1 spanning the 与野 junction).
           Splitting the block there let a ride be recorded
           FROM 西浦和, a station no むさしの号 calls at
           (review batch round 1, subtask 1593).
           Subtask 1590: the 2026-11-26 ride 北府中→大宮
           （むさしの号) starts at 北府中, which sits inside
           this block, so it is listed here (same stage-3
           pattern as jr-musashino's own b1). Coordinates
           are the N02 station-point centroids. */
        stations: [
          { id: "003771", name: "北府中", lng: 139.47179, lat: 35.68086 },
        ],
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note:
      "むさしの号（府中本町→大宮）は西浦和で本線から大宮支線へ分岐するため、線形パス前提の jr-musashino には足せず、別サービスとして持つ（subtask 1565 の調査）。与野は支線と東北線のつなぎ目（経由点）で、停車駅ではない。西浦和も停車駅ではないため、ブロック境界には置かずセグメントの接続点だけにしている（レビュー第1回、subtask 1593）。北府中→大宮の営業キロは約33.7km。西浦和→与野の形状長（約4.59km）と営業キロ（4.9km）の差、与野→大宮の実走行線路の人手照合は未了（draftのまま）。",
  },
  {
    id: "jr-shimousa",
    pathId: "jr-shimousa",
    displayName: "しもうさ号",
    ledgerNames: ["しもうさ号"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "東北線",
        formalLineKey: "東北線|東日本旅客鉄道",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "002947", name: "与野", lng: 139.63899, lat: 35.88437 },
        note: "通称・東北本線。N02の路線単位名は東北線。",
      },
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "002947", name: "与野", lng: 139.63899, lat: 35.88437 },
        to: { id: "003006", name: "武蔵浦和", lng: 139.64717, lat: 35.84559 },
        /* The distributed shape measures this stretch at
           6.855 km against a ~5 km physical run (~37% long,
           including a 439 m artificial bridge), so distances
           drawn from it are approximations (review batch
           round 1, subtask 1593). The flag changes no
           totals — the same shape is still measured. */
        approximate: true,
        note:
          "西浦和支線・大宮支線（与野－別所信号場－武蔵浦和）。N02の武蔵野線形状で支線のポリラインは西浦和方から与野へ引かれており、本サービスは別所信号場付近で本線へ合流する形でその逆向きを辿る（439mのブリッジ含む）。",
      },
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "003006", name: "武蔵浦和", lng: 139.64717, lat: 35.84559 },
        to: { id: "003547", name: "西船橋", lng: 139.95907, lat: 35.70737 },
      },
    ],
    blocks: [
      {
        id: "jr-shimousa/b1",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "003006", name: "武蔵浦和", lng: 139.64717, lat: 35.84559 },
      },
      {
        id: "jr-shimousa/b2",
        from: { id: "003006", name: "武蔵浦和", lng: 139.64717, lat: 35.84559 },
        to: { id: "003004", name: "南浦和", lng: 139.66878, lat: 35.84796 },
      },
      {
        id: "jr-shimousa/b3",
        from: { id: "003004", name: "南浦和", lng: 139.66878, lat: 35.84796 },
        to: { id: "003547", name: "西船橋", lng: 139.95907, lat: 35.70737 },
        /* Stage 3 pattern (same as jr-musashino's own b2):
           東松戸 sits inside this block, so it is listed here
           rather than splitting it. Coordinates are the N02
           station-point centroids. */
        stations: [
          { id: "003187", name: "東松戸", lng: 139.94311, lat: 35.77013 },
        ],
      },
    ],
    sources: [N02_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note:
      "しもうさ号（大宮→西船橋）は与野から支線へ分岐するため、むさしの号（jr-musashino-omiya）と対の別サービスとして持つ（subtask 1565 の調査、1591 で乗車前に先回り収録。そのため出典はN02のみで、台帳の乗車記録はまだ無い）。与野は東北線と支線のつなぎ目（経由点）で、停車駅ではない。与野→武蔵浦和は、簡略化形状の合流位置が本線の西浦和側に寄っていることと439mブリッジの分で、アプリ計算では約6.85kmと実経路（約5km）より長めに出る（サービス全体では実測51.66km）。人手の地図照合は未了（draftのまま）。八王子発のむさしの号は、国立支線（国立－新小平）の形状がN02（2025年度版）とアセットの双方に無いため、今回は収録していない（subtask 1591 の報告）。",
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
        /* Stage 3 (subtask 1455): the 2026-11-12 ride
           東松戸〜印西牧の原, estimated from the itinerary the
           user specified that day （印西牧の原での実習への行き帰
           り). The service has a single block, so both stations
           are listed on it. 東松戸 003187 uses the same
           group-code centroid as on 武蔵野線 (one code, one
           physical station, one point). */
        stations: [
          { id: "003187", name: "東松戸", lng: 139.94311, lat: 35.77013 },
          { id: "003083", name: "印西牧の原", lng: 140.16713, lat: 35.80363 },
        ],
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
        /* 神田 is the junction of this service's two segments
           AND a station every rapid stops at, so unlike a
           pass-through junction （西浦和 on むさしの号） it is a
           boarding station: listing it here puts it in
           serviceBoardingStationIds, so a fresh 神田→新宿
           registration validates (batch review round 3, medium
           — it was refused although the stretch aggregates as
           9.08 km). */
        stations: [
          { id: "003677", name: "神田", lng: 139.77088, lat: 35.69242 },
        ],
      },
      {
        id: "jr-chuo-rapid/b2",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003634", name: "立川", lng: 139.41396, lat: 35.69793 },
        /* 国分寺 is a station every rapid stops at, so listing
           it here puts it in serviceBoardingStationIds and
           serviceOrderedStations, and the restored 2026-11-15
           ride 国分寺→東京 can be registered as a section
           (subtask 1572 — until now it was known only from the
           migrated ride and validateSectionEndpoints refused it). */
        stations: [
          { id: "003606", name: "国分寺", lng: 139.48013, lat: 35.70045 },
        ],
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
        /* 聖蹟桜ヶ丘 is a station every 京王線 train stops at,
           so listing it here makes the restored 2026-11-22 ride
           府中→聖蹟桜ヶ丘 registerable as a section (subtask
           1572 — until now it was known only from the migrated
           ride and validateSectionEndpoints refused it). */
        stations: [
          { id: "003971", name: "聖蹟桜ヶ丘", lng: 139.44687, lat: 35.65079 },
        ],
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
        /* 新宿 is a station every 埼京線 train stops at, so
           listing it here makes the restored 2026-11-24 ride
           新宿→大崎 registerable as a section (subtask 1572 —
           until now it was known only from the migrated ride
           and validateSectionEndpoints refused it). */
        stations: [
          { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        ],
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
        /* 品川シーサイド is a station every りんかい線 train
           stops at, so listing it here makes the restored
           2026-11-24 ride 大崎→品川シーサイド registerable as
           a section (subtask 1572 — until now it was known
           only from the migrated ride and validateSectionEndpoints
           refused it). */
        stations: [
          { id: "004182", name: "品川シーサイド", lng: 139.7498, lat: 35.60979 },
        ],
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
    /* The whole loop paints in 山手線 green: the reader rode
       "the Yamanote", and the 東北線・東海道線 stretches of the
       loop are Yamanote trains on those formal lines, not
       Tōhoku/Tōkaidō services (subtask 1680). */
    paintColorKey: "山手線|東日本旅客鉄道",
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
        /* Stage 3 (subtask 1455): 大崎 sits inside this block, so
           the 2026-11-25 morning ride 新宿→大崎 （府中→新宿→山手
           線→大崎, 内回り) can be recorded without widening the
           section to 品川. 大崎's coordinates are the master's
           existing value (also a segment end on 埼京線・りんかい
           線). 目黒 sits inside this block too, so the restored
           2026-11-24 ride 大崎→目黒 (outer) can be registered
           as a section (subtask 1572 — until now it was known
           only from the migrated ride). */
        stations: [
          { id: "004135", name: "大崎", lng: 139.72807, lat: 35.61985 },
          { id: "004072", name: "目黒", lng: 139.71568, lat: 35.63272 },
        ],
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
  {
    id: "tobu-noda",
    pathId: "tobu-noda",
    displayName: "東武野田線",
    ledgerNames: ["東武野田線", "東武アーバンパークライン"],
    operator: "東武鉄道",
    segments: [
      /* Split at 柏 (subtask 1611, review of 1566): the N02
         shape for 野田線 branches about 390 m before 柏 station,
         and the direct shortest path 大宮→船橋 takes the
         船橋-bound branch — the service's own station is
         bypassed, and a section ending at 柏 came out
         approximate. Splitting the route here forces the path
         into 柏 and back out again （柏への進入・折り返し), so
         the drawn path and the clips run through the station.
         The spur edge is traversed twice in the legs; it is
         counted once in the path total (see buildServicePath),
         so a full ride measures the distinct 62.03 km, not the
         62.42 km of the concatenated legs. */
      {
        formalLineName: "野田線",
        formalLineKey: "野田線|東武鉄道",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "002984", name: "柏", lng: 139.97046, lat: 35.86198 },
      },
      {
        formalLineName: "野田線",
        formalLineKey: "野田線|東武鉄道",
        from: { id: "002984", name: "柏", lng: 139.97046, lat: 35.86198 },
        to: { id: "003589", name: "船橋", lng: 139.98437, lat: 35.7021 },
      },
    ],
    blocks: [
      {
        id: "tobu-noda/b1",
        from: { id: "002914", name: "大宮", lng: 139.62356, lat: 35.90653 },
        to: { id: "002785", name: "春日部", lng: 139.75238, lat: 35.98 },
      },
      {
        id: "tobu-noda/b2",
        from: { id: "002785", name: "春日部", lng: 139.75238, lat: 35.98 },
        to: { id: "002984", name: "柏", lng: 139.97046, lat: 35.86198 },
        /* Stage 3 (subtask 1455): the 2026-11-26 ride
           大宮〜七光台 （大宮8:30発・柏行→七光台9:05着、川重
           ファシリテック東営業所への出勤途中). 七光台 sits
           inside this block, so it is listed here rather than
           splitting it (same pattern as 北府中 on
           jr-musashino-omiya/b1). Coordinates are the N02
           station-point centroids. */
        stations: [
          { id: "002803", name: "七光台", lng: 139.85295, lat: 35.97085 },
        ],
      },
      {
        id: "tobu-noda/b3",
        from: { id: "002984", name: "柏", lng: 139.97046, lat: 35.86198 },
        to: { id: "003589", name: "船橋", lng: 139.98437, lat: 35.7021 },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note:
      "東武アーバンパークラインの愛称でも呼ばれる（ledgerNames に両方持つ）。大宮の座標はマスタの既存値（jr-saikyo・jr-musashino-omiya と同一。野田線形状からの距離は約126mで、300mのしきい値の内側）。全長は営業キロ62.7km。2026-11-26の乗車は大宮→七光台（約25.1km）。経路は柏で2分割（分岐で柏を迂回する形状のため、subtask 1611）。人手の地図照合は未了（draftのまま）。",
  },
  {
    id: "keio-new-line",
    pathId: "keio-new-line",
    displayName: "京王新線",
    ledgerNames: ["京王新線"],
    operator: "京王電鉄",
    segments: [
      {
        formalLineName: "京王線",
        formalLineKey: "京王線|京王電鉄",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003806", name: "笹塚", lng: 139.66717, lat: 35.67366 },
        /* The 新線 branch, not the 本線: 新宿→笹塚 runs via 初台・
           幡ヶ谷. The graph's shortest path alone picks the 本線
           edge, so the branch must be named (subtask 1613). */
        via: [
          { id: "003764", name: "初台", lng: 139.68827, lat: 35.68142 },
          { id: "003791", name: "幡ヶ谷", lng: 139.67772, lat: 35.67676 },
        ],
      },
    ],
    blocks: [
      {
        id: "keio-new-line/b1",
        from: { id: "003700", name: "新宿", lng: 139.69993, lat: 35.6898 },
        to: { id: "003806", name: "笹塚", lng: 139.66717, lat: 35.67366 },
        /* 初台・幡ヶ谷 are stations every 京王新線 train stops
           at, so listing them here makes a ride between any two
           of the four stations registerable as a section (subtask
           1574 — the 2026-11-25 ride 新宿→幡ヶ谷付近 is NOT
           registered: its alighting station is unconfirmed, so
           only the master entry is added). Coordinates are the
           N02 station-point centroids. */
        stations: [
          { id: "003764", name: "初台", lng: 139.68827, lat: 35.68142 },
          { id: "003791", name: "幡ヶ谷", lng: 139.67772, lat: 35.67676 },
        ],
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
    note:
      "N02（2025年度版）に「京王新線」の独立した路線単位は無く、4駅はすべて京王線|京王電鉄に含まれる（新線新宿は新宿と同一コード 003700）。そのため formalLineKey は既存の keio と同じ「京王線|京王電鉄」を使う（監督の判断、むさしの号と同じ形）。新宿→笹塚の形状は新線側の分岐（アプリの計測で 3.52km、営業キロ 3.6km）で、本線側の同じ区間（3.52km）とほぼ同じ長さだが通る枝が違う（本線は初台・幡ヶ谷を通らない）。分岐は via で初台・幡ヶ谷を指定する（subtask 1613）。新宿の座標はマスタ既存値（keio・jr-saikyo と同一。N02の路線別重心とは約110mの開きがあるが、300mのしきい値の内側）を再利用し、同一駅に2つの座標を作らない。2026-11-25の乗車（新宿→幡ヶ谷付近）は降車駅が未確定のため区間登録はしない。人手の地図照合は未了（draftのまま）。",
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
   Segments carry every terminus, blocks every boundary and
   (stage 3) their listed mid-block stations, and the migrated
   rides carry their restored endpoints （国分寺・聖蹟桜ヶ丘・
   品川シーサイド・目黒 are no block boundary) — all four are
   searched, first match wins. One code names one physical
   station, wherever it appears, so the matches agree. */
export function stationRefById(stationId: string): StationRef | undefined {
  for (const entry of SERVICE_MASTER) {
    for (const segment of entry.segments) {
      if (segment.from.id === stationId) return segment.from;
      if (segment.to.id === stationId) return segment.to;
    }
    for (const block of entry.blocks) {
      if (block.from.id === stationId) return block.from;
      if (block.to.id === stationId) return block.to;
      for (const station of block.stations ?? []) {
        if (station.id === stationId) return station;
      }
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
function normalizeParenthesisWidth(name: string): string {
  return name
    .trim()
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/[ 　]+（/g, "（")
    .replace(/）[ 　]+/g, "）");
}

export function normalizeParentheses(name: string): string {
  return normalizeParenthesisWidth(name)
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

type HistoricalServiceAlias = Pick<
  ServiceMasterEntry,
  "id" | "ledgerNames" | "operator"
>;

// Both old matchers used this ordered alias catalog. Keep it independent
// of service-master edits so an added alias cannot change historical evidence.
const HISTORICAL_JR_OPERATOR = "東日本旅客鉄道";
const HISTORICAL_SERVICE_ALIASES: readonly HistoricalServiceAlias[] = [
  { id: "jr-musashino", ledgerNames: ["JR武蔵野線"], operator: HISTORICAL_JR_OPERATOR },
  { id: "hokuso", ledgerNames: ["北総線"], operator: "北総鉄道" },
  { id: "jr-chuo-rapid", ledgerNames: ["JR中央線（快速）", "JR中央線"], operator: HISTORICAL_JR_OPERATOR },
  { id: "jr-sobu-rapid", ledgerNames: ["JR総武快速線"], operator: HISTORICAL_JR_OPERATOR },
  { id: "jr-sobu-local", ledgerNames: ["JR総武本線"], operator: HISTORICAL_JR_OPERATOR },
  { id: "keio", ledgerNames: ["京王線"], operator: "京王電鉄" },
  { id: "jr-saikyo", ledgerNames: ["JR埼京線"], operator: HISTORICAL_JR_OPERATOR },
  { id: "rinkai", ledgerNames: ["りんかい線", "臨海副都心線"], operator: "東京臨海高速鉄道" },
  { id: "yamanote", ledgerNames: ["山手線"], operator: HISTORICAL_JR_OPERATOR },
];

function legacyCanonicalLedgerName(name: string): string {
  return name
    .trim()
    .replace(/（[^）]*）$/, "")
    .replace(/^(?:JR|ＪＲ)/, "");
}

// 6ab413a compared exact names, then discarded any trailing full-width
// qualifier, then discarded a leading JR prefix for the canonical comparison.
function legacyServiceIdByLedgerName(ledgerName: string): string | undefined {
  const name = ledgerName.trim();
  const exact = HISTORICAL_SERVICE_ALIASES.find((entry) =>
    entry.ledgerNames.includes(name),
  );
  if (exact) return exact.id;
  const stripped = name.replace(/（[^）]*）$/, "");
  if (stripped !== name) {
    const byStripped = HISTORICAL_SERVICE_ALIASES.find((entry) =>
      entry.ledgerNames.includes(stripped),
    );
    if (byStripped) return byStripped.id;
  }
  const canonical = legacyCanonicalLedgerName(name);
  return HISTORICAL_SERVICE_ALIASES.find((entry) =>
    entry.ledgerNames.some(
      (ledgerName) => legacyCanonicalLedgerName(ledgerName) === canonical,
    ),
  )?.id;
}

export function legacyServiceByLedgerName(
  ledgerName: string,
): ServiceMasterEntry | undefined {
  const id = legacyServiceIdByLedgerName(ledgerName);
  return id ? serviceById(id) : undefined;
}

// 9ee18307 normalized half-width parentheses and accepted a qualifier
// recognized anywhere in the catalog. Its display names were all aliases.
function round4CanonicalLedgerName(name: string): string {
  const unified = bareLedgerName(normalizeParenthesisWidth(name));
  const match = unified.match(/（([^）]*)）$/);
  if (!match) return unified;
  const qualifier = match[1]!.trim();
  const company = bareLedgerName(qualifier);
  const knownQualifier = HISTORICAL_SERVICE_ALIASES.some(
    (entry) =>
      entry.ledgerNames.some((alias) => bareLedgerName(alias) === company) ||
      (company &&
        (entry.operator.startsWith(company) || company.startsWith(entry.operator))),
  );
  return knownQualifier ? unified.slice(0, match.index) : unified;
}

function round4ServiceIdByLedgerName(ledgerName: string): string | undefined {
  const name = normalizeParenthesisWidth(ledgerName);
  const exact = HISTORICAL_SERVICE_ALIASES.find((entry) =>
    entry.ledgerNames.includes(name),
  );
  if (exact) return exact.id;
  const canonical = round4CanonicalLedgerName(name);
  return HISTORICAL_SERVICE_ALIASES.find((entry) =>
    entry.ledgerNames.some(
      (alias) => round4CanonicalLedgerName(alias) === canonical,
    ),
  )?.id;
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

// The matching rule version is separate from the version of the recorded ride.
// 1 was the blanket qualifier strip; 2 checked the entire alias catalog.
export const SERVICE_MATCH_VERSION = "3";

export type ServiceLinkSource = "auto" | "explicit";

export type RiddenServiceLink = {
  name: string;
  serviceId?: string | null;
  serviceLinkSource?: ServiceLinkSource | null;
  serviceMatchVersion?: string | null;
};

type RiddenServiceResolution =
  | { service: ServiceMasterEntry | undefined; needsReview: false }
  | {
      service: undefined;
      needsReview: true;
      historicalAutoMatchVersions: readonly string[];
    };

// A saved link without provenance may have been automatic or explicit even
// when an old matcher reproduces it. Flag disagreements and keep that evidence
// for individual review. A validated explicit link records the caller's choice.
export function resolveRiddenService(
  row: RiddenServiceLink,
): RiddenServiceResolution {
  if (row.serviceId == null) {
    /* An explicit unlink is a human's confirmed answer — "this
       row has NO service" — not a missing link waiting to be
       inferred again. Resolving the name anyway would silently
       undo the confirmation on every read (integrated review
       round 1, medium: the display side kept inferring the
       service from the name after an explicit unlink). Only a
       row with no provenance at all falls back to the name rule. */
    if (row.serviceLinkSource === "explicit") {
      return { service: undefined, needsReview: false };
    }
    return { service: serviceByLedgerName(row.name), needsReview: false };
  }
  const saved = serviceById(row.serviceId);
  if (
    saved &&
    (row.serviceLinkSource === "explicit" ||
      serviceByLedgerName(row.name)?.id === saved.id)
  ) {
    return { service: saved, needsReview: false };
  }
  const historicalAutoMatchVersions: string[] = [];
  if (row.serviceLinkSource !== "explicit") {
    if (
      (!row.serviceMatchVersion || row.serviceMatchVersion === "1") &&
      legacyServiceIdByLedgerName(row.name) === row.serviceId
    ) {
      historicalAutoMatchVersions.push("1");
    }
    if (
      (!row.serviceMatchVersion || row.serviceMatchVersion === "2") &&
      round4ServiceIdByLedgerName(row.name) === row.serviceId
    ) {
      historicalAutoMatchVersions.push("2");
    }
  }
  return { service: undefined, needsReview: true, historicalAutoMatchVersions };
}

// Distance, map highlights and section editing require a usable saved ID.
// An unlinked row can still have a name-based display or whole-line asset.
export function usableRiddenService(
  row: RiddenServiceLink,
): ServiceMasterEntry | undefined {
  return row.serviceId ? resolveRiddenService(row).service : undefined;
}

/* Whether a human has confirmed this row has no service: no
   saved ID, with explicit provenance. The distinction from a
   plain unlinked row (never linked, no provenance) is what keeps
   an explicit unlink from being undone by name inference on the
   read side and by automatic backfill on the write side
   (integrated review round 1, medium). */
export function isExplicitlyUnlinked(row: RiddenServiceLink): boolean {
  return row.serviceId == null && row.serviceLinkSource === "explicit";
}

/* The station IDs a service is known to serve, from the master
   alone: every segment endpoint and block boundary, the stations
   listed on the service's blocks (stage 3), plus the endpoints
   of the rides the SQL migration restored for this service (the
   only record of mid-segment stations like 国分寺 on 中央線
   （快速）). A recorded section whose endpoints are not in this
   set cannot belong to the service — the test the link
   confirmation (server) and the coverage build (client) use to
   keep one service's ride from being counted as another's
   (integrated review round 1, high). Deliberately conservative:
   a station the master does not know is "cannot judge", never
   "close enough". */
export function serviceStationIds(serviceId: string): ReadonlySet<string> {
  const ids = new Set(serviceBoardingStationIds(serviceId));
  const service = serviceById(serviceId);
  if (service) {
    for (const segment of service.segments) {
      ids.add(segment.from.id);
      ids.add(segment.to.id);
    }
  }
  return ids;
}

/* Both endpoints of a recorded section are stations the service
   is known to serve — the one yardstick the link confirmation
   (server), the coverage build and the link-review hint (client)
   all judge a section's fit by (integrated review round 2,
   medium: the hint used to look at boundary stations only, so it
   refused sections the server accepts — 京王線's restored
   府中→聖蹟桜ヶ丘 ends at a mid-segment station the migration
   recorded, which is a known station but no block boundary). */
export function sectionEndpointsKnownToService(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
): boolean {
  const known = serviceStationIds(serviceId);
  return known.has(fromStationId) && known.has(toStationId);
}

/* A section's ordered formal lines and the stations at which
   it changes lines. The block chain locates those changes and
   selects the arc of a loop. Null means the master cannot prove
   a route, for example when an endpoint's position on a
   multi-line service is only known to be somewhere mid-block. */
function sectionRoute(
  service: ServiceMasterEntry,
  fromStationId: string,
  toStationId: string,
  direction: ServiceBlock["direction"] | null,
): readonly string[] | null {
  const loop = serviceIsLoop(service.id);
  const distinctKeys = [...new Set(service.segments.map((s) => s.formalLineKey))];
  if (!loop && distinctKeys.length === 1) return distinctKeys;
  /* A single formal key cannot distinguish two arcs of the
     same loop or establish which arc another service follows. */
  if (loop && (!direction || distinctKeys.length === 1)) return null;
  const boundaries = serviceBoundaryStations(service.id);
  const chainLength = loop ? boundaries.length - 1 : boundaries.length;
  const position = new Map<string, number>();
  for (let i = 0; i < chainLength; i++) {
    const id = boundaries[i]!.id;
    if (!position.has(id)) position.set(id, i);
  }
  const fromPos = position.get(fromStationId);
  const toPos = position.get(toStationId);
  if (fromPos == null || toPos == null || fromPos === toPos) return null;
  /* Paths are authored in outer/running order. A non-loop's
     historical direction field has no effect on its path. */
  const reverse = loop ? direction === "inner" : toPos < fromPos;
  const [start, end] = reverse ? [toPos, fromPos] : [fromPos, toPos];
  const forward = (a: number, b: number) =>
    loop ? (b - a + chainLength) % chainLength : b - a;
  const route: string[] = [];
  const steps = forward(start, end);
  for (let step = 0; step < steps; step++) {
    const blockStart = (start + step) % chainLength;
    const blockEnd = loop ? (blockStart + 1) % chainLength : blockStart + 1;
    const covering = new Set<string>();
    for (const segment of service.segments) {
      const segFrom = position.get(segment.from.id);
      const segTo = position.get(segment.to.id);
      if (segFrom == null || segTo == null) continue;
      const span = forward(segFrom, segTo);
      const offset = forward(segFrom, blockStart);
      if (
        offset >= 0 &&
        offset < span &&
        forward(segFrom, blockEnd) === offset + 1
      ) {
        covering.add(segment.formalLineKey);
      }
    }
    if (covering.size !== 1) return null;
    const key = [...covering][0]!;
    if (route.at(-1) !== key) {
      if (route.length > 0) route.push(boundaries[blockStart]!.id);
      route.push(key);
    }
  }
  return reverse ? route.reverse() : route;
}

/* Endpoints and direction can stand in for missing provenance
   only when they rule out another route. A known competing
   service with an unresolved path still leaves that possibility
   open. Services using the same formal route, such as 総武快速線
   and 総武本線 between 東京 and 千葉, do not add an alternative. */
export function sectionRouteAmbiguous(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
  direction: ServiceBlock["direction"] | null = null,
): boolean {
  const service = serviceById(serviceId);
  if (!service || fromStationId === toStationId) return true;
  if (serviceIsLoop(serviceId) && !direction) return true;
  const own = sectionRoute(service, fromStationId, toStationId, direction);
  for (const other of SERVICE_MASTER) {
    if (other.id === serviceId) continue;
    if (
      !sectionEndpointsKnownToService(other.id, fromStationId, toStationId)
    ) {
      continue;
    }
    const rival = sectionRoute(other, fromStationId, toStationId, direction);
    if (
      !own || !rival || own.length !== rival.length ||
      own.some((part, index) => part !== rival[index])
    ) {
      return true;
    }
  }
  return false;
}

/* An explicit attribution made by a later add is evidence alongside
   the recording-time service. Otherwise a named block supplies the route
   evidence, with route inference for older or corrected blockless links. */
export function recordedSectionFitsService(
  serviceId: string,
  section: {
    fromStationId: string;
    toStationId: string;
    direction?: ServiceBlock["direction"] | null;
    blockId?: string | null;
    recordedServiceId?: string | null;
    attributedServiceId?: string | null;
  },
): boolean {
  const { fromStationId, toStationId, direction, blockId, recordedServiceId, attributedServiceId } = section;
  if (
    fromStationId === toStationId ||
    !sectionEndpointsKnownToService(serviceId, fromStationId, toStationId)
  ) {
    return false;
  }
  if (attributedServiceId != null &&
      (attributedServiceId === serviceId || recordedServiceId === serviceId)) {
    return true;
  }
  if (blockId != null) {
    const block = blockById(serviceId, blockId);
    return block != null && (
      (block.from.id === fromStationId && block.to.id === toStationId) ||
      (block.from.id === toStationId && block.to.id === fromStationId)
    );
  }
  return recordedServiceId === serviceId ||
    !sectionRouteAmbiguous(serviceId, fromStationId, toStationId, direction);
}

/* The positions of two stations on a loop service, in the
   ordered stations' running order (the closing entry counts as
   position 0) — the shared basis for the direction-less
   fallback: forward/backward steps round the loop. Null when
   the service is not a loop, or an endpoint is not an ordered
   station of it, or the pair is degenerate. */
function loopSectionSteps(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
): {
  fromIdx: number;
  toIdx: number;
  forward: number;
  backward: number;
} | null {
  if (!serviceIsLoop(serviceId)) return null;
  const ordered = serviceOrderedStations(serviceId);
  const n = ordered.length - 1;
  if (n <= 0) return null;
  const indexOf = (stationId: string): number => {
    const idx = ordered.findIndex((s) => s.id === stationId);
    if (idx < 0) return -1;
    return idx === ordered.length - 1 ? 0 : idx;
  };
  const fromIdx = indexOf(fromStationId);
  const toIdx = indexOf(toStationId);
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return null;
  return {
    fromIdx,
    toIdx,
    forward: (((toIdx - fromIdx) % n) + n) % n,
    backward: (((fromIdx - toIdx) % n) + n) % n,
  };
}

/* The way round a loop a direction-less section takes: the
   shorter way by station steps (forward <= backward is outer).
   Null when the service is not a loop, or an endpoint is not
   an ordered station of it. This is the fallback clipServicePath
   and coveredBlockIds use, so the drawing and the block
   picker's check column agree — and the yardstick for whether
   an added section duplicates a direction-less primary (the
   primary carries no direction, so its side is this one). */
export function resolveLoopSectionDirection(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
): "inner" | "outer" | null {
  const steps = loopSectionSteps(serviceId, fromStationId, toStationId);
  if (!steps) return null;
  return steps.forward <= steps.backward ? "outer" : "inner";
}

/* The canonical identity of one loop section: the undirected
   edge range it covers, as "start:steps" in the ordered
   stations' running order. An outer section starts at its
   from station and runs forward; an inner one starts at its
   to station and runs forward the other way round — so 大崎→目黒
   outer and 目黒→大崎 inner share the key, while the
   complementary arcs do not. A direction-less section takes
   the shorter way (resolveLoopSectionDirection). Null when an
   endpoint is not an ordered station, or the pair is degenerate. */
function loopArcKey(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
  direction: "inner" | "outer" | null,
): string | null {
  const steps = loopSectionSteps(serviceId, fromStationId, toStationId);
  if (!steps) return null;
  const dir =
    direction ?? (steps.forward <= steps.backward ? "outer" : "inner");
  const arcSteps = dir === "outer" ? steps.forward : steps.backward;
  const start = dir === "outer" ? steps.fromIdx : steps.toIdx;
  return `${start}:${arcSteps}`;
}

export type RecordedSectionInput = {
  fromStationId: string;
  toStationId: string;
  direction?: "inner" | "outer" | null;
};

/* Whether two recorded sections of one service are the same
   ride: the same stretch of the line, travelled either way.
   On a plain service the pair is the stretch (a section is
   undirected there — the clip swaps it into running order).
   On a loop the pair plus the side round the loop is the
   stretch: a direction-less section takes the shorter way by
   station steps, so 大崎→目黒 with no direction is the same
   ride as 大崎→目黒 outer, but not as inner; and 大崎→目黒
   outer is the same ride as 目黒→大崎 inner (the same arc,
   travelled the other way). Endpoints the master does not
   list as ordered stations cannot be resolved on a loop, so
   those compare as written (a direction-less primary and an
   explicit-direction addition stay distinct there). */
export function sectionsAreSameRide(
  serviceId: string,
  a: RecordedSectionInput,
  b: RecordedSectionInput,
): boolean {
  const aDir = a.direction ?? null;
  const bDir = b.direction ?? null;
  const samePair =
    (a.fromStationId === b.fromStationId &&
      a.toStationId === b.toStationId) ||
    (a.fromStationId === b.toStationId &&
      a.toStationId === b.fromStationId);
  if (!serviceIsLoop(serviceId)) return samePair;
  /* Both direction-less: the same fallback resolves both, so
     the unordered pair is the ride — even when the endpoints
     are not ordered stations (the clip's old behaviour for
     those is undirected too). */
  if (aDir === null && bDir === null) return samePair;
  const keyA = loopArcKey(serviceId, a.fromStationId, a.toStationId, aDir);
  const keyB = loopArcKey(serviceId, b.fromStationId, b.toStationId, bDir);
  if (keyA !== null && keyB !== null) return keyA === keyB;
  /* Unresolvable on a loop: compare as written. */
  return (
    a.fromStationId === b.fromStationId &&
    a.toStationId === b.toStationId &&
    aDir === bDir
  );
}

/* Whether a ledger row's service link can be confirmed by hand
   (subtask 1435): rows whose saved link disagrees with the current
   name rule (needsReview), plus rows a human already unlinked
   (explicit, no service) so an unlink can be undone by confirming
   again. A plain unlinked row (never linked, no provenance) is not
   reviewable — linking a never-linked row is not this operation. */
export function isRiddenServiceLinkReviewable(
  row: RiddenServiceLink,
): boolean {
  if (resolveRiddenService(row).needsReview) return true;
  return row.serviceId == null && row.serviceLinkSource === "explicit";
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

/* Every station a section endpoint may name, in running order
   (stage 3, subtask 1455): the boundary stations interleaved
   with the stations listed on each block. A loop's last entry is
   its first station again, like serviceBoundaryStations. */
export function serviceOrderedStations(
  serviceId: string,
): readonly StationRef[] {
  const blocks = blocksForService(serviceId);
  if (blocks.length === 0) return [];
  const stations: StationRef[] = [];
  const push = (station: StationRef) => {
    if (stations[stations.length - 1]?.id !== station.id) {
      stations.push(station);
    }
  };
  for (const block of blocks) {
    push(block.from);
    for (const station of block.stations ?? []) push(station);
    push(block.to);
  }
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

/* Validates a section (an added ride between two stations) for
   the stage-2 block input, extended in stage 3 (subtask 1455)
   to any two stations the service is known to serve. The
   endpoints must be stations of the service — a boundary
   station, or a station listed on one of its blocks (a section
   may span several whole blocks, and may start or end at a
   listed mid-block station, but it may not start or end at a
   station the master only knows from a migrated ride). On a
   non-loop service the pair may run either way: a section is
   one stretch of the line, and a real ride can travel it
   against the running order （東松戸→北府中 on the 武蔵野線
   return, review round 1, high) — the pair is stored as
   travelled, and the geometry treats it as undirected (the
   clip swaps it into running order, the route check reads it
   either way). On a loop the caller must also give the
   direction, since the same two stations can be joined either
   way round. Returns an error string, or null when the section
   is valid. This is the rule the server's addRiddenSection
   enforces; the client checks it first so a bad tap never
   reaches the server. */
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
  const ordered = serviceOrderedStations(serviceId);
  const fromIndex = ordered.findIndex((s) => s.id === fromStationId);
  const toIndex = ordered.findIndex((s) => s.id === toStationId);
  if (fromIndex < 0) {
    return `"${fromStationId}" is not a station of ${service.displayName}`;
  }
  if (toIndex < 0) {
    return `"${toStationId}" is not a station of ${service.displayName}`;
  }
  if (serviceIsLoop(serviceId)) {
    if (!direction) {
      return `${service.displayName} is a loop: a section needs a direction (inner/outer)`;
    }
    // Any two distinct stations join either way round a loop;
    // the direction says which way. No block is consulted: a
    // single block can be ridden either way — 新宿→渋谷 inner
    // runs yamanote/b2 （渋谷〜新宿) end to end, a real ride,
    // while the same endpoints outer are the long way round
    // the loop, which only shares the endpoints with b2
    // (review round 2, medium — the old block-direction check
    // rejected the inner ride for matching b2's endpoints).
    // The direction, when given, is checked against a named
    // blockId at the server instead (addRiddenSection), where
    // the block the ride claims to be is known.
    return null;
  }
  /* A non-loop section is one stretch of the line, travelled
     either way — no running-order check (see the comment above). */
  return null;
}

/* The stations a rider can board or leave this service at: the
   block boundaries and the stations listed on its blocks
   (serviceOrderedStations), plus the endpoints of the rides the
   SQL migration restored for the service — real mid-segment
   stops like 聖蹟桜ヶ丘 on 京王線, which the master knows only
   from those rides. Segment junctions are deliberately absent:
   a junction （西浦和・与野 on むさしの号） is where the route
   changes formal lines, not where its trains stop, so it is in
   serviceStationIds (known to the service) but not here. */
export function serviceBoardingStationIds(
  serviceId: string,
): ReadonlySet<string> {
  const ids = new Set(
    serviceOrderedStations(serviceId).map((station) => station.id),
  );
  for (const ride of Object.values(MIGRATED_RIDES)) {
    if (ride.serviceId !== serviceId) continue;
    if (ride.from) ids.add(ride.from.id);
    if (ride.to) ids.add(ride.to.id);
  }
  return ids;
}

/* Validates the endpoints of a NEW row-level partial ride (a
   line registered together with its section, via
   resolveRideFields): both must be stations of the service a
   rider can board or leave at (serviceBoardingStationIds).
   This is the boarding counterpart of validateSectionEndpoints,
   not the same rule: a section added to an existing row must
   also be provable against the blocks, so it may not end at a
   station the master only knows from a migrated ride — but a
   fresh registration may record exactly such a ride （京王線
   府中→聖蹟桜ヶ丘）, and refusing it would lose a real ride.
   What both rules refuse is a segment junction: 西浦和→大宮 on
   むさしの号 passed the format checks and was aggregated as
   7.77 km ridden although no むさしの号 train stops at 西浦和
   (batch review round 2, high). A loop service rejects here:
   the row carries no direction, and a loop ride without one
   cannot be read — loop sections are recorded through
   addRiddenSection, which takes the direction. Returns an
   error string, or null when the endpoints are valid. */
export function validateRideEndpoints(
  serviceId: string,
  fromStationId: string,
  toStationId: string,
): string | null {
  const service = serviceById(serviceId);
  if (!service) return `unknown service "${serviceId}"`;
  if (fromStationId === toStationId) {
    return "a ride needs two different stations";
  }
  const boardable = serviceBoardingStationIds(serviceId);
  if (!boardable.has(fromStationId)) {
    return `"${fromStationId}" is not a station of ${service.displayName}`;
  }
  if (!boardable.has(toStationId)) {
    return `"${toStationId}" is not a station of ${service.displayName}`;
  }
  if (serviceIsLoop(serviceId)) {
    return `${service.displayName} is a loop: a ride with a section needs a direction (inner/outer)`;
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
    via?: StationRef[];
  }[];
};

/* The snapshot a full ride stores, cut at `version` (default:
   the current master) from the segments that version's master
   held (serviceSegmentsAtVersion): a past full ride keeps
   reproducing the range it was recorded at even if the master
   later changes. Null when the service did not exist at that
   version. */
export function serviceFullPathSnapshot(
  serviceId: string,
  version: string = SERVICE_MASTER_VERSION,
): FullPathSnapshot | null {
  const service = serviceById(serviceId);
  if (!service) return null;
  const segments = serviceSegmentsAtVersion(serviceId, version);
  if (!segments) return null;
  return {
    pathId: service.pathId,
    masterVersion: version.trim(),
    segments: segments.map((segment) => ({
      formalLineKey: segment.formalLineKey,
      from: segment.from,
      to: segment.to,
      ...(segment.direction ? { direction: segment.direction } : {}),
      ...(segment.approximate ? { approximate: true } : {}),
      /* An empty via list is not a pin: it would pass every() on
         replay and leave the branch unpinned (subtask 1729), so
         only a non-empty list is written. */
      ...(segment.via?.length ? { via: segment.via } : {}),
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

/* The master versions a full ride may be recorded at: the
   current version, or any version in MASTER_VERSION_HISTORY.
   A full ride's range must be reproducible from its version, so
   an unknown version ("bogus", a blank, whitespace, or a date
   the master never carried, like 2026-11-25) must be rejected
   at save time (review round 2, high). */
export function isKnownMasterVersion(version: string): boolean {
  const v = version.trim();
  if (v === SERVICE_MASTER_VERSION) return true;
  return MASTER_VERSION_HISTORY.some((entry) => entry.version === v);
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

/* Past master versions, oldest first — the per-version record
   of what each master held (subtask 1611, review of 1566):
   bumping SERVICE_MASTER_VERSION used to orphan the version
   before it, so a full ride recorded at 2026-11-26 for
   しもうさ号 was rejected as unknown the day after the master
   moved to 2026-11-27. Each entry records the services that
   version's master held, and — only for a service whose route
   has since changed — the segments as they stood then. No
   service's route has changed between versions yet, so no
   entry carries segment overrides: a version's route is its
   service's current segments. The next segment change records
   its old route here at the same time as it bumps
   SERVICE_MASTER_VERSION, so a past full ride keeps
   reproducing the range it was recorded at.
   - 2026-11-24 is the frozen migration version: its master
     held exactly the nine services MIGRATED_RIDES restores
     (that table is the whole master of 2026-11-24).
   - 2026-11-26 (c5b125e) added むさしの号 and しもうさ号 to
     those nine. tobu-noda and keio-new-line first appear at
     SERVICE_MASTER_VERSION (2026-11-27). */
export type MasterVersionRecord = {
  version: string;
  serviceIds: readonly string[];
  segments?: Readonly<Record<string, readonly ServiceSegment[]>>;
};

export const MASTER_VERSION_HISTORY: readonly MasterVersionRecord[] = [
  {
    version: MIGRATED_MASTER_VERSION,
    serviceIds: Object.values(MIGRATED_RIDES).map(
      (ride) => ride.serviceId,
    ),
  },
  {
    version: "2026-11-26",
    serviceIds: [
      "jr-musashino",
      "jr-musashino-omiya",
      "jr-shimousa",
      "hokuso",
      "jr-chuo-rapid",
      "jr-sobu-rapid",
      "jr-sobu-local",
      "keio",
      "jr-saikyo",
      "rinkai",
      "yamanote",
    ],
  },
];

/* The segments of a service as a master version held them:
   that version's recorded route when one is on file, else the
   service's current segments (no route has changed between
   versions yet — see MASTER_VERSION_HISTORY). Null when the
   version never held the service, or the version is unknown. */
export function serviceSegmentsAtVersion(
  serviceId: string,
  version: string,
): readonly ServiceSegment[] | null {
  const v = version.trim();
  if (v === SERVICE_MASTER_VERSION) {
    return serviceById(serviceId)?.segments ?? null;
  }
  const entry = MASTER_VERSION_HISTORY.find((e) => e.version === v);
  if (!entry || !entry.serviceIds.includes(serviceId)) return null;
  return (
    entry.segments?.[serviceId] ?? serviceById(serviceId)?.segments ?? null
  );
}

/* Did the master at `version` hold this service at all? The
   current version holds every service in SERVICE_MASTER. A
   past version holds exactly the services its history entry
   lists. A full ride's range must be reproducible from the
   version it names, so a version whose master never held the
   service cannot record one (review batch round 1, subtask
   1593). An unknown version holds nothing. */
export function serviceExistsAtMasterVersion(
  serviceId: string,
  version: string,
): boolean {
  const v = version.trim();
  if (v === SERVICE_MASTER_VERSION) return serviceById(serviceId) != null;
  const entry = MASTER_VERSION_HISTORY.find((e) => e.version === v);
  if (!entry) return false;
  return entry.serviceIds.includes(serviceId);
}
