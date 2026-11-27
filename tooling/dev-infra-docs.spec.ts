import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { commandLines as commandLinesOf, projects, read, root, tasks, words } from "./docs-check";
import { COMMANDS, PORT_DEFAULTS, PORT_KEYS, SWITCH_FLAGS, VALUE_FLAGS } from "./dev-infra";

// The guide cannot drift from the repository: every Omni task, script command and flag, setting
// and link it names must exist.
const guide = read("docs/local-dev-infra.md");
const devCompose = read("docker-compose.dev.yaml");
const lines = commandLinesOf(guide);
const omniLines = lines.filter((line) => line.startsWith("omni "));
const slug = (heading: string) =>
    heading
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ /g, "-");

describe("docs/local-dev-infra.md", () => {
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
            if (task.startsWith("dev:infra:") && at >= 0) {
                const [key, ...rest] = w[at + 1]!.split("=");
                expect(key).toBe("options");
                for (const flag of rest
                    .join("=")
                    .split(/\s+/)
                    .filter((f) => f.startsWith("--"))) {
                    expect([...VALUE_FLAGS, ...SWITCH_FLAGS] as string[], flag).toContain(flag);
                }
            }
        }
        for (const command of COMMANDS) {
            expect([...seen], command).toContain(`dev:infra:${command}`);
            expect(tasks.has(`dev:infra:${command}`), command).toBe(true);
        }
    });

    it("names only settings the Compose files, the apps' examples or the tool define", () => {
        const known = [
            devCompose,
            read("docker-compose.yaml"),
            read("apps/controller/.env.local.example"),
            read("apps/worker/.env.local.example"),
            read("tooling/dev-infra.ts"),
        ].join("\n");
        for (const name of new Set(guide.match(/\b(?:LAUNCHPAD|DEV)_[A-Z_]+\b/g) ?? [])) {
            if (name === "LAUNCHPAD_PROFILE") {
                expect(read("packages/client-core/README.md"), name).toContain(name);
            } else {
                expect(known, name).toContain(name);
            }
        }
    });

    it("states the default ports and variables the tool and the Compose file use", () => {
        for (const [name, port] of Object.entries(PORT_DEFAULTS)) {
            expect(guide, name).toContain(String(port));
            const variable = PORT_KEYS[name as keyof typeof PORT_KEYS];
            expect(guide, variable).toContain(variable);
            expect(devCompose, variable).toContain(`\${${variable}:-${port}}`);
        }
    });

    it("carries the warnings, in order", () => {
        const order = [
            "root-equivalent",
            "binds `127.0.0.1`",
            "unpinned packages",
            "`.dev-infra/`",
            "`dev:infra:destroy` deletes",
            "Mailpit keeps mail in memory",
            "cannot both work",
            "not a production install",
        ];
        let last = -1;
        for (const phrase of order) {
            const at = guide.indexOf(phrase);
            expect(at, phrase).toBeGreaterThan(last);
            last = at;
        }
        expect(guide).toContain("Host: ");
        expect(guide).toContain("plain HTTP");
    });

    it("links only to files and headings that exist", () => {
        for (const link of guide.matchAll(/\]\(([^)#]*)(?:#([^)]*))?\)/g)) {
            const [, target, anchor] = link;
            if (target!.startsWith("http")) continue;
            const file = target
                ? path.join(root, "docs", target)
                : path.join(root, "docs/local-dev-infra.md");
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
        expect(read("README.md")).toContain("docs/local-dev-infra.md");
        expect(read("docs/tooling.md")).toContain("local-dev-infra.md");
        expect(read("docs/local-quickstart.md")).toContain("local-dev-infra.md");
        expect(read("docs/local-deploy.md")).toContain("local-dev-infra.md");
        expect(read("docs/patterns/README.md")).toContain("tooling/dev-infra.ts");
        expect(read("docs/production-compose.md")).toContain("local-dev-infra.md");
        expect(read("CONTRIBUTING.md")).toContain("docs/local-dev-infra.md");
        expect(read("apps/worker/README.md")).toContain("local-dev-infra.md");
    });

    it("gives every docker compose command the generated config", () => {
        const found = [...guide.matchAll(/docker compose [^`\n]*/g)].map((m) => m[0]);
        expect(found.length).toBeGreaterThan(0);
        for (const text of found) {
            expect(text, text).toMatch(
                /-p <project> --env-file \.dev-infra\/compose\.env -f docker-compose\.dev\.yaml/,
            );
        }
    });
});
