import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SWITCH_FLAGS, VALUE_FLAGS } from "./local-seed";

// The guide cannot drift from the repository: every Omni task, project, script flag, admin
// command, CLI command, setting and link it names must exist.
const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const guide = read("docs/local-quickstart.md");

function yamlFiles(dir: string): string[] {
    return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "node_modules" || entry.name.startsWith(".")
                ? []
                : yamlFiles(rel);
        }
        return entry.name.endsWith(".omni.yaml") ? [rel] : [];
    });
}

const tasks = new Set<string>();
const projects = new Set<string>();
for (const file of [
    ...yamlFiles("apps"),
    ...yamlFiles("packages"),
    ...yamlFiles("tooling"),
    ...yamlFiles("omni"),
]) {
    const parsed = Bun.YAML.parse(read(file)) as {
        name?: string;
        tasks?: Record<string, unknown>;
    } | null;
    if (parsed?.name?.startsWith("@launchpad-kit/")) projects.add(parsed.name);
    for (const task of Object.keys(parsed?.tasks ?? {})) tasks.add(task);
}

const adminSource = read("apps/controller/src/admin/main.ts");
const adminCommands = new Set(
    [...adminSource.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]!),
);
const cliSource = ["program.ts", "api-command.ts", "app-commands.ts"]
    .map((file) => read(`apps/cli/src/${file}`))
    .join("\n");
const cliCommands = new Set([...cliSource.matchAll(/\.command\("([a-z-]+)/g)].map((m) => m[1]!));
const scriptFlags = new Set<string>([...VALUE_FLAGS, ...SWITCH_FLAGS]);

function commandLines(): string[] {
    const lines: string[] = [];
    for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
        for (const line of block[1]!.replace(/\\\n\s*/g, " ").split("\n")) {
            lines.push(...line.split("&&").map((part) => part.trim()));
        }
    }
    return lines.filter(Boolean);
}

function words(line: string): string[] {
    return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

const omniLines = commandLines().filter((line) => line.startsWith("omni "));

describe("docs/local-quickstart.md", () => {
    it("shows commands to check", () => {
        expect(omniLines.length).toBeGreaterThan(5);
    });

    it("names only Omni tasks and projects that exist", () => {
        const seen = new Set<string>();
        for (const line of omniLines) {
            const w = words(line).slice(1);
            if (w[0] === "remote-sources" || w[0] === "projection") {
                expect(read("CONTRIBUTING.md")).toContain(line);
                continue;
            }
            expect(w.slice(0, 2), line).toEqual(["-i", "run"]);
            for (const task of w
                .slice(2)
                .filter((word, i, all) => !word.startsWith("-") && !all[i - 1]?.startsWith("-"))) {
                expect(tasks.has(task), `${task} in: ${line}`).toBe(true);
                seen.add(task);
            }
            const project = w[w.indexOf("-p") + 1];
            if (w.includes("-p"))
                expect(projects.has(project!), `${project} in: ${line}`).toBe(true);
        }
        expect([...seen]).toContain("local:seed");
        expect([...seen]).toContain("dev");
    });

    it("uses only flags and admin commands that exist", () => {
        for (const line of omniLines) {
            const w = words(line);
            for (const [i, word] of w.entries()) {
                if (word !== "-a") continue;
                const [key, ...rest] = w[i + 1]!.split("=");
                const value = rest.join("=");
                if (key === "command") expect(adminCommands.has(value), line).toBe(true);
                if (key === "options" && line.includes("local:seed")) {
                    for (const flag of value.split(/\s+/).filter((v) => v.startsWith("--"))) {
                        expect(scriptFlags.has(flag), `${flag} in: ${line}`).toBe(true);
                    }
                }
                if (key === "options" && line.includes("admin")) {
                    for (const flag of value.split(/\s+/).filter((v) => v.startsWith("--"))) {
                        expect(adminSource, `${flag} in: ${line}`).toContain(`"${flag}`);
                    }
                }
            }
        }
    });

    it("names only launchpad commands that exist", () => {
        const used = commandLines()
            .filter((line) => line.startsWith("launchpad "))
            .map((line) => words(line)[1]!);
        expect(used).toContain("whoami");
        for (const command of used) expect(cliCommands.has(command), command).toBe(true);
        for (const line of guide.matchAll(/`launchpad ([a-z-]+)/g)) {
            expect(cliCommands.has(line[1]!), line[0]).toBe(true);
        }
    });

    it("names only settings the controller and CLI document", () => {
        const documented = [
            "apps/controller/README.md",
            "apps/controller/.env.local.example",
            "packages/client-core/README.md",
        ]
            .map(read)
            .join("\n");
        const names = new Set([
            ...(guide.match(/\bLAUNCHPAD_[A-Z_]+\b/g) ?? []),
            "DATABASE_URL",
            ...[...guide.matchAll(/`(HOST|PORT)`/g)].map((m) => m[1]!),
        ]);
        for (const name of names) expect(documented, name).toContain(name);
    });

    it("links only to files that exist", () => {
        for (const link of guide.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
            if (link[1]!.startsWith("http")) continue;
            expect(existsSync(path.join(root, "docs", link[1]!)), link[1]).toBe(true);
        }
    });

    it("is linked from the README and the tooling page", () => {
        expect(read("README.md")).toContain("docs/local-quickstart.md");
        expect(read("docs/tooling.md")).toContain("local-quickstart.md");
    });
});
