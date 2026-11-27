// Builds, packs and installs the client packages the way a user would, outside the workspace:
// once with Bun and once with real npm (shipped with the selected Node), and runs them under
// Bun and Node (LAUNCHPAD_NODE, else `node` on the PATH; a missing Node skips the Node runs
// locally and fails when CI is set). Needs the network for the registry dependencies (zod,
// commander, ...). Publishes nothing. Run by `omni run test:packages`.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    TARGETS,
    build,
    findNode,
    nodeShim,
    resolveNode,
    checkLibrary,
    checkListing,
    checkManifest,
    checkRepository,
    checkClosure,
    checkLock,
    checkLs,
    findNpm,
    installedCopies,
    checkUnbundled,
    checkBin,
    pack,
    readPacked,
    stage,
} from "./package-clients";

const root = path.resolve(import.meta.dirname, "..");

// What a child sees: no LAUNCHPAD_* settings, credentials or .env of the developer, and a home of
// its own, so a run means the same everywhere. `extra` adds to it.
let scrubbed: Record<string, string> = {};
const STEP_TIMEOUT_MS = 5 * 60_000;
// The npm install: the registry fetch of the third-party packages dominates; the five owned ones
// add about a second. Past this, something is waiting on a registry lookup it should not make.
const NPM_INSTALL_BUDGET_MS = 120_000;

