import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateFiles } from "./state-files";
import {
    initializeRouterState,
    MAX_GENERATION,
    openRouterState,
    RouterError,
    type AuthenticatedWriter,
    type RouterErrorCode,
    type RouterStore,
} from "./index";

const directories: string[] = [];
const stores: RouterStore[] = [];
afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0)) {
        chmodSync(directory, 0o700);
        rmSync(directory, { recursive: true, force: true });
    }
});
function temp() {
    const directory = mkdtempSync(path.join(tmpdir(), "launchpad-router-"));
    directories.push(directory);
    return { directory, file: path.join(directory, "routes.sqlite") };
}
function open(file: string, options: { instanceId: string; appsDomain: string }) {
    const store = openRouterState(file, options);
    stores.push(store);
    return store;
}
function fixture() {
    const { file, directory } = temp();
    const options = { instanceId: randomUUID(), appsDomain: "sites.example.net" };
    const initial = { epoch: randomUUID(), token: randomBytes(32).toString("hex") };
    initializeRouterState(file, options, initial);
    const store = open(file, options);
    const writer = store.authenticate({ ...initial, instanceId: options.instanceId });
    const a = { deploymentId: randomUUID(), hostname: "a.sites.example.net" };
    const b = { deploymentId: randomUUID(), hostname: "b.sites.example.net" };
    store.registerDeployment(writer, a);
    store.registerDeployment(writer, b);
    const aliasId = randomUUID();
    const hostname = "view-site.sites.example.net";
    const operation = (generation: string, targetDeploymentId: string | null = a.deploymentId) => ({
        aliasId,
        hostname,
        operationId: randomUUID(),
        generation,
        targetDeploymentId,
    });
    return { store, file, directory, options, initial, writer, a, b, hostname, aliasId, operation };
}
function fails(code: RouterErrorCode, action: () => unknown) {
    try {
        action();
        throw new Error("Expected a RouterError.");
    } catch (error) {
        expect(error).toBeInstanceOf(RouterError);
        expect((error as RouterError).code).toBe(code);
    }
}

