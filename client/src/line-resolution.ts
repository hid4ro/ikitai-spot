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

   Rows with a link that needs confirmation stay outside both
   the service master and the asset fallback. */

import {
  assetKeysForService,
  normalizeParentheses,
  resolveRiddenService,
  serviceByLedgerName,
  type RiddenServiceLink,
  type ServiceMasterEntry,
} from "../../shared/service-master";

/* Brand spellings that can precede a formal line name. */
const OPERATOR_BY_PREFIX = new Map([
  ["西武", "西武鉄道"],
  ["東武", "東武鉄道"],
  ["京成", "京成電鉄"],
  ["京急", "京浜急行電鉄"],
  ["京王", "京王電鉄"],
  ["小田急", "小田急電鉄"],
  ["東急", "東急電鉄"],
  ["相鉄", "相模鉄道"],
  ["北総", "北総鉄道"],
  ["都営", "東京都"],
  ["東葉", "東葉高速鉄道"],
  ["埼玉高速", "埼玉高速鉄道"],
  ["つくばエクスプレス", "首都圏新都市鉄道"],
]);
const LINE_OPERATOR_PREFIXES = ["JR", "ＪＲ", ...OPERATOR_BY_PREFIX.keys()];

/* Line name → asset key, for the normalization fallback below. A name
   shared by two operators (「本線」) is ambiguous and left out:
   guessing would paint the wrong operator's track. */
export function buildLineKeyByName(
  geometries: Readonly<Record<string, { name: string }>>,
): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const map = new Map<string, string>();
  for (const [key, entry] of Object.entries(geometries)) {
    const name = normalizeParentheses(entry.name);
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count === 1) map.set(name, key);
    else map.delete(name);
  }
  return map;
}

export type RiddenLineRow = RiddenServiceLink;

function asRiddenLineRow(
  nameOrRow: string | RiddenLineRow,
  serviceId?: string | null,
): RiddenLineRow {
  return typeof nameOrRow === "string" ? { name: nameOrRow, serviceId } : nameOrRow;
}

/* The ledger displays the same service the aggregates count. */
export function serviceForRow(
  nameOrRow: string | RiddenLineRow,
  serviceId?: string | null,
): ServiceMasterEntry | undefined {
  return resolveRiddenService(asRiddenLineRow(nameOrRow, serviceId)).service;
}

function geometryText(
  entry: unknown,
  field: "name" | "operator",
): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function splitOperatorPrefix(name: string) {
  const prefix = LINE_OPERATOR_PREFIXES.find((value) => name.startsWith(value));
  return { prefix, lineName: prefix ? name.slice(prefix.length) : name };
}

function matchesOperatorPrefix(prefix: string, operator: string | undefined) {
  if (!operator) return false;
  if (prefix === "JR" || prefix === "ＪＲ") {
    return /^(?:北海道|東日本|東海|西日本|四国|九州)旅客鉄道$/.test(operator);
  }
  return OPERATOR_BY_PREFIX.get(prefix) === operator;
}

/* An outer brand and any identities in the parenthetical note must
   describe the same geometry. Unrecognized notes such as 「快速」
   remain descriptive. */
