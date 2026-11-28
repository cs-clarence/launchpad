import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect, publishNpm, retag } from "./release-publish";

const NAMES = ["contracts", "sdk", "client-core", "cli", "mcp"].map((n) => `@launchpad-kit/${n}`);

// Real tarballs with a fake package.json each; publishNpm refuses before it calls npm when the
// set, a version or the checksums are wrong, so none of these runs npm.
function fakeDir(packages: { name: string; version?: string }[], listed?: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "publish-"));
    const files: string[] = [];
    packages.forEach(({ name, version }, i) => {
        const source = path.join(dir, `src-${i}`, "package");
        mkdirSync(source, { recursive: true });
        writeFileSync(
            path.join(source, "package.json"),
            JSON.stringify({ name, version: version ?? "1.0.0" }),
        );
        const file = `pkg-${i}.tgz`;
        spawnSync("tar", [
            "czf",
            path.join(dir, file),
            "-C",
            path.join(dir, `src-${i}`),
            "package",
        ]);
        files.push(file);
    });
    const sums = (listed ?? files)
        .map((f) => `${createHash("sha256").update(f).digest("hex")}  ${f}`)
        .join("\n");
    writeFileSync(path.join(dir, "SHA256SUMS"), `${sums}\n`);
    return dir;
}

describe("publishNpm refuses before it publishes", () => {
    const five = NAMES.map((name) => ({ name }));

    it("a tarball set that differs from SHA256SUMS", () => {
        const dir = fakeDir(five, ["pkg-0.tgz"]);
        expect(() => publishNpm(dir, "1.0.0")).toThrow(/differ from SHA256SUMS/);
    });

    it("a tarball whose version is not the tag's", () => {
        const dir = fakeDir(five.map((p, i) => (i === 3 ? { ...p, version: "0.9.0" } : p)));
        expect(() => publishNpm(dir, "1.0.0")).toThrow(/not the tag's 1.0.0/);
    });

    it("an extra, a missing or a duplicated package", () => {
        expect(() =>
            publishNpm(fakeDir([...five, { name: "@launchpad-kit/extra" }]), "1.0.0"),
        ).toThrow(/unexpected package @launchpad-kit\/extra/);
        expect(() => publishNpm(fakeDir(five.slice(1)), "1.0.0")).toThrow(
            /no tarball for @launchpad-kit\/contracts/,
        );
        expect(() => publishNpm(fakeDir([...five, five[0]!]), "1.0.0")).toThrow(
            /2 tarballs for @launchpad-kit\/contracts/,
        );
    });

    it("leaves the directory as it found it", () => {
        const dir = fakeDir(five.slice(1));
        const before = readdirSync(dir).toSorted();
        expect(() => publishNpm(dir, "1.0.0")).toThrow();
        expect(readdirSync(dir).toSorted()).toEqual(before);
        expect(readFileSync(path.join(dir, "SHA256SUMS"), "utf8")).toContain("pkg-0.tgz");
    });
});

describe("inspect", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const json = JSON.stringify({
        name: "n",
        manifest: { digest },
        image: { config: { Labels: { "org.opencontainers.image.version": "1.0.0" } } },
    });
    const ok = (out: string) => ({ code: 0, out, err: "" });
    const fail = (err: string) => ({ code: 1, out: "", err });
    const fake = (raw: ReturnType<typeof ok>, full?: ReturnType<typeof ok>) => {
        const calls: string[][] = [];
        const exec = (_command: string, args: string[]) => {
            calls.push(args);
            return args.includes("--raw") ? raw : (full ?? ok(""));
        };
        return { exec, calls };
    };

    it("reads a tag whose manifest and children are present", () => {
        const { exec, calls } = fake(ok("{}"), ok(json));
        expect(inspect("ghcr.io/x/y:1.0.0", exec)).toEqual({ digest, version: "1.0.0" });
        expect(calls).toHaveLength(2);
    });

    it("reads a tag that does not exist as absent, and never runs the full inspection", () => {
        const { exec, calls } = fake(fail("ERROR: ghcr.io/x/y:sha-1: not found"));
        expect(inspect("ghcr.io/x/y:sha-1", exec)).toBeNull();
        expect(calls).toHaveLength(1);
    });

    it("fails when the tag exists but a child descriptor is not found", () => {
        const { exec } = fake(ok("{}"), fail("ERROR: ghcr.io/x/y@sha256:bbbb: not found"));
        expect(() => inspect("ghcr.io/x/y:1.0.0", exec)).toThrow(/exists but cannot be read/);
    });

    it("fails on a registry error instead of reading it as absent", () => {
        const { exec } = fake(fail("dial tcp: lookup ghcr.io: no such host"));
        expect(() => inspect("ghcr.io/x/y:1.0.0", exec)).toThrow(/could not inspect/);
    });
});