describe("durable routes and generations", () => {
    it("keeps independent aliases, promotes/rolls back without mutating targets and reopens exactly", () => {
        const f = fixture();
        expect(f.store.readRoute(f.hostname).route).toBeNull();
        const first = f.operation("1");
        const other = {
            ...f.operation("1"),
            aliasId: randomUUID(),
            hostname: "other.sites.example.net",
        };
        expect(f.store.replaceRoute(f.writer, first).route?.target).toEqual(f.a);
        f.store.replaceRoute(f.writer, other);
        f.store.replaceRoute(f.writer, f.operation("2", f.b.deploymentId));
        expect(f.store.readRoute(f.hostname).route?.target).toEqual(f.b);
        expect(f.store.readRoute(other.hostname).route?.target).toEqual(f.a);
        f.store.replaceRoute(f.writer, f.operation("3"));
        const before = f.store.listRoutes();
        f.store.close();
        const reopened = open(f.file, f.options);
        expect(reopened.listRoutes()).toEqual(before);
        expect(reopened.authenticate({ ...f.initial, instanceId: f.options.instanceId })).toEqual(
            {},
        );
    });

    it("fences delayed binds and withdrawals, including beyond Number.MAX_SAFE_INTEGER", () => {
        const f = fixture();
        const oldBind = f.operation("9007199254740993", f.b.deploymentId);
        const oldWithdraw = f.operation("9007199254740994", null);
        const barrier = f.operation("9007199254740995");
        const observed = f.store.replaceRoute(f.writer, barrier);
        for (const operation of [oldBind, oldWithdraw]) {
            fails("conflict", () => f.store.replaceRoute(f.writer, operation));
            expect(f.store.readRoute(f.hostname)).toEqual(observed);
        }
        expect(observed.route?.generation).toBe("9007199254740995");
    });

    it("replays only the exact latest committed operation; rejects reused IDs and superseded replays", () => {
        const f = fixture();
        const first = f.operation("1");
        const observed = f.store.replaceRoute(f.writer, first);
        expect(f.store.replaceRoute(f.writer, first)).toEqual(observed);
        fails("conflict", () =>
            f.store.replaceRoute(f.writer, { ...first, targetDeploymentId: f.b.deploymentId }),
        );
        fails("conflict", () => f.store.replaceRoute(f.writer, { ...first, generation: "2" }));
        fails("conflict", () => f.store.replaceRoute(f.writer, f.operation("1")));
        const newer = f.store.replaceRoute(f.writer, f.operation("3", f.b.deploymentId));
        fails("conflict", () => f.store.replaceRoute(f.writer, first));
        expect(f.store.readRoute(f.hostname)).toEqual(newer);
        const other = { ...first, aliasId: randomUUID(), hostname: "new.sites.example.net" };
        fails("conflict", () => f.store.replaceRoute(f.writer, other));
        expect(f.store.readRoute(other.hostname).route).toBeNull();
        // The failed intent's tentative reservation rolled back, too.
        f.store.registerDeployment(f.writer, {
            deploymentId: randomUUID(),
            hostname: other.hostname,
        });
    });

    it("persists bound routes, tombstones, ownership, counters and epoch across reopen", () => {
        const f = fixture();
        f.store.replaceRoute(f.writer, f.operation("7"));
        const tombstone = f.operation("8", null);
        const before = f.store.replaceRoute(f.writer, tombstone);
        const unbound = {
            ...f.operation("9", null),
            aliasId: randomUUID(),
            hostname: "unbound.sites.example.net",
        };
        f.store.replaceRoute(f.writer, unbound);
        const snapshot = f.store.listRoutes();
        f.store.close();
        const reopened = open(f.file, f.options);
        const writer = reopened.authenticate({ ...f.initial, instanceId: f.options.instanceId });
        expect(reopened.listRoutes()).toEqual(snapshot);
        expect(reopened.readRoute(f.hostname)).toEqual(before);
        fails("conflict", () => reopened.replaceRoute(writer, f.operation("7")));
        fails("conflict", () =>
            reopened.replaceRoute(writer, {
                ...unbound,
                generation: "8",
                targetDeploymentId: f.a.deploymentId,
            }),
        );
        fails("conflict", () =>
            reopened.registerDeployment(writer, {
                deploymentId: randomUUID(),
                hostname: f.hostname,
            }),
        );
        fails("conflict", () =>
            reopened.replaceRoute(writer, { ...f.operation("10"), aliasId: randomUUID() }),
        );
    });

    it("accepts the maximum bigint once and permanently fences any lower generation", () => {
        const f = fixture();
        const operation = f.operation(MAX_GENERATION);
        expect(f.store.replaceRoute(f.writer, operation).route?.generation).toBe(MAX_GENERATION);
        expect(f.store.replaceRoute(f.writer, operation).route?.generation).toBe(MAX_GENERATION);
        fails("invalid", () => f.store.replaceRoute(f.writer, f.operation("9223372036854775808")));
        fails("conflict", () => f.store.replaceRoute(f.writer, f.operation("9223372036854775806")));
    });

    it("bounds and orders authoritative inventory with stable cursors", () => {
        const f = fixture();
        for (const name of ["c", "a", "b"])
            f.store.replaceRoute(f.writer, {
                ...f.operation("1"),
                aliasId: randomUUID(),
                hostname: `${name}-alias.sites.example.net`,
            });
        const first = f.store.listRoutes({ limit: 2 });
        expect(first.routes.map((route) => route.hostname)).toEqual([
            "a-alias.sites.example.net",
            "b-alias.sites.example.net",
        ]);
        expect(first.nextCursor).toBe("b-alias.sites.example.net");
        const second = f.store.listRoutes({ after: first.nextCursor, limit: 2 });
        expect(second.routes.map((route) => route.hostname)).toEqual(["c-alias.sites.example.net"]);
        expect(second.nextCursor).toBeNull();
        fails("invalid", () => f.store.listRoutes({ limit: 1001 }));
    });
});

