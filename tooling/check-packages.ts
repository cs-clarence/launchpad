// Builds, packs and installs the client packages the way a user would, outside the workspace,
// and runs them under Bun and (when it is on the PATH) Node. Needs the network for the
// registry dependencies (zod, commander, ...). Publishes nothing. Run by `omni run test:packages`.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TARGETS, build, checkListing, checkManifest, pack, stage } from "./package-clients";

const root = path.resolve(import.meta.dirname, "..");

// What a child sees: no LAUNCHPAD_* settings, credentials or .env of the developer, and a home of
// its own, so a run means the same everywhere. `extra` adds to it.
let scrubbed: Record<string, string> = {};
const STEP_TIMEOUT_MS = 5 * 60_000;

async function exec(command: string[], cwd: string, extra: Record<string, string> = {}) {
    const proc = Bun.spawn(command, {
        cwd,
        env: { ...scrubbed, ...extra },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: STEP_TIMEOUT_MS,
        killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { out, err, code };
}

const problems: string[] = [];
const fail = (message: string) => problems.push(message);

async function main() {
    const work = mkdtempSync(path.join(tmpdir(), "launchpad-packages-"));
    scrubbed = {
        PATH: process.env.PATH ?? "",
        HOME: path.join(work, "home"),
        // Not the shared package cache: nothing this job installs may reach a cache that is saved.
        BUN_INSTALL_CACHE_DIR: path.join(work, "bun-cache"),
    };
    mkdirSync(scrubbed.HOME!, { recursive: true });
    try {
        const tarballs: Record<string, string> = {};
        for (const target of TARGETS) {
            await build(target);
            const staged = await stage(target, work);
            const tarball = await pack(staged, path.join(work, "tarballs"));
            const manifest = JSON.parse(readFileSync(path.join(staged, "package.json"), "utf8"));
            tarballs[manifest.name] = tarball;
            const listing = (await exec(["tar", "tzf", tarball], work)).out
                .split("\n")
                .filter(Boolean)
                .map((line) => line.replace(/^package\//, ""));
            for (const p of checkListing(listing)) fail(`${manifest.name}: ${p}`);
            for (const p of checkManifest(manifest)) fail(`${manifest.name}: ${p}`);
            console.log(`${manifest.name}: ${listing.join(", ")}`);
        }
        if (problems.length > 0) return;

        // A user's project, outside the workspace. The registry has no @launchpad-kit packages of
        // ours, so every one of them is pinned to its tarball (an override also covers the
        // dependency of one package on another, which would otherwise be looked up by name).
        const consumer = path.join(work, "consumer");
        mkdirSync(consumer);
        const files = Object.fromEntries(
            Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
        );
        const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
        writeFileSync(
            path.join(consumer, "package.json"),
            JSON.stringify({
                name: "consumer",
                private: true,
                type: "module",
                dependencies: files,
                devDependencies: { typescript: rootManifest.catalog.typescript },
                overrides: files,
                resolutions: files,
            }),
        );
        // The registry may hold a package named like ours (the scope is not registered here): the
        // overrides pin each one to its tarball, and this makes any lookup that still happens fail
        // instead of being answered by someone else's package.
        writeFileSync(
            path.join(consumer, "bunfig.toml"),
            '[install.scopes]\n"@launchpad-kit" = "http://127.0.0.1:9/"\n',
        );
        const install = await exec(["bun", "install", "--no-save", "--ignore-scripts"], consumer);
        if (install.code !== 0) return fail(`install failed:\n${install.out}\n${install.err}`);

        // What was installed is what was packed, not something resolved by name.
        for (const [name, file] of Object.entries(tarballs)) {
            const installed = JSON.parse(
                readFileSync(path.join(consumer, "node_modules", name, "package.json"), "utf8"),
            );
            const wanted = JSON.parse(
                (await exec(["tar", "xzOf", file, "package/package.json"], work)).out,
            );
            if (JSON.stringify(installed) !== JSON.stringify(wanted)) {
                fail(`${name}: the installed manifest is not the packed one`);
            }
        }

        const runtimes = [
            "bun",
            ...((await exec(["node", "--version"], work).catch(() => null))?.code === 0
                ? ["node"]
                : []),
        ];
        console.log(`runtimes: ${runtimes.join(", ")}`);
        const bin = (file: string) => path.join(consumer, "node_modules", file);

        // The SDK against a tiny local server standing in for the controller.
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(request) {
                const url = new URL(request.url);
                return url.pathname === "/api/v1/organizations"
                    ? Response.json([])
                    : new Response("not found", { status: 404 });
            },
        });
        writeFileSync(
            path.join(consumer, "smoke.mjs"),
            `import { createClient } from "@launchpad-kit/sdk";
import { parseDuration } from "@launchpad-kit/contracts";
const client = createClient({ baseUrl: "http://127.0.0.1:${server.port}", apiKey: "lp_" + "a".repeat(30) });
const organizations = await client.organizations.list();
if (!Array.isArray(organizations) || organizations.length !== 0) throw new Error("unexpected answer");
if (typeof parseDuration !== "function") throw new Error("contracts export missing");
console.log("sdk ok");
`,
        );
        writeFileSync(
            path.join(consumer, "mcp-handshake.mjs"),
            `import { spawn } from "node:child_process";
const [runtime, file] = process.argv.slice(2);
const child = spawn(runtime, [file, "--shared"], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const reply = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
        buffer += chunk;
        // Only a complete line is a message.
        const end = buffer.indexOf("\\n");
        if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("exited " + code)));
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-check", version: "0" } } }) + "\\n");
let timer;
const message = await Promise.race([
    reply,
    new Promise((_, r) => { timer = setTimeout(() => r(new Error("no reply")), 20000); }),
]).finally(() => { clearTimeout(timer); child.kill(); });
if (!message.result?.serverInfo?.name) throw new Error("no server info: " + JSON.stringify(message));
console.log("mcp ok: " + message.result.serverInfo.name);
`,
        );
        for (const runtime of runtimes) {
            for (const [label, args] of [
                ["cli --help", [runtime, bin("@launchpad-kit/cli/cli.mjs"), "--help"]],
                ["mcp --help", [runtime, bin("@launchpad-kit/mcp/mcp.mjs"), "--help"]],
                ["sdk", [runtime, "smoke.mjs"]],
                [
                    "mcp handshake",
                    [runtime, "mcp-handshake.mjs", runtime, bin("@launchpad-kit/mcp/mcp.mjs")],
                ],
            ] as const) {
                const result = await exec([...args], consumer);
                const helpShown =
                    label !== "mcp --help" || /launchpad-mcp/.test(`${result.out}${result.err}`);
                if (result.code !== 0 || !helpShown) {
                    fail(
                        `${runtime}: ${label} failed (${result.code}):\n${result.out}\n${result.err}`,
                    );
                } else {
                    console.log(`${runtime}: ${label} ok`);
                }
            }
        }
        // The installed command itself (its link, shebang and bin field), as a user runs it.
        // (The shebang names node, so this needs it.)
        for (const command of runtimes.includes("node") ? ["launchpad", "launchpad-mcp"] : []) {
            const result = await exec(
                [path.join(consumer, "node_modules/.bin", command), "--help"],
                consumer,
            );
            if (result.code !== 0 || !/launchpad/.test(`${result.out}${result.err}`)) {
                fail(
                    `${command} --help through node_modules/.bin failed (${result.code}):\n${result.err}`,
                );
            } else console.log(`${command} (bin) ok`);
        }
        server.stop(true);

        // The declarations as a TypeScript user sees them: strict, and not skipping library files.
        writeFileSync(
            path.join(consumer, "types.ts"),
            `import { createClient, type ClientOptions } from "@launchpad-kit/sdk";
import { parseDuration } from "@launchpad-kit/contracts";
const options: ClientOptions = { baseUrl: "https://launchpad.example.com", apiKey: "lp_x" };
const client = createClient(options);
const organizations: ReturnType<typeof client.organizations.list> = client.organizations.list();
const seconds: number | null = parseDuration("1h");
void organizations; void seconds;
`,
        );
        const tsc = await exec(
            [
                "bun",
                "--bun",
                path.join(consumer, "node_modules/.bin/tsc"),
                "--noEmit",
                "--strict",
                "--target",
                "es2022",
                "--module",
                "nodenext",
                "--moduleResolution",
                "nodenext",
                "--types",
                "",
                "types.ts",
            ],
            consumer,
        );
        if (tsc.code !== 0) fail(`types.ts does not type-check:\n${tsc.out}\n${tsc.err}`);
        else console.log("types ok");
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

await main().catch((error) => fail(String(error instanceof Error ? error.stack : error)));
if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
}
console.log("The packages install and run outside the workspace.");
