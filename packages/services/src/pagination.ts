import { type RawBuilder, type SelectQueryBuilder, sql } from "kysely";
import { ServiceError } from "./errors";

// Opt-in keyset pagination for list endpoints. See docs/plans/api-list-pagination.md.

export const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_BYTES = 1024;
const CURSOR_VERSION = 1;

export interface PageRequest {
    limit: number;
    cursor?: string;
}

export interface Page<T> {
    items: T[];
    // Opaque cursor for the page after this one, or null on the last page.
    next: string | null;
}

// A sort key. `ref` is a trusted column reference written in code, never client input.
// The last key of a spec is the unique tiebreak. Values travel as text and are cast in SQL.
export interface PageKey {
    ref: string;
    type: "timestamptz" | "text" | "bigint" | "uuid";
    desc?: boolean;
}

export interface PageSpec {
    // Fixed per list (and per parent), so a cursor is refused on any other list.
    route: string;
    // The organization from the path; empty for lists that are not organization-scoped.
    organizationId: string;
    keys: readonly PageKey[];
}

const invalidCursor = () =>
    new ServiceError("invalid", "The cursor is not valid for this request.");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const BIGINT = /^\d{1,18}$/;
const TEXT_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Rejects dates the pattern allows but the calendar does not, such as February 30.
function realInstant(value: string): boolean {
    const date = new Date(`${value.slice(0, 19)}Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value.slice(0, 19));
}

function validValue(key: PageKey, value: unknown, isTiebreak: boolean): value is string {
    if (typeof value !== "string") return false;
    switch (key.type) {
        case "uuid":
            return UUID.test(value);
        case "timestamptz":
            return TIMESTAMP.test(value) && realInstant(value);
        case "bigint":
            return BIGINT.test(value);
        case "text":
            return isTiebreak
                ? TEXT_ID.test(value)
                : value.length >= 1 && value.length <= 320 && !value.includes("\u0000");
    }
}

interface Decoded {
    values: string[];
}

export function encodeCursor(spec: PageSpec, values: string[]): string {
    const payload = {
        v: CURSOR_VERSION,
        r: spec.route,
        o: spec.organizationId,
        k: values.slice(0, -1),
        id: values.at(-1),
    };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

// Strict: size cap, exact keys, version, value shapes, and binding to this route and
// organization. Anything else is a 422, and nothing in it ever reaches SQL unvalidated.
export function decodeCursor(spec: PageSpec, cursor: string): Decoded {
    if (cursor.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw invalidCursor();
    }
    let payload: unknown;
    try {
        payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        throw invalidCursor();
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw invalidCursor();
    }
    const record = payload as Record<string, unknown>;
    const names = Object.keys(record).sort();
    if (names.join(",") !== "id,k,o,r,v") throw invalidCursor();
    if (
        record.v !== CURSOR_VERSION ||
        record.r !== spec.route ||
        record.o !== spec.organizationId
    ) {
        throw invalidCursor();
    }
    if (!Array.isArray(record.k) || record.k.length !== spec.keys.length - 1) {
        throw invalidCursor();
    }
    const values = [...(record.k as unknown[]), record.id];
    for (const [i, key] of spec.keys.entries()) {
        if (!validValue(key, values[i], i === spec.keys.length - 1)) throw invalidCursor();
    }
    return { values: values as string[] };
}

// `limit` and `cursor` from the request's query string. Undefined when the caller did not
// ask for pagination, which keeps the unpaginated response exactly as it was.
export function parsePageQuery(search: URLSearchParams): PageRequest | undefined {
    const limits = search.getAll("limit");
    const cursors = search.getAll("cursor");
    if (limits.length === 0) {
        if (cursors.length > 0) throw new ServiceError("invalid", "cursor needs a limit.");
        return undefined;
    }
    if (limits.length > 1 || cursors.length > 1) {
        throw new ServiceError("invalid", "Send limit and cursor at most once.");
    }
    const raw = limits[0]!;
    if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > MAX_PAGE_LIMIT) {
        throw new ServiceError("invalid", `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
    }
    const cursor = cursors[0];
    if (cursor !== undefined && cursor.length === 0) throw invalidCursor();
    return { limit: Number(raw), ...(cursor === undefined ? {} : { cursor }) };
}