describe("authority at the commit boundary", () => {
    it("rejects already-authenticated handles after atomic operator rotation, retaining all routes", () => {
        const f = fixture();
        f.store.replaceRoute(f.writer, f.operation("1"));
        const delayedWriter = f.store.authenticate({
            ...f.initial,
            instanceId: f.options.instanceId,
        });
        // Another open connection represents the local operator, not a remote worker endpoint.
        const operator = open(f.file, f.options);
        const next = { epoch: randomUUID(), token: randomBytes(32).toString("hex") };
        const routes = f.store.listRoutes().routes;
        expect(operator.rotateAuthority(next)).toEqual({
            instanceId: f.options.instanceId,
            epoch: next.epoch,
        });
        fails("unauthorized", () =>
            f.store.replaceRoute(delayedWriter, f.operation(MAX_GENERATION, f.b.deploymentId)),
        );
        fails("unauthorized", () =>
            f.store.registerDeployment(delayedWriter, {
                deploymentId: randomUUID(),
                hostname: "delayed.sites.example.net",
            }),
        );
        expect(f.store.listRoutes()).toMatchObject({ epoch: next.epoch, routes });
        for (const pair of [
            f.initial,
            { epoch: f.initial.epoch, token: next.token },
            { epoch: next.epoch, token: f.initial.token },
        ])
            fails("unauthorized", () =>
                f.store.authenticate({ ...pair, instanceId: f.options.instanceId }),
            );
        const valid = f.store.authenticate({ ...next, instanceId: f.options.instanceId });
        expect(f.store.replaceRoute(valid, f.operation("2")).epoch).toBe(next.epoch);
        fails("conflict", () =>
            operator.rotateAuthority({ ...next, token: randomBytes(32).toString("hex") }),
        );
        fails("conflict", () =>
            operator.rotateAuthority({ epoch: randomUUID(), token: f.initial.token }),
        );
        fails("conflict", () => operator.rotateAuthority(f.initial));
        const before = f.store.listRoutes();
        f.store.close();
        operator.close();
        const reopened = open(f.file, f.options);
        expect(reopened.listRoutes()).toEqual(before);
        fails("unauthorized", () =>
            reopened.authenticate({ ...f.initial, instanceId: f.options.instanceId }),
        );
    });

    it("rejects forged, null, foreign-store and closed/reopened handles", () => {
        const f = fixture();
        const other = open(f.file, f.options);
        for (const fake of [{}, null, undefined, "token", JSON.parse(JSON.stringify(f.writer))]) {
            fails("unauthorized", () =>
                f.store.replaceRoute(fake as AuthenticatedWriter, f.operation("1")),
            );
        }
        fails("unauthorized", () => other.replaceRoute(f.writer, f.operation("1")));
        f.store.close();
        fails("unavailable", () => f.store.replaceRoute(f.writer, f.operation("1")));
        const reopened = open(f.file, f.options);
        fails("unauthorized", () => reopened.replaceRoute(f.writer, f.operation("1")));
        fails("unauthorized", () =>
            reopened.authenticate({ ...f.initial, instanceId: randomUUID() }),
        );
        fails("unauthorized", () =>
            reopened.authenticate({
                ...f.initial,
                instanceId: f.options.instanceId,
                token: "secret",
            }),
        );
    });

    it("returns neither tokens nor hashes from results, handles, snapshots or errors", () => {
        const f = fixture();
        const observed = f.store.replaceRoute(f.writer, f.operation("1"));
        const raw = new Database(f.file);
        const row = raw
            .query<{ credential_hash: string }, []>("SELECT credential_hash FROM epoch")
            .get()!;
        raw.close();
        const output = JSON.stringify({
            writer: f.writer,
            observed,
            page: f.store.listRoutes(),
            store: f.store,
        });
        expect(output).not.toContain(f.initial.token);
        expect(output).not.toContain(row.credential_hash);
        try {
            f.store.authenticate({
                ...f.initial,
                token: "secret",
                instanceId: f.options.instanceId,
            });
        } catch (error) {
            expect(String(error)).not.toContain("secret");
            expect(Object.keys(error as object)).not.toContain("cause");
        }
    });
});

