import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { classify, createDokkuClient, failedBeforeConnecting } from "./client";
import * as publicApi from "./index";
import { DokkuError, needsReconciliation, sanitizeDetail } from "./errors";
import { fakeSsh, workspace, type Workspace } from "./testing";
import type { Transport, TransportRequest, TransportResult } from "./transport";

const APP = "lp-abcde12345";
let ws: Workspace | undefined;
afterEach(async () => {
    await ws?.cleanup();
    ws = undefined;
});

const result = (over: Partial<TransportResult> = {}): TransportResult => ({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    aborted: false,
    stdinBytes: 0,
    ...over,
});

// A transport that records what it was asked and answers from a queue.
function fake(...answers: Partial<TransportResult>[]) {
    const calls: TransportRequest[] = [];
    const transport: Transport = {
        async run(request) {
            calls.push(request);
            return result(answers.length > 1 ? answers.shift() : answers[0]);
        },
    };
    return { calls, transport };
}

async function setup(...answers: Partial<TransportResult>[]) {
    ws = await workspace();
    const stub = fake(...answers);
    return { ...stub, ws, client: createDokkuClient(ws.connection, { transport: stub.transport }) };
}

const caught = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(DokkuError);
        return error as DokkuError;
    }
    return expect.unreachable("did not fail") as never;
};

