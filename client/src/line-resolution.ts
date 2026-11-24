/* Ledger line-name resolution, now backed by the service master
   (shared/service-master.ts). A ledger name (e.g. 「JR総武快速線」)
   is first looked up as a service: single-line services resolve to
   their one formal line's asset key (「総武線|東日本旅客鉄道」),
   multi-line services (JR埼京線 → 山手線・赤羽線・東北線・川越線)
   have no single key and resolve to null here — use
   resolveRiddenLineKeys for their full expansion. Names the master
   does not know fall back to the normalization rules below, so a
   future ledger spelling still resolves when it names a real line.
   Kept dependency-light (the asset maps are passed in) so the rules
   can be regression-tested directly against the real asset — see
   line-resolution.test.ts. */

/* Operator brand prefixes a ledger name may carry in front of the
   asset's line name （西武池袋線 → 池袋線）. */
import {
  assetKeysForService,
  serviceByLedgerName,
} from "../../shared/service-master";

export const LINE_OPERATOR_PREFIXES = [
  "西武",
  "東武",
  "京成",
  "京急",
  "京王",
  "小田急",
  "東急",
  "相鉄",
  "北総",
  "都営",
  "東葉",
  "埼玉高速",
  "つくばエクスプレス",
];

/* Line name → asset key, for the normalization fallback below. A name
   shared by two operators (「本線」) is ambiguous and left out:
   guessing would paint the wrong operator's track. */
export function buildLineKeyByName(
  geometries: Readonly<Record<string, { name: string }>>,
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  for (const entry of Object.values(geometries)) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  }
  const map = new Map<string, string>();
  for (const [key, entry] of Object.entries(geometries)) {
    if (counts.get(entry.name) === 1) map.set(entry.name, key);
  }
  return map;
}

/* Resolves a ledger line name to its single asset key. The service
   master answers first; names it does not cover fall back to
   normalization: strip a leading 「JR」, strip a trailing 「（…）」,
   then —
   (a) try the name exactly as it stands: a line whose name IS the
       brand plus 「線」 (京王線) must resolve here, before any brand
       is stripped off it;
   (b) strip a leading operator brand ONLY when the remainder is
       itself a real line name in the asset — stripping 京王 off
       京王線 would leave just 「線」, which names nothing.
   Returns null when nothing resolves — the line then simply has no
   track drawn and no color chip. Multi-line services also return
   null here (no single key exists); their expansion is
   resolveRiddenLineKeys. */
export function resolveRiddenLineKey(
  ledgerName: string,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
): string | null {
  const service = serviceByLedgerName(ledgerName);
  if (service) {
    const keys = assetKeysForService(service.id);
    // Exactly one formal line: the service IS that line.
    if (keys.length === 1 && geometries[keys[0]!]) return keys[0]!;
    return null;
  }
  let name = ledgerName.trim();
  if (name.startsWith("JR")) name = name.slice(2);
  name = name.replace(/（[^）]*）$/, "");
  const exact = keyByName.get(name);
  if (exact) return exact;
  for (const prefix of LINE_OPERATOR_PREFIXES) {
    if (name.startsWith(prefix)) {
      const stripped = keyByName.get(name.slice(prefix.length));
      if (stripped) return stripped;
    }
  }
  return null;
}

/* All asset keys a ledger line expands to, in running order — the
   formal lines the service runs on. Single-line services return
   their one key; multi-line services return every segment's key;
   unknown names fall back to the single-key resolution (or nothing).
   Stage 2 paints only the ridden section of these keys; stage 1
   keeps painting whole single-key lines, so this is used for the
   expansion itself and for tests until then. */
export function resolveRiddenLineKeys(
  ledgerName: string,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
): string[] {
  const service = serviceByLedgerName(ledgerName);
  if (service) {
    return assetKeysForService(service.id).filter((key) => geometries[key]);
  }
  const key = resolveRiddenLineKey(ledgerName, geometries, keyByName);
  return key ? [key] : [];
}

/* Ridden-line counts per operator for the 事業者別 chart, counted
   per LEDGER ROW — not per distinct resolved key. JR総武快速線 and
   JR総武本線 are two separate rides that share the one asset line
   「総武線|東日本旅客鉄道」; counting distinct keys would collapse
   them into one and understate 東日本旅客鉄道 by a ride. (The map
   overlay and the headline 路線 count keep using the distinct-key
   set: one painted track per asset line, and a numerator that stays
   comparable to the 597-line national total.) A row's operator comes
   from its service in the master — JR埼京線 counts for 東日本旅客鉄道
   now that the master records it as a JR East service — and only
   falls back to the resolved asset line's operator for names the
   master does not know. Rows that resolve to nothing count for no
   operator. */
export function countRiddenByOperator(
  ledgerNames: readonly string[],
  geometries: Readonly<Record<string, { operator: string }>>,
  keyByName: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const ledgerName of ledgerNames) {
    const service = serviceByLedgerName(ledgerName);
    const operator =
      service?.operator ??
      (() => {
        const key = resolveRiddenLineKey(ledgerName, geometries, keyByName);
        return key ? (geometries[key]?.operator ?? null) : null;
      })();
    if (!operator) continue;
    counts.set(operator, (counts.get(operator) ?? 0) + 1);
  }
  return counts;
}