describe("admission and immutable identities", () => {
    it("shares hostname ownership across aliases, deployments and tombstones", () => {
        const f = fixture();
        expect(f.store.registerDeployment(f.writer, f.a)).toEqual(f.a);
        fails("conflict", () =>
            f.store.registerDeployment(f.writer, { ...f.a, hostname: "changed.sites.example.net" }),
        );
        fails("conflict", () =>
            f.store.replaceRoute(f.writer, { ...f.operation("1"), hostname: f.a.hostname }),
        );
        f.store.replaceRoute(f.writer, f.operation("1", null));
        fails("conflict", () =>
            f.store.registerDeployment(f.writer, {
                deploymentId: randomUUID(),
                hostname: f.hostname,
            }),
        );
        fails("conflict", () =>
            f.store.replaceRoute(f.writer, {
                ...f.operation("2"),
                hostname: "different.sites.example.net",
            }),
        );
        fails("invalid", () => f.store.replaceRoute(f.writer, f.operation("2", randomUUID())));
    });

    it.each(["0", "01", "-1", "1.0", "1e3", "abc", "", " 1", "1 ", "9".repeat(78), 1, null])(
        "refuses noncanonical generation %s without mutation",
        (generation) => {
            const f = fixture();
            fails("invalid", () =>
                f.store.replaceRoute(f.writer, { ...f.operation("1"), generation }),
            );
            expect(f.store.readRoute(f.hostname).route).toBeNull();
        },
    );

    it.each([
        "UPPER.sites.example.net",
        "lower.sites.example.net.",
        "nested.name.sites.example.net",
        "sites.example.net",
        "x.elsewhere.example.org",
        "https://x.sites.example.net/",
        "-bad.sites.example.net",
        "unicode-é.sites.example.net",
        `${"x".repeat(64)}.sites.example.net`,
    ])("refuses unadmitted alias/deployment hostname %s", (hostname) => {
        const f = fixture();
        fails("invalid", () =>
            f.store.registerDeployment(f.writer, { deploymentId: randomUUID(), hostname }),
        );
        fails("invalid", () => f.store.replaceRoute(f.writer, { ...f.operation("1"), hostname }));
    });

    it("rejects additional proxy directives and preserves existing hostnames after configuration changes", () => {
        const f = fixture();
        fails("invalid", () =>
            f.store.registerDeployment(f.writer, { ...f.a, address: "127.0.0.1" }),
        );
        fails("invalid", () =>
            f.store.replaceRoute(f.writer, { ...f.operation("1"), upstream: "http://127.0.0.1" }),
        );
        f.store.replaceRoute(f.writer, f.operation("1"));
        f.store.close();
        const next = open(f.file, { ...f.options, appsDomain: "new.example.org" });
        const writer = next.authenticate({ ...f.initial, instanceId: f.options.instanceId });
        expect(next.registerDeployment(writer, f.a)).toEqual(f.a);
        expect(next.replaceRoute(writer, f.operation("2")).route?.hostname).toBe(f.hostname);
        fails("invalid", () =>
            next.registerDeployment(writer, {
                deploymentId: randomUUID(),
                hostname: "new.sites.example.net",
            }),
        );
        next.registerDeployment(writer, {
            deploymentId: randomUUID(),
            hostname: "new.new.example.org",
        });
    });
});

describe("explicit initialization and fail-closed durable files", () => {
    it("never creates missing state or reinitializes existing state", () => {
        const { file } = temp();
        const options = { instanceId: randomUUID(), appsDomain: "sites.example.net" };
        fails("unavailable", () => open(file, options));
        expect(existsSync(file)).toBe(false);
        const initial = { epoch: randomUUID(), token: randomBytes(32).toString("hex") };
        initializeRouterState(file, options, initial);
        const before = readFileSync(file);
        fails("unavailable", () => initializeRouterState(file, options, initial));
        expect(readFileSync(file)).toEqual(before);
        expect(lstatSync(file).mode & 0o777).toBe(0o600);
        fails("unavailable", () => open(file, { ...options, instanceId: randomUUID() }));
    });

    it("rejects incomplete, corrupt and unsupported stores without completing their metadata", () => {
        const f = fixture();
        f.store.close();
        const db = new Database(f.file);
        db.exec("DELETE FROM metadata");
        db.close();
        fails("unavailable", () => open(f.file, f.options));
        const other = temp();
        writeFileSync(other.file, "not sqlite", { mode: 0o600 });
        fails("unavailable", () => open(other.file, f.options));
        const empty = temp();
        writeFileSync(empty.file, "", { mode: 0o600 });
        fails("unavailable", () => open(empty.file, f.options));
        expect(readFileSync(empty.file).length).toBe(0);
        const unsupported = fixture();
        unsupported.store.close();
        const raw = new Database(unsupported.file);
        raw.exec("PRAGMA user_version=99");
        raw.close();
        fails("unavailable", () => open(unsupported.file, unsupported.options));
    });

    it("refuses open directory/file permissions, symlinks and stale initializer sidecars", () => {
        const f = fixture();
        f.store.close();
        chmodSync(f.directory, 0o755);
        fails("unavailable", () => open(f.file, f.options));
        chmodSync(f.directory, 0o700);
        chmodSync(f.file, 0o644);
        fails("unavailable", () => open(f.file, f.options));
        chmodSync(f.file, 0o600);
        const link = path.join(f.directory, "link.sqlite");
        symlinkSync(f.file, link);
        fails("unavailable", () => open(link, f.options));
        const fresh = path.join(f.directory, "fresh.sqlite");
        writeFileSync(`${fresh}-wal`, "", { mode: 0o600 });
        fails("unavailable", () => initializeRouterState(fresh, f.options, f.initial));
        expect(existsSync(fresh)).toBe(false);
    });

    it.each(["-wal", "-shm"])(
        "refuses existing sidecar permissions and latches missing %s unavailable",
        (suffix) => {
            const f = fixture();
            const sidecar = `${f.file}${suffix}`;
            expect(lstatSync(sidecar).mode & 0o777).toBe(0o600);
            chmodSync(sidecar, 0o644);
            fails("unavailable", () => open(f.file, f.options));
            chmodSync(sidecar, 0o600);
            renameSync(sidecar, `${sidecar}.gone`);
            fails("unavailable", () => f.store.readRoute(f.hostname));
            fails("unavailable", () => f.store.replaceRoute(f.writer, f.operation("1")));
        },
    );

    it("refuses replaced and unlinked main files instead of returning cached mappings", () => {
        const f = fixture();
        f.store.replaceRoute(f.writer, f.operation("1"));
        renameSync(f.file, `${f.file}.old`);
        copyFileSync(`${f.file}.old`, f.file);
        chmodSync(f.file, 0o600);
        fails("unavailable", () => f.store.readRoute(f.hostname));
        rmSync(f.file);
        fails("unavailable", () => f.store.readRoute(f.hostname));
        fails("unavailable", () => open(f.file, f.options));
        expect(existsSync(f.file)).toBe(false);
    });

    it("latches directory/database permission changes and does not revive after repair", () => {
        const f = fixture();
        f.store.replaceRoute(f.writer, f.operation("1"));
        chmodSync(f.directory, 0o500);
        fails("unavailable", () => f.store.readRoute(f.hostname));
        chmodSync(f.directory, 0o700);
        fails("unavailable", () => f.store.readRoute(f.hostname));
        const reopened = open(f.file, f.options);
        chmodSync(f.file, 0o400);
        fails("unavailable", () => reopened.listRoutes());
        chmodSync(f.file, 0o600);
    });
});