function resolveGeometryByLedgerName(
  ledgerName: string,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
): string | null {
  const normalized = normalizeParentheses(ledgerName);
  const noteMatch = normalized.match(/（([^（）]*)）$/);
  const note = noteMatch?.[1];
  const name = noteMatch ? normalized.slice(0, noteMatch.index) : normalized;
  const { prefix, lineName } = splitOperatorPrefix(name);
  // A complete formal name can include its own brand or parentheses.
  const exactFullName = keyByName.get(normalized);
  const exact = exactFullName ?? keyByName.get(name);
  const key = exact ?? keyByName.get(lineName);
  if (!key) return null;

  const operator = geometryText(geometries[key], "operator");
  if (prefix && (!exact || operator) && !matchesOperatorPrefix(prefix, operator)) {
    return null;
  }
  if (exactFullName || !note) return key;

  const entries = Object.values(geometries);
  if (LINE_OPERATOR_PREFIXES.includes(note)) {
    if (!matchesOperatorPrefix(note, operator)) return null;
  } else {
    const operatorNote = note.replace(/^(?:JR|ＪＲ)/, "");
    const operators = entries.map((entry) => geometryText(entry, "operator"));
    const matchesOperatorNote = (value: string | undefined) =>
      !!value && (value.startsWith(operatorNote) || operatorNote.startsWith(value));
    if (operators.includes(operatorNote)) {
      if (operator !== operatorNote) return null;
    } else if (!matchesOperatorNote(operator) && operators.some(matchesOperatorNote)) {
      return null;
    }
  }

  const candidateName = geometryText(geometries[key], "name");
  const isKnownLine = (value: string) =>
    entries.some((entry) => geometryText(entry, "name") === value);
  if (isKnownLine(note)) return note === candidateName ? key : null;

  const noteParts = splitOperatorPrefix(note);
  if (noteParts.prefix && isKnownLine(noteParts.lineName)) {
    return noteParts.lineName === candidateName && matchesOperatorPrefix(noteParts.prefix, operator)
      ? key
      : null;
  }

  const notedService = serviceByLedgerName(note);
  if (notedService) {
    const keys = assetKeysForService(notedService.id);
    return keys.length === 1 && keys[0] === key ? key : null;
  }
  return key;
}

/* Resolve a master service or an asset fallback to one key. Use
   resolveRiddenLineKeys to expand a multi-line service. */
export function resolveRiddenLineKey(
  nameOrRow: string | RiddenLineRow,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
  serviceId?: string | null,
): string | null {
  const row = asRiddenLineRow(nameOrRow, serviceId);
  const { service, needsReview } = resolveRiddenService(row);
  if (needsReview) return null;
  if (service) {
    const keys = assetKeysForService(service.id);
    // Exactly one formal line: the service IS that line.
    if (keys.length === 1 && geometries[keys[0]!]) return keys[0]!;
    return null;
  }
  return resolveGeometryByLedgerName(row.name, geometries, keyByName);
}

/* All asset keys a ledger line expands to, in running order — the
   formal lines the service runs on. Single-line services return
   their one key; multi-line services return every segment's key;
   unknown names fall back to the single-key resolution (or nothing).
   Stage 2 paints only the ridden section of these keys; stage 1
   keeps painting whole single-key lines, so this is used for the
   expansion itself and for tests until then. */
export function resolveRiddenLineKeys(
  nameOrRow: string | RiddenLineRow,
  geometries: Readonly<Record<string, unknown>>,
  keyByName: ReadonlyMap<string, string>,
  serviceId?: string | null,
): string[] {
  const row = asRiddenLineRow(nameOrRow, serviceId);
  const { service, needsReview } = resolveRiddenService(row);
  if (needsReview) return [];
  if (service) {
    return assetKeysForService(service.id).filter((key) => geometries[key]);
  }
  const key = resolveGeometryByLedgerName(row.name, geometries, keyByName);
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
   count as two — they are two rides on two services. Unlinked
   rows can count once per resolved asset key. Rows that need
   link confirmation are excluded from both counts. The denominator
   (LINE_OPERATOR_TOTALS, N02 lines per operator) counts lines,
   not services — the two coincide for single-service lines, and
   the bar can no longer overflow it by double-counting one
   service under two names. */
export function countRiddenByOperator(
  rows: readonly RiddenLineRow[],
  geometries: Readonly<Record<string, { operator: string }>>,
  keyByName: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const tokensByOperator = new Map<string, Set<string>>();
  for (const row of rows) {
    const { service, needsReview } = resolveRiddenService(row);
    if (needsReview) continue;
    let operator: string | null = null;
    let token: string | null = null;
    if (service) {
      operator = service.operator;
      token = `service:${service.id}`;
    } else {
      const key = resolveGeometryByLedgerName(row.name, geometries, keyByName);
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
