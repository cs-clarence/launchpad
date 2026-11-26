import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Shared by the guide drift tests: every Omni task, project, admin command and CLI command a
// guide names must exist in the repository.
export const root = path.resolve(import.meta.dirname, "..");
export const read = (file: string) => readFileSync(path.join(root, file), "utf8");

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

export const tasks = new Set<string>();
export const projects = new Set<string>();
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

export const adminSource = read("apps/controller/src/admin/main.ts");
export const adminCommands = new Set(
    [...adminSource.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]!),
);
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
export const cliCommands = new Set(
    [...cliSource.matchAll(/\.command\("([a-z-]+)/g)].map((m) => m[1]!),
);

export function commandLines(guide: string): string[] {
    const lines: string[] = [];
    for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
        for (const line of block[1]!.replace(/\\\n\s*/g, " ").split("\n")) {
            lines.push(...line.split("&&").map((part) => part.trim()));
        }
    }
    return lines.filter(Boolean);
}

export function words(line: string): string[] {
    return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}
