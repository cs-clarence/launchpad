import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SshTransport, sshArguments } from "./transport";
import { fakeSsh, workspace, type Workspace } from "./testing";

let ws: Workspace;
beforeAll(async () => {
    ws = await workspace();
});
afterAll(async () => {
    await ws.cleanup();
});

const run = async (body: string, request: Partial<Parameters<SshTransport["run"]>[0]> = {}) => {
    const sshBinary = await fakeSsh(ws.dir, body);
    return new SshTransport(ws.connection, { sshBinary }).run({
        args: ["apps:exists", "lp-abcde12345"],
        timeoutMs: 10_000,
        maxOutputBytes: 64 * 1024,
        ...request,
    });
};

describe("the ssh command line", () => {
    it("pins the host key and disables everything that could weaken or redirect the connection", () => {
        const argv = sshArguments(ws.connection, ["apps:create", "lp-abcde12345"]);
        expect(argv.slice(0, 2)).toEqual(["-F", "/dev/null"]);
        const options = argv.flatMap((arg, i) => (argv[i - 1] === "-o" ? [arg] : []));
        expect(options).toEqual(
            expect.arrayContaining([
                "BatchMode=yes",
                "StrictHostKeyChecking=yes",
                "IdentitiesOnly=yes",
                `UserKnownHostsFile=${ws.connection.knownHostsPath}`,
                "GlobalKnownHostsFile=/dev/null",
                "UpdateHostKeys=no",
                "CheckHostIP=no",
                "VerifyHostKeyDNS=no",
                "PasswordAuthentication=no",
                "KbdInteractiveAuthentication=no",
                "ForwardAgent=no",
                "ClearAllForwardings=yes",
                "RequestTTY=no",
            ]),
        );
        // Nothing weakens the checks: no option sets them to anything else.
        expect(options.some((o) => /StrictHostKeyChecking=(no|accept-new|off)/i.test(o))).toBe(
            false,
        );
        expect(argv).toContain("-i");
        expect(argv[argv.indexOf("-i") + 1]).toBe(ws.connection.privateKeyPath);
        expect(argv[argv.indexOf("-p") + 1]).toBe("3022");
    });

    it("ends ssh's option parsing before the destination, so the command cannot become an option", () => {
        const argv = sshArguments(ws.connection, ["apps:destroy", "lp-abcde12345", "--force"]);
        const dashes = argv.indexOf("--");
        expect(argv.slice(dashes)).toEqual([
            "--",
            "dokku@dokku.example.com",
            "apps:destroy",
            "lp-abcde12345",
            "--force",
        ]);
        // Exactly one `--`, and every ssh option comes before it.
        expect(argv.filter((a) => a === "--")).toHaveLength(1);
        expect(argv.slice(dashes + 2).every((a) => !a.startsWith("-o"))).toBe(true);
    });
});

describe("running ssh", () => {
    it("passes exactly those arguments, with a stripped environment and no shell", async () => {
        const argvFile = path.join(ws.dir, "argv");
        const envFile = path.join(ws.dir, "env");
        process.env.SSH_AUTH_SOCK = "/tmp/an-agent.sock";
        process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
        process.env.SSH_ASKPASS = "/bin/askpass";
        try {
            const result = await run(
                `printf '%s\\n' "$@" > '${argvFile}'; env | sort > '${envFile}'; echo ok`,
            );
            expect(result).toMatchObject({
                exitCode: 0,
                stdout: "ok\n",
                timedOut: false,
                aborted: false,
            });
        } finally {
            delete process.env.SSH_AUTH_SOCK;
            delete process.env.HTTPS_PROXY;
            delete process.env.SSH_ASKPASS;
        }
        const argv = (await fs.readFile(argvFile, "utf8")).trimEnd().split("\n");
        expect(argv).toEqual(sshArguments(ws.connection, ["apps:exists", "lp-abcde12345"]));
        const env = await fs.readFile(envFile, "utf8");
        for (const leaked of ["SSH_AUTH_SOCK", "HTTPS_PROXY", "SSH_ASKPASS"]) {
            expect(env).not.toContain(leaked);
        }
        expect(env).toContain("LANG=C");
    });

    it("reports the exit status and both output streams", async () => {
        const result = await run("echo out; echo err >&2; exit 3");
        expect(result).toMatchObject({
            exitCode: 3,
            stdout: "out\n",
            stderr: "err\n",
            truncated: false,
        });
    });

    it("kills a command that outlives its timeout, and reports that it did", async () => {
        const started = Date.now();
        const result = await run("exec sleep 30", { timeoutMs: 300 });
        expect(result.timedOut).toBe(true);
        expect(result.aborted).toBe(false);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(result.signal).toBe("SIGTERM");
    });

    it("kills a command when the caller cancels, including before it starts", async () => {
        const controller = new AbortController();
        const pending = run("exec sleep 30", { signal: controller.signal });
        setTimeout(() => controller.abort(), 200);
        const result = await pending;
        expect(result).toMatchObject({ aborted: true, timedOut: false });
        const early = new AbortController();
        early.abort();
        const started = Date.now();
        expect(await run("exec sleep 30", { signal: early.signal })).toMatchObject({
            aborted: true,
        });
        expect(Date.now() - started).toBeLessThan(5000);
    });

    it("bounds what it keeps of a flood of output, without stopping the command", async () => {
        const result = await run(
            "head -c 4194304 /dev/zero | tr '\\0' 'a'; head -c 4194304 /dev/zero | tr '\\0' 'b' >&2; exit 0",
            { maxOutputBytes: 1000 },
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toHaveLength(1000);
        expect(result.stderr).toHaveLength(1000);
        expect(result.truncated).toBe(true);
    });

    it("streams a large input through, with its integrity intact", async () => {
        const out = path.join(ws.dir, "stdin-copy");
        const hash = createHash("sha256");
        async function* chunks() {
            for (let i = 0; i < 80; i++) {
                const chunk = Buffer.alloc(64 * 1024, i);
                hash.update(chunk);
                yield chunk;
            }
        }
        const result = await run(`cat > '${out}'`, { stdin: chunks(), timeoutMs: 30_000 });
        expect(result.exitCode).toBe(0);
        const copy = await fs.readFile(out);
        expect(copy.length).toBe(80 * 64 * 1024);
        expect(createHash("sha256").update(copy).digest("hex")).toBe(hash.digest("hex"));
    });

    it("copes with a command that exits without reading its input, and releases the source", async () => {
        let released = false;
        async function* endless() {
            try {
                for (;;) yield Buffer.alloc(256 * 1024, 1);
            } finally {
                released = true;
            }
        }
        const started = Date.now();
        const result = await run("exit 7", { stdin: endless() });
        expect(result.exitCode).toBe(7);
        expect(Date.now() - started).toBeLessThan(8000);
        await expect.poll(() => released, { timeout: 5000 }).toBe(true);
    });

    it("survives an input source that fails", async () => {
        async function* broken() {
            yield Buffer.from("partial");
            throw new Error("disk read failed");
        }
        const result = await run("cat > /dev/null; exit 0", { stdin: broken() });
        expect(result.exitCode).toBe(0);
    });

    it("reports a missing ssh binary as a failure to connect, not a crash", async () => {
        const transport = new SshTransport(ws.connection, { sshBinary: "/nonexistent/ssh" });
        const result = await transport.run({
            args: ["apps:exists", "lp-abcde12345"],
            timeoutMs: 5000,
            maxOutputBytes: 1000,
        });
        expect(result).toMatchObject({ exitCode: 255, stderr: "ssh could not be started" });
    });
});