async function exec(
    command: string[],
    cwd: string,
    extra: Record<string, string> = {},
    timeout = STEP_TIMEOUT_MS,
) {
    const proc = Bun.spawn(command, {
        cwd,
        env: { ...scrubbed, ...extra },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout,
        killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { out, err, code };
}

// Resolved before anything changes directory, so a relative LAUNCHPAD_NODE means what it says.
const NODE = resolveNode(process.env.LAUNCHPAD_NODE, process.cwd());

const NODE_EXECUTABLE = findNode(NODE, process.env.PATH);

const problems: string[] = [];
const fail = (message: string) => problems.push(message);

async function main() {
    const work = mkdtempSync(path.join(tmpdir(), "launchpad-packages-"));
    scrubbed = {
        // A `node` link to the chosen Node first, so a bin's `#!/usr/bin/env node` finds it too,
        // whatever the executable is called. It lives in `work`, which the finally removes.
        PATH: [
            ...(NODE_EXECUTABLE ? [nodeShim(NODE_EXECUTABLE, path.join(work, "node-shim"))] : []),
            process.env.PATH ?? "",
        ].join(":"),
        HOME: path.join(work, "home"),
        // Not the shared package cache: nothing this job installs may reach a cache that is saved.
        BUN_INSTALL_CACHE_DIR: path.join(work, "bun-cache"),
    };
    mkdirSync(scrubbed.HOME!, { recursive: true });
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        const tarballs: Record<string, string> = {};
        const manifests: Record<string, unknown>[] = [];
        for (const target of TARGETS) {
            await build(target);
            const source = JSON.parse(
                readFileSync(path.join(root, target.dir, "package.json"), "utf8"),
            );
            for (const p of checkRepository(source, target.dir)) {
                fail(`${target.dir}/package.json: ${p}`);
            }
            const staged = await stage(target, work);
            const tarball = await pack(staged, path.join(work, "tarballs"));
            const manifest = JSON.parse(readFileSync(path.join(staged, "package.json"), "utf8"));
            tarballs[manifest.name] = tarball;
            manifests.push(manifest);
            const { listing, text } = await readPacked(tarball);
            for (const p of checkListing(listing)) fail(`${manifest.name}: ${p}`);
            for (const p of checkLibrary(manifest, listing)) fail(`${manifest.name}: ${p}`);
            for (const p of checkManifest(manifest, target.dir)) fail(`${manifest.name}: ${p}`);
            for (const p of checkBin(manifest, listing)) fail(`${manifest.name}: ${p}`);
            for (const p of checkUnbundled(manifest, text)) fail(`${manifest.name}: ${p}`);
            console.log(`${manifest.name}: ${listing.join(", ")}`);
        }
        for (const p of checkClosure(manifests)) fail(p);
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

        const nodeBin = NODE_EXECUTABLE ?? NODE;
        const nodeVersion = await exec([nodeBin, "--version"], work).catch(() => null);
        const hasNode = nodeVersion?.code === 0;
        if (!hasNode) {
            if (process.env.CI)
                return fail(`Node (${nodeBin}) is required in CI and was not found.`);
            console.warn(`SKIPPED the Node runs: ${nodeBin} not found (set LAUNCHPAD_NODE).`);
        } else console.log(`node: ${nodeBin} ${nodeVersion.out.trim()}`);
        const runtimes = ["bun", ...(hasNode ? ["node"] : [])];
        const runner = (runtime: string) => (runtime === "node" ? nodeBin : runtime);
        console.log(`runtimes: ${runtimes.join(", ")}`);
        const consumers = [{ kind: "bun", dir: consumer, runtimes }];

        if (hasNode) {
            const npmConsumer = await installWithNpm(work, tarballs, manifests);
            if (npmConsumer) consumers.push({ kind: "npm", dir: npmConsumer, runtimes: ["node"] });
        }

        // The SDK against a tiny local server standing in for the controller.
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/api/v1/organizations") return Response.json([]);
                if (
                    url.pathname === "/api/v1/organizations/test/projects/project/artifacts" &&
                    request.method === "POST" &&
                    request.headers.get("content-type") === "application/gzip" &&
                    (await request.arrayBuffer()).byteLength === 3
                ) {
                    return Response.json(
                        {
                            id: "11111111-1111-4111-8111-111111111111",
                            digest: "a".repeat(64),
                            sizeBytes: 3,
                            expandedBytes: 3,
                            entryCount: 1,
                            createdAt: "2026-11-21T00:00:00Z",
                            reused: false,
                        },
                        { status: 201 },
                    );
                }
                return new Response("not found", { status: 404 });
            },
        });
        for (const { kind, dir: consumer, runtimes } of consumers) {
            const bin = (file: string) => path.join(consumer, "node_modules", file);
            writeFileSync(
                path.join(consumer, "smoke.mjs"),
                `import { createClient } from "@launchpad-kit/sdk";
    import { parseDuration } from "@launchpad-kit/contracts";
    const client = createClient({ baseUrl: "http://127.0.0.1:${server.port}", apiKey: "lp_" + "a".repeat(30) });
    const organizations = await client.organizations.list();
    if (!Array.isArray(organizations) || organizations.length !== 0) throw new Error("unexpected answer");
    const uploaded = await client.artifacts.upload("test", "project", new Blob([new Uint8Array([31, 139, 8])]));
    if (uploaded.sizeBytes !== 3) throw new Error("unexpected upload response");
    if (typeof parseDuration !== "function") throw new Error("contracts export missing");
    console.log("sdk ok");
    `,
            );
            writeFileSync(
                path.join(consumer, "core.mjs"),
                [
                    'import { mkdtempSync } from "node:fs";',
                    'import { tmpdir } from "node:os";',
                    'import path from "node:path";',
                    'import { CredentialStore, configDirectory } from "@launchpad-kit/client-core";',
                    'const dir = mkdtempSync(path.join(tmpdir(), "launchpad-core-"));',
                    'if (configDirectory({ LAUNCHPAD_CONFIG_DIR: dir }) !== dir) throw new Error("config directory");',
                    "const config = await new CredentialStore(dir).load();",
                    "if (config.version !== 1 || config.currentProfile !== null || Object.keys(config.profiles).length !== 0) {",
                    '    throw new Error("unexpected empty config: " + JSON.stringify(config));',
                    "}",
                    'console.log("client-core ok");',
                    "",
                ].join("\n"),
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
                const run = runner(runtime);
                const expectedVersion = JSON.parse(
                    readFileSync(path.join(root, "package.json"), "utf8"),
                ).version as string;
                for (const [label, args] of [
                    ["cli --version", [run, bin("@launchpad-kit/cli/cli.mjs"), "--version"]],
                    [
                        "contracts and sdk import",
                        [
                            run,
                            "--input-type=module",
                            "-e",
                            'await import("@launchpad-kit/contracts"); await import("@launchpad-kit/sdk");',
                        ],
                    ],
                    ["cli --help", [run, bin("@launchpad-kit/cli/cli.mjs"), "--help"]],
                    ["mcp --help", [run, bin("@launchpad-kit/mcp/mcp.mjs"), "--help"]],
                    ["sdk", [run, "smoke.mjs"]],
                    ["client-core", [run, "core.mjs"]],
                    [
                        "mcp handshake",
                        [run, "mcp-handshake.mjs", run, bin("@launchpad-kit/mcp/mcp.mjs")],
                    ],
                ] as const) {
                    const result = await exec([...args], consumer);
                    const output = `${result.out}${result.err}`;
                    const shown =
                        (label !== "mcp --help" || /launchpad-mcp/.test(output)) &&
                        (!label.endsWith("--version") || output.includes(expectedVersion));
                    if (result.code !== 0 || !shown) {
                        fail(
                            `${kind}/${runtime}: ${label} failed (${result.code}):\n${result.out}\n${result.err}`,
                        );
                    } else {
                        console.log(`${kind}/${runtime}: ${label} ok`);
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
                        `${kind}: ${command} --help through node_modules/.bin failed (${result.code}):\n${result.err}`,
                    );
                } else console.log(`${kind}: ${command} (bin) ok`);
            }

            // The declarations as a TypeScript user sees them: strict, and not skipping library files.
            writeFileSync(
                path.join(consumer, "types.ts"),
                `import { createClient, type ClientOptions } from "@launchpad-kit/sdk";
    import { parseDuration } from "@launchpad-kit/contracts";
    import { CredentialStore, type Config } from "@launchpad-kit/client-core";
    const options: ClientOptions = { baseUrl: "https://launchpad.example.com", apiKey: "lp_x" };
    const client = createClient(options);
    const organizations: ReturnType<typeof client.organizations.list> = client.organizations.list();
    const seconds: number | null = parseDuration("1h");
    const promote: typeof client.aliases.promote = client.aliases.promote;
    const store: CredentialStore = new CredentialStore("/tmp");
    const loaded: Promise<Config> = store.load();
    void organizations; void seconds; void promote; void loaded;
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
            if (tsc.code !== 0)
                fail(`${kind}: types.ts does not type-check:\n${tsc.out}\n${tsc.err}`);
            else console.log(`${kind}: types ok`);
        }
    } finally {
        server?.stop(true);
        rmSync(work, { recursive: true, force: true });
    }
}

// Installs the tarballs with npm into a project of their own, the way a user does, and returns its
// directory (or null when there is no npm and this is not CI). Owned packages are direct `file:`
// dependencies pinned again by `$name` overrides, so npm never looks them up by name: they carry
// caret ranges between them, and a registry lookup could answer with a newer matching version.
async function installWithNpm(
    work: string,
    tarballs: Record<string, string>,
    manifests: Record<string, unknown>[],
): Promise<string | null> {
    const npm = findNpm(NODE_EXECUTABLE, scrubbed.PATH);
    if (!npm) {
        if (process.env.CI)
            fail("npm is required in CI and was not found beside Node or on the PATH.");
        else console.warn("SKIPPED the npm install: npm not found beside the selected Node.");
        return null;
    }
    const home = path.join(work, "npm-home");
    mkdirSync(home, { recursive: true });
    const userconfig = path.join(home, ".npmrc");
    // Any lookup of an owned name fails at once instead of being answered by someone else's
    // package or retried for a minute.
    writeFileSync(userconfig, "@launchpad-kit:registry=http://127.0.0.1:9/\nfetch-retries=0\n");
    const env = {
        HOME: home,
        NPM_CONFIG_CACHE: path.join(home, "cache"),
        npm_config_userconfig: userconfig,
        NPM_CONFIG_PREFIX: path.join(home, "prefix"),
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
    };
    const dir = path.join(work, "consumer-npm");
    mkdirSync(dir);
    const files = Object.fromEntries(
        Object.entries(tarballs).map(([name, file]) => [name, `file:${file}`]),
    );
    const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
            name: "consumer-npm",
            private: true,
            type: "module",
            dependencies: files,
            devDependencies: { typescript: rootManifest.catalog.typescript },
            overrides: Object.fromEntries(Object.keys(tarballs).map((name) => [name, `$${name}`])),
        }),
    );
    const version = (await exec([npm, "--version"], work, env)).out.trim();
    const started = Date.now();
    const install = await exec(
        [npm, "install", "--no-audit", "--no-fund", "--ignore-scripts"],
        dir,
        env,
        NPM_INSTALL_BUDGET_MS,
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (install.code !== 0) {
        fail(
            `npm ${version} install failed after ${seconds}s (budget ${NPM_INSTALL_BUDGET_MS / 1000}s):\n${install.out}\n${install.err}`,
        );
        return null;
    }
    console.log(`npm ${version}: installed in ${seconds}s`);

    const expected = Object.entries(tarballs).map(([name, file]) => ({
        name,
        file,
        version: String(manifests.find((m) => m.name === name)?.version),
        bytes: readFileSync(file),
    }));
    for (const { name, version: packed } of expected) {
        const installed = JSON.parse(
            readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8"),
        );
        const wanted = JSON.parse(
            (await exec(["tar", "xzOf", tarballs[name]!, "package/package.json"], work)).out,
        );
        if (installed.version !== packed || JSON.stringify(installed) !== JSON.stringify(wanted)) {
            fail(`npm: ${name}: the installed manifest is not the packed one`);
        }
    }
    const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8"));
    for (const p of checkLock(lock, expected)) fail(`npm: ${p}`);
    // Parsed even when npm exits non-zero: it reports invalid and missing packages that way.
    const ls = await exec([npm, "ls", "--all", "--json"], dir, env);
    try {
        for (const p of checkLs(JSON.parse(ls.out))) fail(`npm ls: ${p}`);
    } catch {
        fail(`npm ls printed no JSON (${ls.code}):\n${ls.out}\n${ls.err}`);
    }
    for (const [name, found] of Object.entries(installedCopies(path.join(dir, "node_modules")))) {
        if (found.length !== 1)
            fail(`npm: ${name} is installed ${found.length} times: ${found.join(", ")}`);
    }
    return dir;
}

await main().catch((error) => fail(String(error instanceof Error ? error.stack : error)));
if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}`);
    process.exit(1);
}
console.log("The packages install and run outside the workspace.");
