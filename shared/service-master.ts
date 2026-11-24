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
 * Shared by the client (display, resolution, expansion) and the
 * server (import defaults for new ledger rows), so it lives in
 * shared/ and stays free of DOM / platform imports. */

export type RideState = "unknown" | "partial" | "full";

export type VerificationStatus = "draft" | "verified";

/* One station, by N02 station group code (N02_005g) and name. */
export type StationRef = {
  id: string;
  name: string;
};

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
  note?: string;
};

export type ServiceMasterEntry = {
  /* Stable id for the service, used as the ledger rows' service_id. */
  id: string;
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
    displayName: "JR武蔵野線",
    ledgerNames: ["JR武蔵野線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "武蔵野線",
        formalLineKey: "武蔵野線|東日本旅客鉄道",
        from: { id: "003876", name: "府中本町" },
        to: { id: "003547", name: "西船橋" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "hokuso",
    displayName: "北総線",
    ledgerNames: ["北総線"],
    operator: "北総鉄道",
    segments: [
      {
        formalLineName: "北総線",
        formalLineKey: "北総線|北総鉄道",
        from: { id: "003248", name: "京成高砂" },
        to: { id: "003125", name: "印旛日本医大" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-chuo-rapid",
    displayName: "JR中央線（快速）",
    ledgerNames: ["JR中央線（快速）", "JR中央線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "中央線",
        formalLineKey: "中央線|東日本旅客鉄道",
        from: { id: "003766", name: "東京" },
        to: { id: "004029", name: "高尾" },
        note:
          "快速の運行範囲は東京〜高尾。N02の中央線単位はさらに先（塩尻方面）まで延びるが、快速としてはここまで。なおN02の駅ポイントに（東京, 中央線）の行は無い（東京駅のグループコード003766は他のJR線の行で確認済み）。駅IDは物理駅のコードであり、中央線が東京駅に発着することに変わりはない。",
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-sobu-rapid",
    displayName: "JR総武快速線",
    ledgerNames: ["JR総武快速線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "総武線",
        formalLineKey: "総武線|東日本旅客鉄道",
        from: { id: "003766", name: "東京" },
        to: { id: "004173", name: "千葉" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-sobu-local",
    displayName: "JR総武本線",
    ledgerNames: ["JR総武本線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "総武線",
        formalLineKey: "総武線|東日本旅客鉄道",
        from: { id: "003766", name: "東京" },
        to: { id: "003397", name: "銚子" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "keio",
    displayName: "京王線",
    ledgerNames: ["京王線"],
    operator: "京王電鉄",
    segments: [
      {
        formalLineName: "京王線",
        formalLineKey: "京王線|京王電鉄",
        from: { id: "003700", name: "新宿" },
        to: { id: "003934", name: "京王八王子" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "jr-saikyo",
    displayName: "JR埼京線",
    ledgerNames: ["JR埼京線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "山手線",
        formalLineKey: "山手線|東日本旅客鉄道",
        from: { id: "004135", name: "大崎" },
        to: { id: "003390", name: "池袋" },
        approximate: true,
        note:
          "山手貨物線の区間。N02 2025に貨物線の路線単位が無いため山手線（旅客）の形状で代用し、概算として扱う。",
      },
      {
        formalLineName: "赤羽線",
        formalLineKey: "赤羽線|東日本旅客鉄道",
        from: { id: "003390", name: "池袋" },
        to: { id: "003155", name: "赤羽" },
      },
      {
        formalLineName: "東北線",
        formalLineKey: "東北線|東日本旅客鉄道",
        from: { id: "003155", name: "赤羽" },
        to: { id: "002914", name: "大宮" },
        note: "通称・東北本線。N02の路線単位名は東北線。",
      },
      {
        formalLineName: "川越線",
        formalLineKey: "川越線|東日本旅客鉄道",
        from: { id: "002914", name: "大宮" },
        to: { id: "002909", name: "川越" },
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
    displayName: "りんかい線",
    ledgerNames: ["りんかい線"],
    operator: "東京臨海高速鉄道",
    segments: [
      {
        formalLineName: "臨海副都心線",
        formalLineKey: "臨海副都心線|東京臨海高速鉄道",
        from: { id: "003997", name: "新木場" },
        to: { id: "004135", name: "大崎" },
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
  {
    id: "yamanote",
    displayName: "山手線",
    ledgerNames: ["山手線"],
    operator: "東日本旅客鉄道",
    segments: [
      {
        formalLineName: "山手線",
        formalLineKey: "山手線|東日本旅客鉄道",
        from: { id: "004095", name: "品川" },
        to: { id: "004095", name: "品川" },
        note: "環状線のため起点＝終点（品川を起点とする慣例）。",
      },
    ],
    sources: [N02_SOURCE, LEDGER_SOURCE],
    verifiedAt: null,
    verificationStatus: "draft",
  },
];

export function serviceById(id: string): ServiceMasterEntry | undefined {
  return SERVICE_MASTER.find((entry) => entry.id === id);
}

export function serviceByLedgerName(
  ledgerName: string,
): ServiceMasterEntry | undefined {
  const name = ledgerName.trim();
  return SERVICE_MASTER.find((entry) => entry.ledgerNames.includes(name));
}

/* Expands a service into its formal lines, in running order —
   the 系統→正式線名 translation the map and the aggregates use. */
export function expandService(
  serviceId: string,
): readonly ServiceSegment[] {
  return serviceById(serviceId)?.segments ?? [];
}

/* The formal line names of a service, de-duplicated in order
   （埼京線 → 山手線・赤羽線・東北線・川越線）. */
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
   these; stage 1 keeps painting whole single-key lines as before). */
export function assetKeysForService(serviceId: string): string[] {
  return expandService(serviceId).map((segment) => segment.formalLineKey);
}

/* ------------------------------------------------------------------ */
/* The nine old ledger rows, migrated to the master.                  */
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

export const MIGRATED_RIDES: Readonly<Record<string, RestoredRide>> = {
  "JR武蔵野線": {
    serviceId: "jr-musashino",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "北総線": {
    serviceId: "hokuso",
    rideState: "unknown",
    from: null,
    to: null,
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "JR中央線（快速）": {
    serviceId: "jr-chuo-rapid",
    rideState: "partial",
    from: { id: "003606", name: "国分寺" },
    to: { id: "003766", name: "東京" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "JR総武快速線": {
    serviceId: "jr-sobu-rapid",
    rideState: "partial",
    from: { id: "003766", name: "東京" },
    to: { id: "004173", name: "千葉" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "JR総武本線": {
    serviceId: "jr-sobu-local",
    rideState: "partial",
    from: { id: "003531", name: "佐倉" },
    to: { id: "004173", name: "千葉" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "京王線": {
    serviceId: "keio",
    rideState: "partial",
    from: { id: "003821", name: "府中" },
    to: { id: "003971", name: "聖蹟桜ヶ丘" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "JR埼京線": {
    serviceId: "jr-saikyo",
    rideState: "partial",
    from: { id: "003700", name: "新宿" },
    to: { id: "004135", name: "大崎" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "りんかい線": {
    serviceId: "rinkai",
    rideState: "partial",
    from: { id: "004135", name: "大崎" },
    to: { id: "004182", name: "品川シーサイド" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
  "山手線": {
    serviceId: "yamanote",
    rideState: "partial",
    from: { id: "004135", name: "大崎" },
    to: { id: "004072", name: "目黒" },
    masterVersion: SERVICE_MASTER_VERSION,
  },
};
