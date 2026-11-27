import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { SHIPPED_DEV_ROOTS, collect, isStale, render } from "./third-party-notices";

const script = path.join(import.meta.dirname, "third-party-notices.ts");
const run = (...args: string[]) =>
    Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });

describe("third-party notices", () => {
    it("renders a sorted table with a licence summary", () => {
        const text = render([
            { name: "a", version: "1.0.0", license: "MIT" },
            { name: "b", version: "2.0.0", license: "ISC" },
        ]);
        expect(text).toContain("| a | 1.0.0 | MIT |");
        expect(text).toContain("| MIT | 1 |");
        expect(text).toContain("Bun");
    });

    it("lists the controller's shipped devDependencies and only those", () => {
        const manifest = JSON.parse(
            readFileSync(path.join(import.meta.dirname, "../apps/controller/package.json"), "utf8"),
        );
        const names = collect().map((entry) => entry.name);
        for (const name of SHIPPED_DEV_ROOTS.controller!) {
            expect(manifest.devDependencies[name]).toBeDefined();
            expect(names).toContain(name);
        }
        for (const tool of ["vite", "typescript", "vitest", "@vitejs/plugin-react"])
            expect(names).not.toContain(tool);
    });

    it("detects drift and a missing file, and accepts a current one", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "notices-"));
        try {
            const file = path.join(dir, "N.md");
            expect(isStale(file, "x")).toBe(true);
            writeFileSync(file, "x");
            expect(isStale(file, "x")).toBe(false);
            expect(isStale(file, "y")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });

    it("--check fails for a stale file and passes once regenerated", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "notices-"));
        try {
            const file = path.join(dir, "N.md");
            writeFileSync(file, "stale");
            expect(run("--check", "--output", file).exitCode).toBe(1);
            expect(run("--output", file).exitCode).toBe(0);
            expect(run("--check", "--output", file).exitCode).toBe(0);
        } finally {
            rmSync(dir, { recursive: true });
        }
    });
});
