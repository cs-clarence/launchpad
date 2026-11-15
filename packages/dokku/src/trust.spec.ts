import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DokkuError } from "./errors";
import { keyBlob, knownHostsLine, workspace, type Workspace } from "./testing";
import {
    knownHostsName,
    pinnedKeysFrom,
    verifyConnectionShape,
    verifyHostKeys,
    verifyPrivateKey,
} from "./trust";

let ws: Workspace | undefined;
afterEach(async () => {
    await ws?.cleanup();
    ws = undefined;
});

const trustError = (promise: Promise<unknown> | (() => unknown)) =>
    (typeof promise === "function" ? Promise.resolve().then(promise) : promise).then(
        () => undefined,
        (error: unknown) => {
            expect(error).toBeInstanceOf(DokkuError);
            expect((error as DokkuError).kind).toBe("trust");
            return (error as DokkuError).message;
        },
    );

describe("host key pinning", () => {
    it("names the server as ssh does", () => {
        expect(knownHostsName({ host: "d.example.com", port: 22 })).toBe("d.example.com");
        expect(knownHostsName({ host: "d.example.com", port: 3022 })).toBe("[d.example.com]:3022");
    });

    it("accepts an explicit entry for exactly this host and port", async () => {
        ws = await workspace();
        expect(await verifyHostKeys(ws.connection)).toEqual([
            { host: "[dokku.example.com]:3022", type: "ssh-ed25519" },
        ]);
        const c = ws.connection;
        const text = [
            "# a comment",
            "",
            knownHostsLine("other.example.com"),
            knownHostsLine("[dokku.example.com]:3022,[10.0.0.5]:3022", "ecdsa-sha2-nistp256"),
        ].join("\n");
        expect(pinnedKeysFrom(text, c)).toHaveLength(1);
    });

    it("fails closed when nothing is pinned for this server", async () => {
        ws = await workspace();
        const c = ws.connection;
        for (const text of [
            "",
            "# only a comment\n",
            knownHostsLine("other.example.com") + "\n",
            knownHostsLine("dokku.example.com") + "\n", // right host, wrong port
            knownHostsLine("[dokku.example.com]:22") + "\n",
        ]) {
            await fs.writeFile(c.knownHostsPath, text);
            expect(await trustError(verifyHostKeys(c)), JSON.stringify(text)).toMatch(
                /no key pinned/,
            );
        }
    });

    it("refuses wildcards, negation, hashed names, markers and corrupt keys", async () => {
        ws = await workspace();
        const c = ws.connection;
        const name = knownHostsName(c);
        const cases: [string, RegExp][] = [
            [knownHostsLine("*"), /wildcard/],
            [knownHostsLine("*.example.com"), /wildcard/],
            [knownHostsLine("[dokku.exampl?.com]:3022"), /wildcard/],
            [knownHostsLine(`!${name}`), /wildcard/],
            [knownHostsLine("|1|c2FsdA==|aGFzaA=="), /wildcard|hashed/],
            [`@cert-authority ${knownHostsLine(name)}`, /marker/],
            [`@revoked ${knownHostsLine(name)}`, /marker/],
            [`${name} ssh-ed25519`, /malformed/],
            [`${name} ssh-dss ${keyBlob("ssh-dss")}`, /unsupported/],
            [`${name} ssh-ed25519 not*base64`, /corrupt/],
            [`${name} ssh-ed25519 ${keyBlob("ssh-rsa")}`, /corrupt/],
            [`${name} ssh-ed25519 AAAA`, /corrupt/],
        ];
        for (const [line, pattern] of cases) {
            // The bad line is rejected even though a good one for this host follows it.
            await fs.writeFile(c.knownHostsPath, `${line}\n${knownHostsLine(name)}\n`);
            expect(await trustError(verifyHostKeys(c)), line).toMatch(pattern);
        }
    });

    it("refuses a missing file, a directory, a link and an oversized file", async () => {
        ws = await workspace();
        const c = ws.connection;
        expect(
            await trustError(verifyHostKeys({ ...c, knownHostsPath: path.join(ws.dir, "nope") })),
        ).toMatch(/cannot be read/);
        expect(await trustError(verifyHostKeys({ ...c, knownHostsPath: ws.dir }))).toBeDefined();
        const link = path.join(ws.dir, "link");
        await fs.symlink(c.knownHostsPath, link);
        expect(await trustError(verifyHostKeys({ ...c, knownHostsPath: link }))).toMatch(
            /cannot be read/,
        );
        await fs.writeFile(c.knownHostsPath, "#".repeat(300 * 1024));
        expect(await trustError(verifyHostKeys(c))).toMatch(/reasonable/);
    });
});

describe("the private key", () => {
    it("is used only when private to its owner", async () => {
        ws = await workspace();
        const c = ws.connection;
        await expect(verifyPrivateKey(c)).resolves.toBeUndefined();
        for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o777]) {
            await fs.chmod(c.privateKeyPath, mode);
            expect(await trustError(verifyPrivateKey(c)), mode.toString(8)).toMatch(
                /readable by others/,
            );
        }
        await fs.chmod(c.privateKeyPath, 0o400);
        await expect(verifyPrivateKey(c)).resolves.toBeUndefined();
    });

    it("refuses a missing path, a directory and a symbolic link", async () => {
        ws = await workspace();
        const c = ws.connection;
        expect(
            await trustError(verifyPrivateKey({ ...c, privateKeyPath: path.join(ws.dir, "nope") })),
        ).toMatch(/cannot be used/);
        expect(await trustError(verifyPrivateKey({ ...c, privateKeyPath: ws.dir }))).toBeDefined();
        const link = path.join(ws.dir, "keylink");
        await fs.symlink(c.privateKeyPath, link);
        expect(await trustError(verifyPrivateKey({ ...c, privateKeyPath: link }))).toMatch(
            /cannot be used/,
        );
    });
});

describe("the connection settings", () => {
    const ok = {
        host: "dokku.example.com",
        port: 3022,
        username: "dokku",
        privateKeyPath: "/run/secrets/dokku_key",
        knownHostsPath: "/run/secrets/known_hosts",
    };

    it("accepts plain values", () => {
        expect(() => verifyConnectionShape(ok)).not.toThrow();
    });

    it("refuses values that would change what ssh does", async () => {
        for (const bad of [
            { host: "-oProxyCommand=x" },
            { host: "a b" },
            { host: "a;b" },
            { host: "" },
            { username: "Root" },
            { username: "a b" },
            { username: "-x" },
            { port: 0 },
            { port: 65536 },
            { port: 22.5 },
            { privateKeyPath: "relative/key" },
            { privateKeyPath: "/path with space/key" },
            { privateKeyPath: "/tmp/%h/key" },
            { privateKeyPath: "~/key" },
            { knownHostsPath: "/tmp/a,b" },
            { knownHostsPath: "/tmp/a\nb" },
            { knownHostsPath: "" },
        ]) {
            expect(
                await trustError(() => verifyConnectionShape({ ...ok, ...bad })),
                JSON.stringify(bad),
            ).toBeDefined();
        }
    });
});
