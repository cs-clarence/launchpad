import { classifyDatabaseError } from "@launchpad-kit/database";

// What the gate knows about the database and the data directory, as one explicit outcome so
// no caller has to interpret a thrown error.
export type GateFailure =
    | { kind: "schema-mismatch"; error: unknown }
    | { kind: "database-unavailable"; error: unknown }
    // The data directory is a mount, not a database fact.
    | { kind: "unavailable"; error: unknown }
    // Not recognised (a configuration or programming error); never described to clients.
    | { kind: "failed"; error: unknown };
export type GateOutcome = { kind: "ok" } | GateFailure;

export class SchemaCheckTimeoutError extends Error {
    override name = "SchemaCheckTimeoutError";
    constructor() {
        super("The database check did not finish in time.");
    }
}

// What a caller gets when the gate does not pass: the outcome travels with it so a handler can
// map it without reading the message.
export class GateRejectedError extends Error {
    override name = "GateRejectedError";
    constructor(readonly failure: GateFailure) {
        super(failure.error instanceof Error ? failure.error.message : String(failure.error));
    }
}

export interface SchemaGateOptions {
    // Stage 1: the database. Rejects with SchemaMismatchError or a database error.
    checkSchema(): Promise<void>;
    // Stage 2: the data directory.
    checkDataDirectory(): Promise<void>;
    isDataDirectoryProblem?(error: unknown): boolean;
    // How long a pass stays valid; `null` means a pass is final (check once, repeat only a failure).
    intervalMs: number | null;
    // A failure is repeated no sooner than this.
    retryMs: number;
    // Hard deadline for one check, enforced even if the driver never returns.
    timeoutMs?: number;
    // How long a readiness data-directory pass stays valid when `intervalMs` is `null`.
    directoryIntervalMs?: number;
    onFailure?(failure: GateFailure): void;
}

export interface CheckOptions {
    // Readiness reflects the mount; traffic only needs it on the first check.
    includeDataDirectory?: boolean;
    // Caller's own deadline; the gate answers `database-unavailable` when it passes first.
    deadlineMs?: number;
}

type Stage = { ok: true; at: number } | { ok: false; at: number; failure: GateFailure };
interface Task {
    startedAt: number;
    done: Promise<void>;
}

// One shared, single-flight check with at most one outstanding query. A deadline abandons the
// wait, not the check: it stays in flight until it settles (the pool's connection timeout bounds
// it) and no second one starts meanwhile, so a hung database cannot pile up connections.
export function createSchemaGate(options: SchemaGateOptions & { now?: () => number }) {
    const now = options.now ?? Date.now;
    const directoryIntervalMs = options.directoryIntervalMs ?? 10_000;
    let database: Stage | undefined;
    let directory: Stage | undefined;
    let directoryPassed = false;
    let task: Task | undefined;

    function classifySchema(error: unknown): GateFailure {
        const kind = classifyDatabaseError(error);
        if (kind === "schema") return { kind: "schema-mismatch", error };
        if (kind === "unreachable") return { kind: "database-unavailable", error };
        return { kind: "failed", error };
    }

    function record(stage: "database" | "directory", value: Stage) {
        if (stage === "database") database = value;
        else directory = value;
        if (!value.ok) options.onFailure?.(value.failure);
    }

    async function run(needDatabase: boolean, needDirectory: boolean) {
        if (needDatabase) {
            try {
                await options.checkSchema();
                record("database", { ok: true, at: now() });
            } catch (error) {
                record("database", { ok: false, at: now(), failure: classifySchema(error) });
                return;
            }
        }
        if (needDirectory) {
            try {
                await options.checkDataDirectory();
                directoryPassed = true;
                record("directory", { ok: true, at: now() });
            } catch (error) {
                const known = options.isDataDirectoryProblem?.(error) ?? true;
                const failure: GateFailure = known
                    ? { kind: "unavailable", error }
                    : { kind: "failed", error };
                record("directory", { ok: false, at: now(), failure });
            }
        }
    }

    function fresh(stage: Stage | undefined, ttl: number | null, t: number) {
        if (!stage) return false;
        return stage.ok ? ttl === null || t - stage.at < ttl : t - stage.at < options.retryMs;
    }

    // The outcome from what is cached, or which stages must run.
    function evaluate(
        wantDirectory: boolean,
    ): GateOutcome | { database: boolean; directory: boolean } {
        const t = now();
        if (!fresh(database, options.intervalMs, t)) {
            return { database: true, directory: wantDirectory || !directoryPassed };
        }
        if (database && !database.ok) return database.failure;
        // Traffic needs the data directory only until it has passed once.
        if (!wantDirectory && directoryPassed) return { kind: "ok" };
        if (
            !fresh(directory, wantDirectory ? (options.intervalMs ?? directoryIntervalMs) : null, t)
        ) {
            return { database: false, directory: true };
        }
        if (directory && !directory.ok) return directory.failure;
        return { kind: "ok" };
    }

    function start(needs: { database: boolean; directory: boolean }): Task {
        const started = now();
        const current: Task = { startedAt: started, done: Promise.resolve() };
        current.done = run(needs.database, needs.directory)
            .catch(() => {})
            .finally(() => {
                if (task === current) task = undefined;
            });
        task = current;
        return current;
    }

    async function check(checkOptions: CheckOptions = {}): Promise<GateOutcome> {
        const wantDirectory = checkOptions.includeDataDirectory ?? false;
        const callerStart = now();
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = evaluate(wantDirectory);
            if ("kind" in result) return result;
            const running = task ?? start(result);
            const limits = [
                options.timeoutMs === undefined
                    ? undefined
                    : running.startedAt + options.timeoutMs - now(),
                checkOptions.deadlineMs === undefined
                    ? undefined
                    : callerStart + checkOptions.deadlineMs - now(),
            ].filter((value): value is number => value !== undefined);
            const remaining = limits.length > 0 ? Math.min(...limits) : undefined;
            if (remaining !== undefined && remaining <= 0) return timedOut();
            if (remaining === undefined) {
                await running.done;
                continue;
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expired = new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), remaining);
            });
            const winner = await Promise.race([running.done.then(() => "done" as const), expired]);
            clearTimeout(timer);
            if (winner === "timeout") return timedOut();
        }
        return { kind: "failed", error: new Error("The schema check did not settle.") };
    }

    function timedOut(): GateFailure {
        return { kind: "database-unavailable", error: new SchemaCheckTimeoutError() };
    }

    return {
        check,
        // The next check runs the database stage again; the data directory result is kept.
        invalidate() {
            database = undefined;
        },
    };
}

export type SchemaGate = ReturnType<typeof createSchemaGate>;
