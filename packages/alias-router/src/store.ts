import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import {
    admittedHostname,
    authenticationSchema,
    authoritySchema,
    deploymentSchema,
    hostnameSchema,
    pageSchema,
    parse,
    RouterError,
    routeWriteSchema,
    storeOptionsSchema,
    type DeploymentTarget,
    type RouteObservation,
    type RoutePage,
    type RouteRecord,
    type RouteWrite,
    type StoreOptions,
} from "./protocol";
import { APPLICATION_ID, SCHEMA, SCHEMA_VERSION } from "./schema";
import { StateFiles } from "./state-files";

declare const authenticated: unique symbol;
/** Opaque, in-process capability. Not serializable, transferable or valid after rotation/close. */
export type AuthenticatedWriter = { readonly [authenticated]: true };
interface WriterIdentity {
    instanceId: string;
    epoch: string;
    digest: Buffer;
}
interface AuthorityRow {
    instance_id: string;
    active_epoch: string;
    credential_hash: string;
}
interface OperationRow {
    operation_id: string;
    alias_id: string;
    hostname: string;
    generation: string;
    target_deployment_id: string | null;
}
interface RouteRow extends OperationRow {
    target_hostname: string | null;
}

const digest = (token: string) => createHash("sha256").update(token).digest();
function configure(db: Database): void {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
    const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode=WAL").get();
    if (journal?.journal_mode !== "wal") throw new RouterError("unavailable");
    db.exec("PRAGMA synchronous=FULL;");
}
function authority(db: Database): AuthorityRow {
    const row = db
        .query<AuthorityRow, []>(`
        SELECT m.instance_id,m.active_epoch,e.credential_hash
        FROM metadata m JOIN epoch e ON e.epoch=m.active_epoch WHERE m.singleton=1
    `)
        .get();
    if (!row) throw new RouterError("unavailable");
    return row;
}
function routeRecord(row: RouteRow): RouteRecord {
    return {
        aliasId: row.alias_id,
        hostname: row.hostname,
        operationId: row.operation_id,
        generation: row.generation,
        target:
            row.target_deployment_id === null
                ? null
                : {
                      deploymentId: row.target_deployment_id,
                      hostname: row.target_hostname!,
                  },
    };
}
const ROUTE_SELECT = `
    SELECT o.operation_id,o.alias_id,o.hostname,o.generation,o.target_deployment_id,
           d.hostname AS target_hostname
    FROM route r JOIN operation o ON o.operation_id=r.operation_id
    LEFT JOIN deployment d ON d.deployment_id=o.target_deployment_id
`;
function sameOperation(row: OperationRow, input: RouteWrite): boolean {
    return (
        row.alias_id === input.aliasId &&
        row.hostname === input.hostname &&
        row.generation === input.generation &&
        row.target_deployment_id === input.targetDeploymentId
    );
}

/** Explicit exclusive bootstrap. A partial file is never adopted/repaired by open. */
export function initializeRouterState(
    file: string,
    optionsInput: unknown,
    authorityInput: unknown,
): void {
    const options = parse(storeOptionsSchema, optionsInput);
    const initial = parse(authoritySchema, authorityInput);
    const files = new StateFiles(file, true);
    let db: Database | undefined;
    try {
        db = new Database(file, { create: false, strict: true });
        configure(db);
        const connection = db;
        connection
            .transaction(() => {
                connection.exec(SCHEMA);
                connection
                    .query("INSERT INTO epoch(epoch,credential_hash) VALUES(?,?)")
                    .run(initial.epoch, digest(initial.token).toString("hex"));
                connection
                    .query("INSERT INTO metadata VALUES(1,?,?)")
                    .run(options.instanceId, initial.epoch);
                files.captureSidecars();
            })
            .immediate();
        files.captureSidecars();
    } catch {
        db?.close();
        db = undefined;
        files.discard();
        throw new RouterError("unavailable");
    } finally {
        db?.close();
    }
}

/** Open only existing, complete state. Importing this module opens nothing. */
export function openRouterState(file: string, options: unknown): RouterStore {
    return new RouterStore(file, options);
}

export class RouterStore {
    #db: Database;
    #files: StateFiles;
    #options: StoreOptions;
    #closed = false;
    #writers = new WeakMap<object, WriterIdentity>();

