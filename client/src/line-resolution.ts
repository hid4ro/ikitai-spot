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
   line-resolution.test.ts.

   Rows that carry a saved service_id resolve from that id, not
   from their name (review finding 5): the recorded name may be an
   alias （「JR中央線」 for the rapid service) or a spelling the
   master maps differently, and the saved id is the record of which
   service was actually ridden. The id is only trusted when the
   master knows it; an unknown id falls back to name resolution. */

/* Operator brand prefixes a ledger name may carry in front of the
   asset's line name （西武池袋線 → 池袋線）. */
import {
  assetKeysForService,
  isStaleAutoLink,
  normalizeParentheses,
  serviceById,
  serviceByLedgerName,
  type ServiceMasterEntry,
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

/* The service a ledger row belongs to: its saved service_id when
   the master knows it, otherwise the service its name spells.
   Exported so the ledger list shows the same service the
   aggregates count (review round 4, low): a row that resolves to a
   service shows that service's display name, whether or not a
   service_id was saved with it.
   A saved id is trusted only while the recorded name still
   resolves to it (review round 5, medium): a link the old
   auto-link produced but the current rules disagree with is stale
   — the row falls back to its name, which resolves to no service,
   so it keeps its recorded name and counts for nothing until the
   stored id is cleared on re-registration / re-import. A link the
   old code could not have produced is still trusted: it may be an
   explicit link a caller chose. */
export function serviceForRow(
  ledgerName: string,
  serviceId?: string | null,
): ServiceMasterEntry | undefined {
  if (serviceId) {
    const saved = serviceById(serviceId);
    if (saved && !isStaleAutoLink(ledgerName, serviceId)) return saved;
  }
  return serviceByLedgerName(ledgerName);
}

/* The operator a geometry entry belongs to, for the fallback's
   note check below — null when the entry carries none. */
function operatorOfGeometry(
  entry: unknown,
): string | null {
  if (typeof entry !== "object" || entry === null) return null;
  const operator = (entry as Record<string, unknown>).operator;
  return typeof operator === "string" ? operator : null;
}

/* The operator a parenthetical note names, if it names one: the
   note (JR prefix stripped) must start an operator's name or be
   started by it — the same abbreviation rule the master uses.
   Null when the note names no operator in the data (a service
   name, 「快速」, …), in which case the note is not an operator
   claim at all and the fallback strips it as before. */
function operatorNamedByNote(
  note: string,
  operators: ReadonlySet<string>,
): string | null {
  const q = note.trim().replace(/^(?:JR|ＪＲ)/, "");
  if (!q) return null;
  for (const operator of operators) {
    if (operator.startsWith(q) || q.startsWith(operator)) return operator;
  }
  return null;
}

/* Resolves a ledger line name to its single asset key. The saved
   service_id answers first when given; names the master does not
   cover fall back to normalization: unify the paren width and the
   spaces around and inside the parentheses (review round 5, low —
   「西武池袋線 (西武鉄道)」 is the same spelling as
   「西武池袋線（西武鉄道）」), strip a leading 「JR」, strip a
   trailing 「（…）」, then —
   (a) try the name exactly as it stands: a line whose name IS the
       brand plus 「線」 (京王線) must resolve here, before any brand
       is stripped off it;
   (b) strip a leading operator brand ONLY when the remainder is
       itself a real line name in the asset — stripping 京王 off
       京王線 would leave just 「線」, which names nothing.
   A trailing note that names an operator must name the candidate
   line's own operator: 「西武池袋線（東武鉄道）」 contradicts its
   candidate and resolves to nothing, while a note that names no
   operator （「快速」) is stripped as before.
   Returns null when nothing resolves — the line then simply has no
   track drawn and no color chip. Multi-line services also return
   null here (no single key exists); their expansion is
   resolveRiddenLineKeys. */
export function resolveRiddenLineKey(
  ledgerName: string,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
  serviceId?: string | null,
): string | null {
  const service = serviceForRow(ledgerName, serviceId);
  if (service) {
    const keys = assetKeysForService(service.id);
    // Exactly one formal line: the service IS that line.
    if (keys.length === 1 && geometries[keys[0]!]) return keys[0]!;
    return null;
  }
  let name = normalizeParentheses(ledgerName);
  if (name.startsWith("JR")) name = name.slice(2);
  const noteMatch = name.match(/（([^）]*)）$/);
  const note = noteMatch?.[1] ?? null;
  if (noteMatch) name = name.slice(0, noteMatch.index);
  const exact = keyByName.get(name);
  let key: string | null = exact ?? null;
  if (!key) {
    for (const prefix of LINE_OPERATOR_PREFIXES) {
      if (name.startsWith(prefix)) {
        const stripped = keyByName.get(name.slice(prefix.length));
        if (stripped) {
          key = stripped;
          break;
        }
      }
    }
  }
  if (!key || !note) return key;
  const operators = new Set<string>();
  for (const entry of Object.values(geometries)) {
    const operator = operatorOfGeometry(entry);
    if (operator) operators.add(operator);
  }
  const namedOperator = operatorNamedByNote(note, operators);
  if (namedOperator && operatorOfGeometry(geometries[key]) !== namedOperator) {
    return null;
  }
  return key;
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
  serviceId?: string | null,
): string[] {
  const service = serviceForRow(ledgerName, serviceId);
  if (service) {
    return assetKeysForService(service.id).filter((key) => geometries[key]);
  }
  const key = resolveRiddenLineKey(ledgerName, geometries, keyByName);
  return key ? [key] : [];
}

/* Ridden-line counts per operator for the 事業者別 chart, counted
   per DISTINCT SERVICE — not per ledger row and not per distinct
   resolved key. Two rows that name the same service （「JR中央線」
   and 「JR中央線（快速）」 are both jr-chuo-rapid; 「りんかい線」
   and 「臨海副都心線」 are both rinkai) count once: they are one
   service recorded under two spellings, and counting both would
   let one operator's bar exceed its line total (the 2/1 the
   review reproduced). Two different services that share one asset
   line (JR総武快速線 and JR総武本線 are both 「総武線」) still
   count as two — they are two rides on two services. A row's
   service comes from its saved service_id when the master knows
   it, otherwise from its name; rows with no known service fall
   back to their resolved asset line and count once per key. Rows
   that resolve to nothing count for no operator. The denominator
   (LINE_OPERATOR_TOTALS, N02 lines per operator) counts lines,
   not services — the two coincide for single-service lines, and
   the bar can no longer overflow it by double-counting one
   service under two names. */
export type RiddenLineRow = {
  name: string;
  serviceId?: string | null;
};

export function countRiddenByOperator(
  rows: readonly RiddenLineRow[],
  geometries: Readonly<Record<string, { operator: string }>>,
  keyByName: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const tokensByOperator = new Map<string, Set<string>>();
  for (const row of rows) {
    const service = serviceForRow(row.name, row.serviceId ?? null);
    let operator: string | null = null;
    let token: string | null = null;
    if (service) {
      operator = service.operator;
      token = `service:${service.id}`;
    } else {
      const key = resolveRiddenLineKey(row.name, geometries, keyByName);
      if (key) {
        operator = geometries[key]?.operator ?? null;
        token = `key:${key}`;
      }
    }
    if (!operator || !token) continue;
    let tokens = tokensByOperator.get(operator);
    if (!tokens) {
      tokens = new Set<string>();
      tokensByOperator.set(operator, tokens);
    }
    tokens.add(token);
  }
  const counts = new Map<string, number>();
  for (const [operator, tokens] of tokensByOperator) {
    counts.set(operator, tokens.size);
  }
  return counts;
}

/* How many distinct services-or-lines the ledger's rows amount to:
   the national donut's numerator (review round 2). The token is the
   same one countRiddenByOperator uses — a service id when the row
   links to a service, otherwise its resolved asset key — so the
   nine legacy rows count 9, not the 6 distinct keys the donut used
   to show. The 6-key count dropped JR埼京線 and 山手線 because
   they paint nothing in stage 1, but they were still ridden, and
   the 事業者別 chart already counts them — the donut now agrees
   with it. The denominator stays the 597 N02 line units;
   systematizing it is stage 2's distance-conquest work (see
   DATA-PLAN.md). */
export function countRiddenServices(
  rows: readonly RiddenLineRow[],
  geometries: Readonly<Record<string, { operator: string }>>,
  keyByName: ReadonlyMap<string, string>,
): number {
  const counts = countRiddenByOperator(rows, geometries, keyByName);
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}