describe("transient contention, tampered credentials and initialization recovery", () => {
    it("treats lock contention as retryable without shutting the store down or leaving partial writes", () => {
        const f = fixture();
        const holder = new Database(f.file);
        holder.exec("BEGIN IMMEDIATE");
        const intended = { ...f.operation("1"), hostname: "contended.sites.example.net" };
        fails("unavailable", () => f.store.replaceRoute(f.writer, intended));
        holder.exec("ROLLBACK");
        holder.close();
        // The same store and the same handle work again, and the failed write left no reservation.
        expect(f.store.readRoute(intended.hostname).route).toBeNull();
        f.store.registerDeployment(f.writer, {
            deploymentId: randomUUID(),
            hostname: intended.hostname,
        });
    });

    it("leaves no reservation behind when authority is lost before the commit", () => {
        const f = fixture();
        const operator = open(f.file, f.options);
        operator.rotateAuthority({ epoch: randomUUID(), token: randomBytes(32).toString("hex") });
        const hostname = "never-reserved.sites.example.net";
        fails("unauthorized", () =>
            f.store.replaceRoute(f.writer, { ...f.operation("1"), hostname }),
        );
        const next = { epoch: randomUUID(), token: randomBytes(32).toString("hex") };
        operator.rotateAuthority(next);
        const writer = operator.authenticate({ ...next, instanceId: f.options.instanceId });
        operator.registerDeployment(writer, { deploymentId: randomUUID(), hostname });
    });

    it("refuses a stored credential hash that is not lowercase hex", () => {
        const f = fixture();
        const raw = new Database(f.file);
        expect(() =>
            raw
                .query("INSERT INTO epoch(epoch,credential_hash) VALUES(?,?)")
                .run(randomUUID(), "g".repeat(64)),
        ).toThrow();
        raw.close();
    });

    it("refuses a stale rollback journal when opening or initializing", () => {
        const f = fixture();
        f.store.close();
        writeFileSync(`${f.file}-journal`, "", { mode: 0o600 });
        fails("unavailable", () => open(f.file, f.options));
        const fresh = path.join(f.directory, "fresh.sqlite");
        writeFileSync(`${fresh}-journal`, "", { mode: 0o600 });
        fails("unavailable", () => initializeRouterState(fresh, f.options, f.initial));
        expect(existsSync(fresh)).toBe(false);
    });

    it("discards only what a failed initialization created, so it can be retried", () => {
        const { file } = temp();
        const files = new StateFiles(file, true);
        expect(existsSync(file)).toBe(true);
        files.discard();
        expect(existsSync(file)).toBe(false);
        const options = { instanceId: randomUUID(), appsDomain: "sites.example.net" };
        initializeRouterState(file, options, {
            epoch: randomUUID(),
            token: randomBytes(32).toString("hex"),
        });
        expect(existsSync(file)).toBe(true);
    });
});
