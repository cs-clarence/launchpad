import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(import.meta.dirname, "../omni/presets");
type Task = Record<string, any>;
const load = (name: string) =>
    Bun.YAML.parse(readFileSync(path.join(dir, name), "utf8")) as {
        extends?: string[];
        cache?: { key?: { files?: string[] } };
        tasks?: Record<string, Task>;
    };

describe("Omni presets", () => {
    const ts = load("ts.omni.yaml");

    // Omni's default cache key does not include sources: without them a task keeps
    // reporting success after the code it checks has changed.
    it("keys every TypeScript task on the project's sources and shared config", () => {
        const files = ts.cache?.key?.files ?? [];
        for (const needed of [
            "src/**/*",
            "package.json",
            "tsconfig*.json",
            "*.config.ts",
            "@workspace/bun.lock",
        ]) {
            expect(files, needed).toContain(needed);
        }
    });

    it("orders tasks after upstream projects' builds", () => {
        for (const name of ["build", "check:types", "test:unit", "test:integration"]) {
            expect(ts.tasks?.[name]?.dependencies, name).toContain("^build");
        }
    });

    it("keeps `test` free of integration tests, which need a database", () => {
        expect(ts.tasks?.test?.dependencies).toEqual(["test:unit"]);
        expect(ts.tasks?.["test:integration"]?.cache?.enabled).toBe(false);
    });

    it("makes lint warnings fail the check", () => {
        expect(ts.tasks?.["check:lint"]?.exec).toContain("--deny-warnings");
    });

    it("has every other preset extend the base TypeScript preset", () => {
        for (const file of readdirSync(dir)) {
            if (file === "ts.omni.yaml") continue;
            expect(load(file).extends, file).toContain("./ts.omni.yaml");
        }
    });
});