describe("the vocabulary", () => {
    it("exposes only the allowlisted operations, and no way to run anything else", async () => {
        const { client } = await setup();
        expect(
            Object.fromEntries(
                Object.entries(client).map(([k, v]) => [k, Object.keys(v).toSorted()]),
            ),
        ).toEqual({
            apps: ["create", "destroy", "exists"],
            domains: ["set"],
            git: ["loadImage"],
            ports: ["set"],
            ps: ["report"],
        });
        // The package exports no generic runner either, and not the real transport: with
        // it a caller could send commands the client would never build.
        expect("SshTransport" in publicApi).toBe(false);
        expect(Object.keys(publicApi).toSorted()).toEqual(
            [
                "DEFAULT_APP_NAME",
                "DokkuError",
                "classify",
                "createDokkuClient",
                "needsReconciliation",
            ].toSorted(),
        );
    });

    it("sends exactly the command each operation means, with its class of timeout", async () => {
        const { client, calls } = await setup({ stdout: "true\n" });
        async function* image() {
            yield Buffer.from("tar");
        }
        await client.apps.create(APP);
        await client.apps.destroy(APP);
        await client.domains.set(APP, "demo-a1b2c3.previews.example.com");
        await client.ports.set(APP, "http:80:80");
        await client.git.loadImage(APP, "launchpad/site:abc123", image());
        expect(await client.apps.exists(APP)).toBe(true);
        expect(await client.ps.report(APP)).toEqual({ running: true, deployed: true });
        expect(calls.map((c) => c.args)).toEqual([
            ["apps:create", APP],
            ["apps:destroy", APP, "--force"],
            ["domains:set", APP, "demo-a1b2c3.previews.example.com"],
            ["ports:set", APP, "http:80:80"],
            ["git:load-image", APP, "launchpad/site:abc123"],
            ["apps:exists", APP],
            ["ps:report", APP, "--running"],
            ["ps:report", APP, "--deployed"],
        ]);
        expect(calls[4]!.stdin).toBeDefined();
        expect(calls.filter((c) => c.stdin)).toHaveLength(1);
        // Reads are quick, changes slower, an image load the longest.
        expect(calls[5]!.timeoutMs).toBeLessThan(calls[0]!.timeoutMs);
        expect(calls[0]!.timeoutMs).toBeLessThan(calls[4]!.timeoutMs);
        expect(calls.every((c) => c.maxOutputBytes === 64 * 1024)).toBe(true);
    });

    it("sends nothing when it is already cancelled, and says it did not start", async () => {
        const { client, calls } = await setup();
        const controller = new AbortController();
        controller.abort();
        const error = await caught(client.apps.create(APP, controller.signal));
        expect(error).toMatchObject({ kind: "not-started", mutating: true });
        expect(needsReconciliation(error)).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it("passes cancellation through", async () => {
        const { client, calls } = await setup();
        const controller = new AbortController();
        await client.apps.create(APP, controller.signal);
        expect(calls[0]!.signal).toBe(controller.signal);
    });
});

describe("refused input", () => {
    it("never reaches the transport, whatever the operation", async () => {
        const { client, calls } = await setup();
        const evil = [
            "lp-abcde1234;id",
            "LP-ABCDE12345",
            "lp-abcde12345 --force",
            "$(id)",
            "lp-abcde12345\n",
            "--force",
        ];
        for (const name of evil) {
            for (const run of [
                () => client.apps.create(name),
                () => client.apps.exists(name),
                () => client.apps.destroy(name),
                () => client.domains.set(name, "a.example.com"),
                () => client.ports.set(name, "http:80:80"),
                () => client.ps.report(name),
                () => client.git.loadImage(name, "a:b", (async function* () {})()),
            ]) {
                expect((await caught(run())).kind).toBe("invalid-argument");
            }
        }
        for (const host of [
            "a b.example.com",
            "x.example.com;ls",
            "-x.example.com",
            "UPPER.example.com",
            "localhost",
        ]) {
            expect((await caught(client.domains.set(APP, host))).kind).toBe("invalid-argument");
        }
        for (const mapping of ["tcp:80:80", "http:80:80;x", "http:0:1"]) {
            expect((await caught(client.ports.set(APP, mapping))).kind).toBe("invalid-argument");
        }
        for (const tag of ["a b:c", "a:b;c", "A:b", "a"]) {
            expect(
                (await caught(client.git.loadImage(APP, tag, (async function* () {})()))).kind,
            ).toBe("invalid-argument");
        }
        expect(calls).toHaveLength(0);
    });

    it("keeps the controller's own names the default, and widens them only on request", async () => {
        ws = await workspace();
        const stub = fake();
        const strict = createDokkuClient(ws.connection, { transport: stub.transport });
        expect((await caught(strict.apps.create("lp-test-abc123"))).kind).toBe("invalid-argument");
        const wide = createDokkuClient(ws.connection, {
            transport: stub.transport,
            appNamePattern: /^lp-test-[a-z0-9]{6}$/,
        });
        await wide.apps.create("lp-test-abc123");
        expect(stub.calls).toHaveLength(1);
    });
});

describe("app name patterns", () => {
    it("give the same answer every time, even with a global or sticky flag", async () => {
        ws = await workspace();
        const stub = fake();
        for (const flags of ["g", "y", "gy"]) {
            const client = createDokkuClient(ws.connection, {
                transport: stub.transport,
                appNamePattern: new RegExp("^lp-test-[a-z0-9]{6}$", flags),
            });
            for (let i = 0; i < 4; i++) await client.apps.create("lp-test-abc123");
            expect((await caught(client.apps.create("lp-test-ABC123"))).kind).toBe(
                "invalid-argument",
            );
        }
        expect(stub.calls).toHaveLength(12);
    });
});

describe("trust comes first", () => {
    it("sends nothing when the host key is not pinned, and says why", async () => {
        const { client, calls, ws: w } = await setup();
        await fs.writeFile(w.connection.knownHostsPath, "");
        const error = await caught(client.apps.create(APP));
        expect(error).toMatchObject({ kind: "trust", operation: "connect" });
        expect(calls).toHaveLength(0);
    });

    it("sends nothing when the private key is readable by others", async () => {
        const { client, calls, ws: w } = await setup();
        await fs.chmod(w.connection.privateKeyPath, 0o644);
        expect((await caught(client.apps.create(APP))).kind).toBe("trust");
        expect(calls).toHaveLength(0);
    });

    it("checks again on every call, so a key replaced while running is noticed", async () => {
        const { client, calls, ws: w } = await setup();
        await client.apps.create(APP);
        await fs.writeFile(w.connection.knownHostsPath, "# replaced, nothing pinned\n");
        expect((await caught(client.apps.create(APP))).kind).toBe("trust");
        expect(calls).toHaveLength(1);
    });

    it("refuses nonsense connection settings at construction", async () => {
        ws = await workspace();
        expect(() => createDokkuClient({ ...ws!.connection, host: "-oProxyCommand=x" })).toThrow(
            DokkuError,
        );
    });
});

describe("what a finished command means", () => {
    const outcome = (mutating: boolean, over: Partial<TransportResult>) =>
        classify("apps:create", mutating, result(over));

    it("is ok only for exit status 0 that was not cut short", () => {
        expect(outcome(true, {})).toBe("ok");
        expect((outcome(true, { timedOut: true }) as DokkuError).kind).toBe("uncertain");
        expect((outcome(true, { aborted: true }) as DokkuError).kind).toBe("uncertain");
        // Even an exit 0 is not trusted when we had already decided to stop it.
        expect((outcome(true, { exitCode: 0, timedOut: true }) as DokkuError).kind).toBe(
            "uncertain",
        );
    });

    it("is not-started only on ssh's own words, with nothing else said or sent", () => {
        for (const stderr of [
            "Host key verification failed.",
            "dokku@h: Permission denied (publickey).",
            "ssh: connect to host h port 22: Connection refused",
            "ssh: Could not resolve hostname h: Name or service not known",
            "ssh: connect to host h port 22: Connection timed out",
            "ssh: connect to host h port 22: No route to host",
            "ssh: connect to host h port 22: Network is unreachable",
            "Unable to negotiate with 1.2.3.4 port 22: no matching host key type found. Their offer: ssh-rsa",
            'Load key "/k": invalid format',
            "ssh could not be started",
            // The full warning for a pinned key that no longer matches.
            [
                "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
                "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
                "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
                "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!",
                "Someone could be eavesdropping on you right now (man-in-the-middle attack)!",
                "It is also possible that a host key has just been changed.",
                "The fingerprint for the ED25519 key sent by the remote host is",
                "SHA256:abc123.",
                "Please contact your system administrator.",
                "Add correct host key in /k/known_hosts to get rid of this message.",
                "Offending ED25519 key in /k/known_hosts:1",
                "Host key for [h]:3022 has changed and you have requested strict checking.",
                "Host key verification failed.",
            ].join("\n"),
        ]) {
            expect((outcome(true, { exitCode: 255, stderr }) as DokkuError).kind, stderr).toBe(
                "not-started",
            );
        }
    });

    it("does not take remote words for evidence that nothing ran", () => {
        const lost = { exitCode: 255 };
        // The remote started work, printed this, then the connection dropped.
        for (const stderr of [
            "registry connection refused",
            "Error: could not resolve hostname for the registry",
            "pull failed: Connection timed out",
            "Permission denied while reading /var/lib/dokku",
            "Host key verification failed.\nthen the remote kept going",
            "docker: Host key verification failed. retrying",
            "xssh: connect to host h port 22: Connection refused",
        ]) {
            expect((outcome(true, { ...lost, stderr }) as DokkuError).kind, stderr).toBe(
                "uncertain",
            );
        }
        // Even ssh's exact words are not enough once anything was received or sent.
        const refusal = "ssh: connect to host h port 22: Connection refused";
        expect(
            (outcome(true, { ...lost, stderr: refusal, stdout: "-----> Deploying" }) as DokkuError)
                .kind,
        ).toBe("uncertain");
        expect(
            (outcome(true, { ...lost, stderr: refusal, stdinBytes: 1 }) as DokkuError).kind,
        ).toBe("uncertain");
        expect(
            (outcome(true, { ...lost, stderr: refusal, truncated: true }) as DokkuError).kind,
        ).toBe("uncertain");
        expect(failedBeforeConnecting(result({ exitCode: 255, stderr: refusal }))).toBe(true);
        // A mutation whose outcome is uncertain must be reconciled.
        expect(
            needsReconciliation(outcome(true, { ...lost, stderr: "registry connection refused" })),
        ).toBe(true);
    });

    it("is uncertain when the connection was lost, because the command may have run", () => {
        for (const stderr of [
            "Connection to h closed by remote host.",
            "client_loop: send disconnect: Broken pipe",
            "packet_write_wait: Connection to 1.2.3.4 port 22: Broken pipe",
            "Read from remote host h: Connection reset by peer",
            "",
        ]) {
            expect((outcome(true, { exitCode: 255, stderr }) as DokkuError).kind, stderr).toBe(
                "uncertain",
            );
        }
        expect((outcome(true, { exitCode: null, signal: "SIGKILL" }) as DokkuError).kind).toBe(
            "uncertain",
        );
    });

    it("is failed when the remote command ran and said no", () => {
        for (const exitCode of [1, 2, 127]) {
            expect((outcome(true, { exitCode }) as DokkuError).kind).toBe("failed");
        }
    });

    it("records whether the operation mutates, and what is worth reconciling", () => {
        const lost = outcome(true, { exitCode: 255 }) as DokkuError;
        const lostRead = outcome(false, { exitCode: 255 }) as DokkuError;
        const failed = outcome(true, { exitCode: 1 }) as DokkuError;
        const refused = outcome(true, {
            exitCode: 255,
            stderr: "ssh: connect to host h port 22: Connection refused",
        }) as DokkuError;
        expect([lost, lostRead, failed, refused].map(needsReconciliation)).toEqual([
            true,
            false,
            false,
            false,
        ]);
        expect(needsReconciliation(new Error("x"))).toBe(false);
    });

    it("keeps remote output out of the message, and bounded and printable in the detail", () => {
        const error = outcome(true, {
            exitCode: 1,
            stderr: `secret \u001b[31mtoken=abc\u0007 ${"x".repeat(2000)}\n`,
        }) as DokkuError;
        expect(error.message).toBe("Dokku apps:create failed.");
        expect(error.message).not.toContain("token");
        expect(error.detail.length).toBeLessThanOrEqual(500);
        expect(error.detail).not.toMatch(/[\u0000-\u0008\u001b]/);
        expect(error.exitCode).toBe(1);
        expect(sanitizeDetail("a\u202Eb")).toBe("a?b");
    });
});

describe("operations that read", () => {
    it("exists is false only when Dokku says the app does not exist", async () => {
        const current = await setup({ exitCode: 20, stderr: ` !     App ${APP} does not exist` });
        expect(await current.client.apps.exists(APP)).toBe(false);
        await current.ws.cleanup();
        const denied = await setup({ exitCode: 20, stderr: "permission problem" });
        expect((await caught(denied.client.apps.exists(APP))).kind).toBe("failed");
        await denied.ws.cleanup();
        const foreign = await setup({
            exitCode: 20,
            stderr: " !     App lp-zzzzzzzzzz does not exist",
        });
        expect((await caught(foreign.client.apps.exists(APP))).kind).toBe("failed");
        await foreign.ws.cleanup();
        const missing = await setup({ exitCode: 1, stderr: ` !     App ${APP} does not exist` });
        expect(await missing.client.apps.exists(APP)).toBe(false);
        await missing.ws.cleanup();
        const config = await setup({
            exitCode: 2,
            stderr: `configuration file does not exist; App ${APP} does not exist`,
        });
        expect((await caught(config.client.apps.exists(APP))).kind).toBe("failed");
        await config.ws.cleanup();
        const other = await setup({
            exitCode: 1,
            stderr: " !     App lp-zzzzzzzzzz does not exist",
        });
        expect((await caught(other.client.apps.exists(APP))).kind).toBe("failed");
        await other.ws.cleanup();
        const broken = await setup({ exitCode: 1, stderr: "permission problem" });
        expect((await caught(broken.client.apps.exists(APP))).kind).toBe("failed");
        await broken.ws.cleanup();
        const lost = await setup({ exitCode: 255, stderr: "Broken pipe" });
        const error = await caught(lost.client.apps.exists(APP));
        expect(error).toMatchObject({ kind: "uncertain", mutating: false });
        expect(needsReconciliation(error)).toBe(false);
    });

    it("ps.report reads both flags and refuses an answer it does not understand", async () => {
        const mixed = await setup({ stdout: "true\n" }, { stdout: " FALSE \n" });
        expect(await mixed.client.ps.report(APP)).toEqual({ running: true, deployed: false });
        await mixed.ws.cleanup();
        const odd = await setup({ stdout: "maybe" });
        expect((await caught(odd.client.ps.report(APP))).kind).toBe("failed");
    });
});

describe("through the real ssh transport", () => {
    it("runs the command named, and classifies a rejected host key as not started", async () => {
        ws = await workspace();
        const argvFile = `${ws.dir}/argv`;
        const ok = await fakeSsh(ws.dir, `printf '%s\\n' "$@" > '${argvFile}'`);
        await createDokkuClient(ws.connection, { sshBinary: ok }).apps.create(APP);
        const argv = (await fs.readFile(argvFile, "utf8")).trimEnd().split("\n");
        expect(argv.slice(-4)).toEqual(["--", "dokku@dokku.example.com", "apps:create", APP]);
        expect(argv).toContain("StrictHostKeyChecking=yes");

        const rejected = await fakeSsh(
            ws.dir,
            `echo 'Host key verification failed.' >&2; exit 255`,
        );
        const error = await caught(
            createDokkuClient(ws.connection, { sshBinary: rejected }).apps.create(APP),
        );
        expect(error).toMatchObject({ kind: "not-started", mutating: true, exitCode: 255 });
        expect(error.detail).toBe("Host key verification failed.");
    });

    it("turns a command that hangs into an uncertain, mutating outcome", async () => {
        ws = await workspace();
        const hangs = await fakeSsh(ws.dir, "exec sleep 30");
        const client = createDokkuClient(ws.connection, {
            sshBinary: hangs,
            timeoutsMs: { mutate: 300 },
        });
        const error = await caught(client.apps.create(APP));
        expect(error).toMatchObject({ kind: "uncertain", mutating: true });
        expect(needsReconciliation(error)).toBe(true);
    });
});
