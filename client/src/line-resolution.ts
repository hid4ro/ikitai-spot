/* Ledger line-name resolution: turns a ridden-lines ledger name
   (e.g. 「JR総武快速線」) into its key in the bundled line asset
   (「総武線|東日本旅客鉄道」). Kept dependency-light (the asset maps
   are passed in) so the rules can be regression-tested directly
   against the real asset — see line-resolution.test.ts. */

/* Operator brand prefixes a ledger name may carry in front of the
   asset's line name （西武池袋線 → 池袋線）. */
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

/* Resolves a ledger line name to its asset key. The bundled
   ledger-name map answers first; names it does not cover (or maps to
   null) fall back to normalization: strip a leading 「JR」, strip a
   trailing 「（…）」, then —
   (a) try the name exactly as it stands: a line whose name IS the
       brand plus 「線」 (京王線) must resolve here, before any brand
       is stripped off it;
   (b) strip a leading operator brand ONLY when the remainder is
       itself a real line name in the asset — stripping 京王 off
       京王線 would leave just 「線」, which names nothing.
   Returns null when nothing resolves — the line then simply has no
   track drawn and no color chip. */
export function resolveRiddenLineKey(
  ledgerName: string,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
  ledgerMap: Readonly<Record<string, string | null>>,
): string | null {
  const mapped = ledgerMap[ledgerName];
  if (mapped && geometries[mapped]) return mapped;
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

/* Ridden-line counts per operator for the 事業者別 chart, counted
   per LEDGER ROW — not per distinct resolved key. JR総武快速線 and
   JR総武本線 are two separate rides that share the one asset line
   「総武線|東日本旅客鉄道」; counting distinct keys would collapse
   them into one and understate 東日本旅客鉄道 by a ride. (The map
   overlay and the headline 路線 count keep using the distinct-key
   set: one painted track per asset line, and a numerator that stays
   comparable to the 597-line national total.) Rows that do not
   resolve (e.g. JR埼京線, absent from the N02 master) count for no
   operator. */
export function countRiddenByOperator(
  ledgerNames: readonly string[],
  geometries: Readonly<Record<string, { operator: string }>>,
  keyByName: ReadonlyMap<string, string>,
  ledgerMap: Readonly<Record<string, string | null>>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const ledgerName of ledgerNames) {
    const key = resolveRiddenLineKey(ledgerName, geometries, keyByName, ledgerMap);
    if (!key) continue;
    const entry = geometries[key];
    if (!entry) continue;
    counts.set(entry.operator, (counts.get(entry.operator) ?? 0) + 1);
  }
  return counts;
}