    // Use openRouterState at composition roots; no externally supplied callbacks enter transactions.
    constructor(file: string, options: unknown) {
        this.#options = parse(storeOptionsSchema, options);
        this.#files = new StateFiles(file, false);
        let db: Database | undefined;
        try {
            db = new Database(file, { create: false, strict: true });
            if (
                db.query<{ user_version: number }, []>("PRAGMA user_version").get()
                    ?.user_version !== SCHEMA_VERSION ||
                db.query<{ application_id: number }, []>("PRAGMA application_id").get()
                    ?.application_id !== APPLICATION_ID ||
                db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
                    ?.integrity_check !== "ok" ||
                db.query("PRAGMA foreign_key_check").all().length !== 0 ||
                authority(db).instance_id !== this.#options.instanceId
            ) {
                throw new RouterError("unavailable");
            }
            configure(db);
            this.#files.captureSidecars();
            this.#db = db;
        } catch {
            db?.close();
            throw new RouterError("unavailable");
        }
    }

    close(): void {
        if (!this.#closed) {
            this.#closed = true;
            this.#writers = new WeakMap();
            this.#db.close();
        }
    }

    #checked<T>(body: () => T): T {
        if (this.#closed) throw new RouterError("unavailable");
        try {
            this.#files.check();
            return body();
        } catch (error) {
            // Lock contention (an operator's sqlite3, a backup) is transient: report it as
            // unavailable for this call but keep the store, whose files are still verified.
            const code = (error as { code?: unknown }).code;
            if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
                throw new RouterError("unavailable");
            }
            if (!(error instanceof RouterError) || error.code === "unavailable") {
                // Latch unavailable. Restoring a pathname/permissions cannot revive a cached route.
                this.close();
                throw new RouterError("unavailable");
            }
            throw error;
        }
    }

    #validWriter(writer: AuthenticatedWriter): void {
        const identity =
            typeof writer === "object" && writer !== null ? this.#writers.get(writer) : undefined;
        const current = authority(this.#db);
        if (
            !identity ||
            identity.instanceId !== current.instance_id ||
            identity.epoch !== current.active_epoch ||
            !timingSafeEqual(identity.digest, Buffer.from(current.credential_hash, "hex"))
        ) {
            throw new RouterError("unauthorized");
        }
    }

    #mutate<T>(writer: AuthenticatedWriter | null, body: () => T, localOperator = false): T {
        return this.#checked(() =>
            this.#db
                .transaction(() => {
                    this.#files.check();
                    if (!localOperator) this.#validWriter(writer as AuthenticatedWriter);
                    const result = body();
                    this.#files.captureSidecars();
                    // No await, caller hook or network I/O between authority check and durable commit.
                    return result;
                })
                .immediate(),
        );
    }

    authenticate(input: unknown): AuthenticatedWriter {
        const parsed = authenticationSchema.safeParse(input);
        if (!parsed.success) throw new RouterError("unauthorized");
        const candidate = {
            instanceId: parsed.data.instanceId,
            epoch: parsed.data.epoch,
            digest: digest(parsed.data.token),
        };
        return this.#checked(() => {
            const current = authority(this.#db);
            if (
                current.instance_id !== candidate.instanceId ||
                current.active_epoch !== candidate.epoch ||
                !timingSafeEqual(candidate.digest, Buffer.from(current.credential_hash, "hex"))
            ) {
                throw new RouterError("unauthorized");
            }
            this.#files.captureSidecars();
            const writer = Object.freeze({}) as AuthenticatedWriter;
            this.#writers.set(writer, candidate);
            return writer;
        });
    }

    /** Local operator only. Never expose over the worker HTTP control interface. */
    rotateAuthority(input: unknown): { instanceId: string; epoch: string } {
        const next = parse(authoritySchema, input);
        return this.#mutate(
            null,
            () => {
                const hash = digest(next.token).toString("hex");
                if (
                    this.#db
                        .query("SELECT 1 FROM epoch WHERE epoch=? OR credential_hash=?")
                        .get(next.epoch, hash)
                )
                    throw new RouterError("conflict");
                this.#db
                    .query("INSERT INTO epoch(epoch,credential_hash) VALUES(?,?)")
                    .run(next.epoch, hash);
                this.#db
                    .query("UPDATE metadata SET active_epoch=? WHERE singleton=1")
                    .run(next.epoch);
                return { instanceId: this.#options.instanceId, epoch: next.epoch };
            },
            true,
        );
    }

    #reserve(kind: "alias" | "deployment", owner: string, hostname: string): void {
        const existing = this.#db
            .query<{ hostname: string }, [string, string]>(
                "SELECT hostname FROM reservation WHERE kind=? AND owner_id=?",
            )
            .get(kind, owner);
        if (existing) {
            if (existing.hostname !== hostname) throw new RouterError("conflict");
            return; // Persisted ownership is independent of current admission configuration.
        }
        if (this.#db.query("SELECT 1 FROM reservation WHERE hostname=?").get(hostname)) {
            throw new RouterError("conflict");
        }
        if (!admittedHostname(hostname, this.#options.appsDomain)) throw new RouterError("invalid");
        this.#db
            .query("INSERT INTO reservation(hostname,kind,owner_id) VALUES(?,?,?)")
            .run(hostname, kind, owner);
    }

    registerDeployment(writer: AuthenticatedWriter, input: unknown): DeploymentTarget {
        const target = parse(deploymentSchema, input);
        return this.#mutate(writer, () => {
            this.#reserve("deployment", target.deploymentId, target.hostname);
            this.#db
                .query(
                    "INSERT INTO deployment(deployment_id,hostname) VALUES(?,?) ON CONFLICT(deployment_id) DO NOTHING",
                )
                .run(target.deploymentId, target.hostname);
            return target;
        });
    }

    replaceRoute(writer: AuthenticatedWriter, input: unknown): RouteObservation {
        const operation = parse(routeWriteSchema, input);
        return this.#mutate(writer, () => {
            if (
                operation.targetDeploymentId !== null &&
                !this.#db
                    .query("SELECT 1 FROM deployment WHERE deployment_id=?")
                    .get(operation.targetDeploymentId)
            ) {
                throw new RouterError("invalid");
            }
            this.#reserve("alias", operation.aliasId, operation.hostname);
            const previous = this.#db
                .query<RouteRow, [string]>(`${ROUTE_SELECT} WHERE r.hostname=?`)
                .get(operation.hostname);
            const seen = this.#db
                .query<OperationRow, [string]>(
                    "SELECT operation_id,alias_id,hostname,generation,target_deployment_id FROM operation WHERE operation_id=?",
                )
                .get(operation.operationId);
            if (seen) {
                if (
                    !sameOperation(seen, operation) ||
                    previous?.operation_id !== operation.operationId
                ) {
                    throw new RouterError("conflict");
                }
            } else {
                if (previous && BigInt(previous.generation) >= BigInt(operation.generation)) {
                    throw new RouterError("conflict");
                }
                this.#db
                    .query(
                        "INSERT INTO operation(operation_id,alias_id,hostname,generation,target_deployment_id) VALUES(?,?,?,?,?)",
                    )
                    .run(
                        operation.operationId,
                        operation.aliasId,
                        operation.hostname,
                        operation.generation,
                        operation.targetDeploymentId,
                    );
                this.#db
                    .query(
                        "INSERT INTO route(hostname,alias_id,operation_id) VALUES(?,?,?) ON CONFLICT(hostname) DO UPDATE SET operation_id=excluded.operation_id",
                    )
                    .run(operation.hostname, operation.aliasId, operation.operationId);
            }
            return this.#observation(operation.hostname);
        });
    }

    #observation(hostname: string): RouteObservation {
        const row = this.#db
            .query<RouteRow, [string]>(`${ROUTE_SELECT} WHERE r.hostname=?`)
            .get(hostname);
        return {
            instanceId: this.#options.instanceId,
            epoch: authority(this.#db).active_epoch,
            route: row ? routeRecord(row) : null,
        };
    }

    readRoute(input: unknown): RouteObservation {
        const hostname = parse(hostnameSchema, input);
        return this.#checked(() =>
            this.#db
                .transaction(() => {
                    const observed = this.#observation(hostname);
                    this.#files.captureSidecars();
                    return observed;
                })
                .deferred(),
        );
    }

    listRoutes(input: unknown = {}): RoutePage {
        const page = parse(pageSchema, input);
        return this.#checked(() =>
            this.#db
                .transaction(() => {
                    const rows = this.#db
                        .query<RouteRow, [string, number]>(
                            `${ROUTE_SELECT} WHERE r.hostname>? ORDER BY r.hostname LIMIT ?`,
                        )
                        .all(page.after ?? "", page.limit + 1);
                    const routes = rows.slice(0, page.limit).map(routeRecord);
                    const result = {
                        instanceId: this.#options.instanceId,
                        epoch: authority(this.#db).active_epoch,
                        routes,
                        nextCursor: rows.length > page.limit ? routes.at(-1)!.hostname : null,
                    };
                    this.#files.captureSidecars();
                    return result;
                })
                .deferred(),
        );
    }
}
