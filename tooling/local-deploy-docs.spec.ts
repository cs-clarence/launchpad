import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
    cliCommands,
    commandLines as commandLinesOf,
    projects,
    read,
    root,
    tasks,
    words,
} from "./docs-check";
import {
    COMMANDS,
    DEFAULT_PORT_BASE,
    PORT_OFFSETS,
    SWITCH_FLAGS,
    VALUE_FLAGS,
} from "./local-deploy";

// The deployment guide cannot drift from the repository: every Omni task, script command and
// flag, CLI command, setting and link it names must exist.
const guide = read("docs/local-deploy.md");
const compose = read("docker-compose.yaml");
const cliSource = [
    "program.ts",
    "api-command.ts",
    "app-commands.ts",
    "key-commands.ts",
    "org-commands.ts",
    "invite-commands.ts",
]
    .map((file) => read(`apps/cli/src/${file}`))
    .join("\n");
const lines = commandLinesOf(guide);
const omniLines = lines.filter((line) => line.startsWith("omni "));
const slug = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ /g, "-");

describe("docs/local-deploy.md", () => {
    it("shows commands to check", () => {
        expect(omniLines.length).toBeGreaterThan(5);
        expect(lines.filter((l) => l.includes("launchpad ")).length).toBeGreaterThan(5);
    });

    it("names only Omni tasks, projects, commands and flags that exist", () => {
        const seen = new Set<string>();
        for (const line of omniLines) {
            const w = words(line).slice(1);
            if (w[0] === "remote-sources" || w[0] === "projection") {
                expect(read("CONTRIBUTING.md")).toContain(line);
                continue;
            }
            expect(w.slice(0, 2), line).toEqual(["-i", "run"]);
            const task = w[2]!;
            expect(tasks.has(task), `${task} in: ${line}`).toBe(true);
            seen.add(task);
            if (w.includes("-p")) {
                expect(projects.has(w[w.indexOf("-p") + 1]!), line).toBe(true);
            }
            const at = w.indexOf("-a");
            if (task === "local:deploy" && at >= 0) {
                const [key, ...rest] = w[at + 1]!.split("=");
                expect(key).toBe("options");
                const [command, ...flags] = rest.join("=").split(/\s+/);
                expect(
                    (COMMANDS as readonly string[]).includes(command!) || command === "--help",
                    line,
                ).toBe(true);
                for (const flag of flags.filter((f) => f.startsWith("--"))) {
                    expect([...VALUE_FLAGS, ...SWITCH_FLAGS] as string[], flag).toContain(flag);
                }
            }
        }
        expect([...seen]).toContain("local:deploy");
        for (const command of COMMANDS) {
            expect(guide).toContain(`options=${command}`);
        }
    });

    it("names only launchpad commands, and their subcommands, that exist", () => {
        const used = lines
            .filter((line) => line.includes("launchpad "))
            .flatMap((line) => [...line.matchAll(/launchpad ([a-z-]+)(?: ([a-z-]+))?/g)]);
        expect(used.length).toBeGreaterThan(5);
        for (const [text, command, sub] of used) {
            if (command === "api" || command === "whoami") {
                expect(cliCommands.has(command!), text).toBe(true);
                continue;
            }
            expect(cliCommands.has(command!), text).toBe(true);
            if (sub && !sub.startsWith("-")) {
                expect(cliSource, text).toContain(`.command("${sub}`);
            }
        }
        for (const m of guide.matchAll(/`launchpad ([a-z-]+)/g)) {
            expect(cliCommands.has(m[1]!), m[0]).toBe(true);
        }
    });

    it("names only settings docker-compose.yaml defines", () => {
        for (const name of new Set(guide.match(/\bLAUNCHPAD_[A-Z_]+\b/g) ?? [])) {
            expect(compose, name).toContain(name);
        }
    });

    it("states the default ports the script uses", () => {
        expect(guide).toContain(String(DEFAULT_PORT_BASE + PORT_OFFSETS.http));
        expect(guide).toContain(`${DEFAULT_PORT_BASE}`);
        expect(guide).toContain(String(DEFAULT_PORT_BASE + PORT_OFFSETS.https));
    });

    it("carries the warnings, in order", () => {
        const order = [
            "root-equivalent",
            "binds `127.0.0.1`",
            "unpinned packages",
            "`.local-deploy/`",
            "`down` deletes the database",
            "dashboard does not work",
            "not a production install",
        ];
        let last = -1;
        for (const phrase of order) {
            const at = guide.indexOf(phrase);
            expect(at, phrase).toBeGreaterThan(last);
            last = at;
        }
        expect(guide).toContain("Host: ");
        expect(guide).toContain("/etc/hosts");
        expect(guide).toContain("3.1 GiB");
        expect(guide).toContain("3.6 GiB");
    });

    it("links only to files and headings that exist", () => {
        for (const link of guide.matchAll(/\]\(([^)#]*)(?:#([^)]*))?\)/g)) {
            const [, target, anchor] = link;
            if (target!.startsWith("http")) continue;
            const file = target
                ? path.join(root, "docs", target)
                : path.join(root, "docs/local-deploy.md");
            expect(existsSync(file), link[0]).toBe(true);
            if (anchor) {
                const headings = [...read(path.relative(root, file)).matchAll(/^#+ (.+)$/gm)].map(
                    (m) => slug(m[1]!),
                );
                expect(headings, link[0]).toContain(anchor);
            }
        }
    });

    it("is linked from the other docs", () => {
        expect(read("README.md")).toContain("docs/local-deploy.md");
        expect(read("docs/tooling.md")).toContain("local-deploy.md");
        expect(read("docs/local-quickstart.md")).toContain("local-deploy.md");
        expect(read("docs/patterns/README.md")).toContain("tooling/local-deploy.ts");
        expect(read("docs/production-compose.md")).toContain("local-deploy.md");
        expect(read("CONTRIBUTING.md")).toContain("docs/local-deploy.md");
    });

    it("has no unmeasured cost left", () => {
        expect(guide).not.toMatch(/MEASURED_/);
    });
});
