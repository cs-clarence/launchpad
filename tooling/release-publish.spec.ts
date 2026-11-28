import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishNpm } from "./release-publish";

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