function cast(key: PageKey, value: string): RawBuilder<unknown> {
    switch (key.type) {
        case "timestamptz":
            return sql`${value}::timestamptz`;
        case "bigint":
            return sql`${value}::bigint`;
        case "uuid":
            return sql`${value}::uuid`;
        case "text":
            return sql`${value}::text`;
    }
}

// The builders are generic over the caller's table and columns; the `any`s only erase that.
function order<Q extends SelectQueryBuilder<any, any, any>>(query: Q, spec: PageSpec): Q {
    let ordered: SelectQueryBuilder<any, any, any> = query;
    for (const key of spec.keys) {
        ordered = ordered.orderBy(sql`${sql.ref(key.ref)} ${sql.raw(key.desc ? "desc" : "asc")}`);
    }
    return ordered as Q;
}

// Rows after the boundary in the list's own order, expanded per key because directions may
// differ (`created_at desc, id`).
function after(spec: PageSpec, values: string[]): RawBuilder<boolean> {
    const terms = spec.keys.map((key, i) => {
        const parts = spec.keys
            .slice(0, i)
            .map((previous, j) => sql`${sql.ref(previous.ref)} = ${cast(previous, values[j]!)}`);
        parts.push(
            sql`${sql.ref(key.ref)} ${sql.raw(key.desc ? "<" : ">")} ${cast(key, values[i]!)}`,
        );
        return sql`(${sql.join(parts, sql` and `)})`;
    });
    return sql<boolean>`(${sql.join(terms, sql` or `)})`;
}

const KEY_PREFIX = "__page_key_";

// The same ordering as an unpaginated call, with the list's unique tiebreak as the last key.
export function orderedRows<O>(
    query: SelectQueryBuilder<any, any, O>,
    spec: PageSpec,
): Promise<O[]> {
    return order(query, spec).execute();
}

export async function pageRows<O>(
    query: SelectQueryBuilder<any, any, O>,
    spec: PageSpec,
    page: PageRequest,
): Promise<Page<O>> {
    let q: SelectQueryBuilder<any, any, any> = query;
    if (page.cursor !== undefined) {
        q = q.where(after(spec, decodeCursor(spec, page.cursor).values));
    }
    // The boundary values come from the database's own text rendering, so microseconds survive.
    q = q.select(
        spec.keys.map((key, i) =>
            key.type === "timestamptz"
                ? sql<string>`to_char(${sql.ref(key.ref)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
                      `${KEY_PREFIX}${i}`,
                  )
                : sql<string>`${sql.ref(key.ref)}::text`.as(`${KEY_PREFIX}${i}`),
        ),
    );
    const rows = (await order(q, spec)
        .limit(page.limit + 1)
        .execute()) as Record<string, unknown>[];
    const more = rows.length > page.limit;
    const kept = more ? rows.slice(0, page.limit) : rows;
    const last = kept.at(-1);
    const next =
        more && last
            ? encodeCursor(
                  spec,
                  spec.keys.map((_, i) => String(last[`${KEY_PREFIX}${i}`])),
              )
            : null;
    const items = kept.map((row) => {
        const copy = { ...row };
        for (let i = 0; i < spec.keys.length; i++) delete copy[`${KEY_PREFIX}${i}`];
        return copy as O;
    });
    return { items, next };
}

// An empty allow-list has nothing to list, but a malformed or foreign cursor is still a 422.
export function emptyPage<T>(spec: PageSpec, page: PageRequest): Page<T> {
    if (page.cursor !== undefined) decodeCursor(spec, page.cursor);
    return { items: [], next: null };
}