describe("retag", () => {
    const staged = `sha256:${"a".repeat(64)}`;
    const other = `sha256:${"b".repeat(64)}`;
    const SHA = "c0ffee";
    type State = Record<string, { digest: string; version: string | null }>;

    // A registry of one image: tag -> digest and version label. `create` adds a tag that
    // resolves to the source digest, labelled with the staged image's version.
    function registry(version: string, state: State) {
        const created: string[] = [];
        const sources: string[] = [];
        let failCreate = false;
        const tags: State = { [`sha-${SHA}`]: { digest: staged, version }, ...state };
        const exec = (_command: string, args: string[]) => {
            if (args[2] === "create") {
                sources.push(args[5]!);
                if (failCreate) return { code: 1, out: "", err: "ERROR: denied" };
                const tag = args[4]!.split(":").at(-1)!;
                created.push(tag);
                tags[tag] = { digest: staged, version };
                return { code: 0, out: "", err: "" };
            }
            const ref = args[3]!;
            const found = tags[ref.split(":").at(-1)!];
            if (!found) return { code: 1, out: "", err: `ERROR: ${ref}: not found` };
            if (args.includes("--raw")) return { code: 0, out: "{}", err: "" };
            const labels = found.version
                ? { "org.opencontainers.image.version": found.version }
                : {};
            return {
                code: 0,
                out: JSON.stringify({
                    manifest: { digest: found.digest },
                    image: { config: { Labels: labels } },
                }),
                err: "",
            };
        };
        return {
            exec,
            created,
            sources,
            failCreates: () => {
                failCreate = true;
            },
        };
    }
    const quiet = <T>(fn: () => T): T => {
        const log = console.log;
        console.log = () => {};
        try {
            return fn();
        } finally {
            console.log = log;
        }
    };

    it("creates the version, X.Y and latest for a stable release", () => {
        const { exec, created } = registry("1.2.3", {});
        quiet(() => retag("worker", "1.2.3", staged, SHA, exec));
        expect(created).toEqual(["1.2.3", "1.2", "latest"]);
    });

    it("sources every tag from the staged digest, never from the sha tag", () => {
        const { exec, created, sources } = registry("1.2.3", {});
        quiet(() => retag("worker", "1.2.3", staged, SHA, exec));
        expect(created).toHaveLength(3);
        for (const source of sources) {
            expect(source).toBe(`ghcr.io/launchpad-kit/launchpad-worker@${staged}`);
            expect(source).not.toContain(`:sha-${SHA}`);
        }
    });

    it("fails closed when creating a tag fails, and creates nothing after it", () => {
        const { exec, created, sources, failCreates } = registry("1.2.3", {});
        failCreates();
        expect(() => quiet(() => retag("worker", "1.2.3", staged, SHA, exec))).toThrow(
            /creating 1.2.3 failed/,
        );
        expect(sources).toHaveLength(1);
        expect(created).toEqual([]);
    });

    it("creates the version, rc and next for an rc, and never X.Y or latest", () => {
        const { exec, created } = registry("1.2.3-rc.1", {});
        quiet(() => retag("worker", "1.2.3-rc.1", staged, SHA, exec));
        expect(created).toEqual(["1.2.3-rc.1", "rc", "next"]);
    });

    it("moves floating tags forward only", () => {
        const { exec, created } = registry("1.2.3", {
            "1.2": { digest: other, version: "1.2.4" },
            latest: { digest: other, version: "1.3.0" },
        });
        quiet(() => retag("worker", "1.2.3", staged, SHA, exec));
        expect(created).toEqual(["1.2.3"]);
        const rc = registry("1.2.3-rc.1", { rc: { digest: other, version: "1.2.3-rc.2" } });
        quiet(() => retag("worker", "1.2.3-rc.1", staged, SHA, rc.exec));
        expect(rc.created).toEqual(["1.2.3-rc.1", "next"]);
    });

    it("on a re-run skips the version tag that is already on the digest and still moves the rest", () => {
        const { exec, created } = registry("1.2.3", {
            "1.2.3": { digest: staged, version: "1.2.3" },
        });
        quiet(() => retag("worker", "1.2.3", staged, SHA, exec));
        expect(created).toEqual(["1.2", "latest"]);
    });

    it("refuses a version tag on another digest and a staged tag that is not the digest", () => {
        const clash = registry("1.2.3", { "1.2.3": { digest: other, version: "1.2.3" } });
        expect(() => quiet(() => retag("worker", "1.2.3", staged, SHA, clash.exec))).toThrow(
            /already points/,
        );
        const moved = registry("1.2.3", { [`sha-${SHA}`]: { digest: other, version: "1.2.3" } });
        expect(() => quiet(() => retag("worker", "1.2.3", staged, SHA, moved.exec))).toThrow(
            /not sha256/,
        );
    });

    it("stops on a floating tag whose version label is unreadable", () => {
        const { exec, created } = registry("1.2.3", { latest: { digest: other, version: null } });
        expect(() => quiet(() => retag("worker", "1.2.3", staged, SHA, exec))).toThrow(
            /no readable/,
        );
        expect(created).toEqual(["1.2.3"]);
    });
});
