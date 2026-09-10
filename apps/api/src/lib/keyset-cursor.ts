// SPDX-License-Identifier: Apache-2.0
/**
 * Shared keyset pagination cursor.
 *
 * Keyset, not offset. An offset page re-runs the whole query and skips N rows,
 * so a row inserted or removed between two pages shifts every later row and the
 * walk silently repeats or skips items. A keyset cursor names the exact row the
 * next page starts after, so concurrent writes cannot corrupt a walk.
 *
 * The cursor is filter-bound. It carries a `filterKey` describing the filter set
 * it was minted under, and decoding refuses a token whose key does not match the
 * current request. Without that, a caller who changes a filter mid-walk and
 * replays the previous `nextCursor` gets a page from the *new* filter positioned
 * by the *old* one — wrong rows, silently, with a 200. This generalizes the
 * implementation that already lived in `services/issues.ts`, which was the only
 * one of four hand-rolled cursors in this tree to get that right.
 *
 * Sort keys are generic: the common case orders by `createdAt|id`, but a
 * leaderboard-style query ordering by a numeric score (`services/karma.ts`) uses
 * the same envelope with a string-encoded key. `id` is always the tiebreaker, so
 * the ordering is total even when the primary key repeats.
 */

/** A cursor the server cannot parse. Callers MUST surface this as a 400 — never
 * as an empty 200, which is byte-identical to "you have no rows". */
export class InvalidCursorError extends Error {}

/** A cursor minted under a different filter set. Same reasoning: never an empty
 * 200, always an explicit refusal telling the caller to restart paging. */
export class CursorFilterMismatchError extends Error {}

/** Current envelope version. Bump only on a breaking shape change; `decodeCursor`
 * rejects anything it does not recognize rather than guessing. */
const CURSOR_VERSION = 1;

export interface CursorPosition {
  /** Primary sort key, as encoded. Callers convert to Date/number as needed. */
  key: string;
  /** Tiebreaker row id. */
  id: string;
}

/**
 * Builds the filter fingerprint a cursor is bound to.
 *
 * Pass every value that changes which rows the query returns — a filter omitted
 * here is a filter a stale cursor can be replayed across. Order matters and must
 * be stable, so callers should use a fixed field order. Values are joined with a
 * separator no realistic value contains after escaping.
 */
export function filterKeyOf(parts: ReadonlyArray<string | number | boolean | Date | null | undefined>): string {
  return parts
    .map((p) => {
      if (p === null || p === undefined) return "";
      if (p instanceof Date) return p.toISOString();
      return String(p);
    })
    .map((s) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"))
    .join("|");
}

/** Encodes the position of the LAST row on the page just served. */
export function encodeCursor(key: string | Date | number, id: string, filterKey: string): string {
  const encodedKey = key instanceof Date ? key.toISOString() : String(key);
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, c: encodedKey, i: id, f: filterKey }), "utf8").toString(
    "base64url",
  );
}

/**
 * Decodes a cursor, refusing anything malformed or minted under another filter.
 *
 * @throws InvalidCursorError       token is unparseable, wrong version, or wrong shape
 * @throws CursorFilterMismatchError token was minted under a different filter set
 */
export function decodeCursor(token: string, filterKey: string, label = "list"): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError(`Invalid ${label} cursor.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidCursorError(`Invalid ${label} cursor.`);
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj["v"] !== CURSOR_VERSION ||
    typeof obj["c"] !== "string" ||
    typeof obj["i"] !== "string" ||
    typeof obj["f"] !== "string"
  ) {
    throw new InvalidCursorError(`Invalid ${label} cursor.`);
  }
  if (obj["f"] !== filterKey) {
    throw new CursorFilterMismatchError(
      `Cursor belongs to a different ${label} filter. Restart paging with the new filter.`,
    );
  }
  return { key: obj["c"], id: obj["i"] };
}

/** Decodes a cursor whose primary sort key is a timestamp, validating the date. */
export function decodeDateCursor(
  token: string,
  filterKey: string,
  label = "list",
): { createdAt: Date; id: string } {
  const { key, id } = decodeCursor(token, filterKey, label);
  const createdAt = new Date(key);
  if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError(`Invalid ${label} cursor.`);
  return { createdAt, id };
}

/**
 * Splits an over-fetched result into one page plus the `hasMore` signal.
 *
 * Query `limit + 1` rows and pass them here. Using the extra row — rather than
 * `rows.length === limit` — is what makes `hasMore` truthful when the total is an
 * exact multiple of the page size, where the naive check reports a further page
 * that does not exist.
 */
export function takePage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}