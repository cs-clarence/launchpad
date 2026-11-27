import { afterEach, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import {
    findNode,
    nodeShim,
    resolveNode,
    checkLibrary,
    checkListing,
    checkManifest,
    REPOSITORY_URL,
    repositoryFields,
    checkBareImports,
    checkBin,
    checkClosure,
    checkLock,
    checkLs,
    findNpm,
    installedCopies,
    checkUnbundled,
    MARKERS,
    SIZE_BUDGETS,
    MEASURED_SIZES,
    budgetFor,
    packedDependencies,
    SHEBANG,
    stageExecutable,
    TARGETS,
    withExtensions,
} from "./package-clients";

describe("checkListing", () => {
    it("accepts what a published package holds", () => {
        expect(
            checkListing(["package.json", "README.md", "LICENSE", "cli.mjs", "index.d.ts"]),
        ).toEqual([]);
    });

    it("refuses env files, sources, tests, source maps and nested modules", () => {
        const problems = checkListing([
            "package.json",
            "LICENSE",
            ".env",
            ".env.local",
            "src/index.ts",
            "dist/__tests__/a.d.ts",
            "client.spec.d.ts",
            "index.mjs.map",
            "node_modules/x/index.js",
            "tsconfig.json",
        ]);
        expect(problems).toHaveLength(8);
        expect(
            checkListing([
                "package.json",
                "LICENSE",
                ".npmrc",
                "key.pem",
                "stray.tgz",
                "x.ts",
                "dist/a.mjs",
            ]),
        ).toHaveLength(5);
    });

    it("accepts only a file named exactly LICENSE", () => {
        for (const file of ["LICENSE.md", "LICENSE.txt", "sub/LICENSE"]) {
            expect(checkListing(["package.json", "LICENSE", file])).toEqual([
                `${file}: must not be packed`,
            ]);
        }
    });

    it("needs a package.json and the LICENSE", () => {
        expect(checkListing(["index.mjs"])).toEqual([
            "package.json is missing",
            "LICENSE is missing",
        ]);
    });
});

describe("checkLibrary", () => {
    const clientCore = [
        "package.json",
        "README.md",
        "LICENSE",
        "index.mjs",
        "index.d.ts",
        "store.d.ts",
    ];

    it("accepts the files of a packed client-core", () => {
        expect(checkLibrary({ name: "@x/y" }, clientCore)).toEqual([]);
    });

    it("refuses sources, specs, tsconfig and other development files", () => {
        const problems = checkLibrary({ name: "@x/y" }, [
            ...clientCore,
            "src/index.ts",
            "index.spec.d.ts",
            "tsconfig.json",
            "vite.config.ts",
            "project.omni.yaml",
        ]);
        expect(problems.length).toBeGreaterThanOrEqual(5);
        expect(problems.join("\n")).toContain("tsconfig.json");
    });

    it("rejects spec and test files and node_modules even with an allowed extension", () => {
        expect(checkLibrary({ name: "x" }, [...clientCore, "index.spec.d.ts"])).toContainEqual(
            "index.spec.d.ts: tests and dependencies are not packed",
        );
        expect(checkLibrary({ name: "x" }, [...clientCore, "foo.test.mjs"])).toContainEqual(
            "foo.test.mjs: tests and dependencies are not packed",
        );
        expect(
            checkLibrary({ name: "x" }, [...clientCore, "node_modules/a/index.mjs"]),
        ).toContainEqual("node_modules/a/index.mjs: tests and dependencies are not packed");
    });

    it("needs its entry points and README, and leaves executables to checkBin", () => {
        expect(checkLibrary({ name: "x" }, ["package.json"])).toHaveLength(3);
        expect(checkLibrary({ bin: { x: "./cli.mjs" } }, ["package.json", "cli.mjs"])).toEqual([]);
    });

    it("refuses a client-core manifest that cannot install from the registry", () => {
        expect(
            checkManifest(
                {
                    name: "@launchpad-kit/client-core",
                    version: "0.1.0",
                    license: "Apache-2.0",
                    ...repositoryFields("packages/client-core"),
                    private: true,
                    dependencies: { "@launchpad-kit/sdk": "workspace:^", zod: "catalog:" },
                },
                "packages/client-core",
            ),
        ).toHaveLength(3);
    });
});

describe("checkManifest", () => {
    const good = {
        name: "@x/y",
        version: "1.0.0",
        license: "Apache-2.0",
        ...repositoryFields("packages/y"),
        dependencies: { zod: "^4.0.0" },
    };
    const dir = "packages/y";

    it("refuses a missing or different license", () => {
        expect(checkManifest({ ...good, license: undefined }, dir)).toEqual([
            'license must be "Apache-2.0"',
        ]);
        expect(checkManifest({ ...good, license: "MIT" }, dir)).toHaveLength(1);
    });

    it("states the repository, homepage and bugs under the one constant", () => {
        expect(REPOSITORY_URL).toBe("https://github.com/launchpad-kit/launchpad");
        expect(repositoryFields("apps/cli")).toEqual({
            repository: {
                type: "git",
                url: "git+https://github.com/launchpad-kit/launchpad.git",
                directory: "apps/cli",
            },
            homepage: "https://github.com/launchpad-kit/launchpad#readme",
            bugs: { url: "https://github.com/launchpad-kit/launchpad/issues" },
        });
    });

    it("refuses a missing repository, homepage or bugs", () => {
        expect(checkManifest({ ...good, repository: undefined }, dir)).toEqual([
            "repository is missing",
        ]);
        expect(checkManifest({ ...good, homepage: undefined }, dir)).toHaveLength(1);
        expect(checkManifest({ ...good, bugs: undefined }, dir)).toHaveLength(1);
    });

    it("refuses a repository url that is not exactly the repository (trusted publishing)", () => {
        const repo = (url: string) => ({ ...good, repository: { ...good.repository, url } });
        for (const url of [
            "git+https://github.com/cs-clarence/launchpad.git",
            "http://github.com/launchpad-kit/launchpad.git",
            "https://github.com/launchpad-kit/launchpad.git",
            "git+https://github.com/launchpad-kit/launchpad",
        ]) {
            expect(checkManifest(repo(url), dir)).toHaveLength(1);
        }
    });

    it("refuses a repository directory that is not the package's", () => {
        expect(checkManifest(good, "packages/other")).toContainEqual(
            'repository.directory must be "packages/other"',
        );
    });

    it("accepts a registry-installable manifest", () => {
        expect(checkManifest(good, dir)).toEqual([]);
    });

    it("refuses specifiers that only work inside the repository, private, and dev dependencies", () => {
        expect(
            checkManifest(
                {
                    ...good,
                    private: true,
                    dependencies: {
                        a: "workspace:^",
                        b: "catalog:",
                        c: "file:../c",
                        e: "github:x/y",
                    },
                    devDependencies: { d: "^1.0.0" },
                },
                dir,
            ),
        ).toHaveLength(6);
    });
});

describe("withExtensions", () => {
    const files = new Map<string, "file" | "dir">([
        ["./client", "file"],
        ["./nested", "dir"],
    ]);
    const exists = (spec: string) => files.get(spec) ?? null;

    it("names the file the way nodenext resolves it", () => {
        const text = `export * from "./client";\nexport type { A } from './nested';\nimport("./client");`;
        expect(withExtensions(text, exists)).toBe(
            `export * from "./client.js";\nexport type { A } from './nested/index.js';\nimport("./client.js");`,
        );
    });

    it("leaves packages, existing extensions and unknown paths alone", () => {
        const text = `import z from "zod";\nexport * from "./client.js";\nexport * from "./missing";`;
        expect(withExtensions(text, exists)).toBe(text);
    });
});

describe("TARGETS", () => {
    it("packs the three libraries and the two executables, dependencies first", () => {
        expect(TARGETS.map((t) => t.dir)).toEqual([
            "packages/contracts",
            "packages/sdk",
            "packages/client-core",
            "apps/cli",
            "apps/mcp",
        ]);
        expect(TARGETS.filter((t) => t.bin).map((t) => t.bin)).toEqual([
            { name: "launchpad", file: "cli.mjs" },
            { name: "launchpad-mcp", file: "mcp.mjs" },
        ]);
    });

    it("builds under Bun whatever Node is on the PATH (the vite config is TypeScript)", () => {
        const source = readFileSync(path.join(import.meta.dirname, "package-clients.ts"), "utf8");
        expect(source).toContain('["bun", "--bun", "run", "build"]');
    });
});

describe("packedDependencies", () => {
    const packed = (name: string) =>
        name === "@launchpad-kit/sdk" ? { name, version: "0.1.0" } : undefined;

    it("turns a workspace package into a caret range and takes the rest from the catalog", () => {
        expect(
            packedDependencies(
                {
                    name: "@launchpad-kit/cli",
                    version: "0.1.0",
                    dependencies: {
                        "@launchpad-kit/sdk": "workspace:^",
                        zod: "catalog:",
                        tar: "^7.0.0",
                    },
                },
                packed,
                { zod: "^4.0.0" },
            ),
        ).toEqual({ "@launchpad-kit/sdk": "^0.1.0", zod: "^4.0.0", tar: "^7.0.0" });
    });

    it("refuses a workspace package that is not packed and a name missing from the catalog", () => {
        const manifest = (dependencies: Record<string, string>) => ({
            name: "x",
            version: "0.1.0",
            dependencies,
        });
        expect(() =>
            packedDependencies(manifest({ "@launchpad-kit/other": "workspace:^" }), packed, {}),
        ).toThrow("not packed");
        expect(() => packedDependencies(manifest({ zod: "catalog:" }), packed, {})).toThrow(
            "catalog",
        );
    });
});

describe("stageExecutable", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const temp = () => {
        const dir = mkdtempSync(path.join(tmpdir(), "stage-exe-"));
        dirs.push(dir);
        return dir;
    };

    it("copies the file byte for byte, executable, with the node shebang on line 1", () => {
        const dir = temp();
        const from = path.join(dir, "cli.mjs");
        writeFileSync(from, `${SHEBANG}\nconsole.log("x");\n`, { mode: 0o644 });
        const to = path.join(dir, "stage", "cli.mjs");
        stageExecutable(from, to);
        expect(readFileSync(to, "utf8")).toBe(readFileSync(from, "utf8"));
        expect(statSync(to).mode & 0o777).toBe(0o755);
    });

    it("refuses a missing or another shebang", () => {
        const dir = temp();
        for (const first of ["", "#!/usr/bin/env bun\n", "\n#!/usr/bin/env node\n"]) {
            const from = path.join(dir, "x.mjs");
            writeFileSync(from, `${first}console.log(1);\n`);
            expect(
                () => stageExecutable(from, path.join(dir, "out.mjs")),
                JSON.stringify(first),
            ).toThrow("must start with");
        }
    });
});

describe("checkBareImports", () => {
    const manifest = {
        name: "@x/app",
        dependencies: { "@x/lib": "^1.0.0", zod: "^4.0.0" },
        peerDependencies: { commander: "^15.0.0" },
    };

    it("allows optional dependencies as well as peers", () => {
        const optional = { name: "@x/app", optionalDependencies: { fsevents: "^2.0.0" } };
        expect(checkBareImports(optional, { "app.mjs": 'import "fsevents";' })).toEqual([]);
        expect(checkBareImports(optional, { "app.mjs": 'import "other";' })).toHaveLength(1);
    });

    it("accepts Node, relative, declared and subpath imports", () => {
        const text = [
            'import { a } from "node:fs";',
            'import path from "path";',
            'import b from "fs/promises";',
            'import { c } from "@x/lib";',
            'import { d } from "zod/v4";',
            'export * from "./local.mjs";',
            'const e = await import("commander");',
        ].join("\n");
        expect(checkBareImports(manifest, { "app.mjs": text })).toEqual([]);
    });

    it("reports an undeclared package in every import form", () => {
        const text = [
            'import "left-pad";',
            'import x from "tar";',
            'export { y } from "@y/other/sub";',
            'const z = await import("picomatch");',
            'import w = require("micro");',
        ].join("\n");
        const problems = checkBareImports(manifest, { "app.mjs": text });
        expect(problems).toHaveLength(5);
        expect(problems.join("\n")).toContain('"@y/other/sub"');
    });

    it("fails closed on a file that does not parse and ignores non-module files", () => {
        expect(checkBareImports(manifest, { "app.mjs": "import {{{" }).length).toBeGreaterThan(0);
        expect(checkBareImports(manifest, { "README.md": 'import "left-pad"' })).toEqual([]);
    });
});

describe("resolveNode", () => {
    it("defaults to node on the PATH and keeps bare names as lookups", () => {
        expect(resolveNode(undefined, "/work")).toBe("node");
        expect(resolveNode("", "/work")).toBe("node");
        expect(resolveNode("node22", "/work")).toBe("node22");
    });

    it("makes a path absolute against the caller's directory", () => {
        expect(resolveNode("./node-tools/node", "/work")).toBe("/work/node-tools/node");
        expect(resolveNode("../bin/node", "/work/sub")).toBe("/work/bin/node");
        expect(resolveNode("/opt/node/bin/node", "/work")).toBe("/opt/node/bin/node");
    });
});

describe("the node link for the child PATH", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    const temp = () => {
        const dir = mkdtempSync(path.join(tmpdir(), "node-shim-"));
        dirs.push(dir);
        return dir;
    };

    it("finds an executable by path or by bare name, and reports a missing one", () => {
        const dir = temp();
        const fake = path.join(dir, "node22");
        symlinkSync(process.execPath, fake);
        expect(findNode(fake, "")).toBe(fake);
        expect(findNode("node22", dir)).toBe(fake);
        expect(findNode("node22", "")).toBeNull();
        expect(findNode(path.join(dir, "missing"), dir)).toBeNull();
    });

    it("makes `node` resolve to an executable that is named something else", () => {
        const dir = temp();
        const fake = path.join(dir, "node22");
        symlinkSync(process.execPath, fake);
        const shim = nodeShim(fake, path.join(dir, "shim"));
        const out = Bun.spawnSync(["/bin/sh", "-c", "command -v node && node --version"], {
            env: { PATH: shim },
        });
        expect(out.stdout.toString()).toStartWith(`${path.join(shim, "node")}\n`);
    });
});

describe("checkBin", () => {
    const files = ["package.json", "cli.mjs"];

    it("accepts an object that points at a packed file, and a library without bin", () => {
        expect(checkBin({ bin: { launchpad: "./cli.mjs" } }, files)).toEqual([]);
        expect(checkBin({ main: "./index.mjs", exports: {} }, files)).toEqual([]);
    });

    it("refuses a string, a missing file and an importable executable", () => {
        expect(checkBin({ bin: "./cli.mjs" }, files)).toHaveLength(1);
        expect(checkBin({ bin: { launchpad: "./gone.mjs" } }, files)).toHaveLength(1);
        expect(
            checkBin(
                { bin: { launchpad: "./cli.mjs" }, main: "x", types: "y", exports: {} },
                files,
            ),
        ).toHaveLength(3);
    });
});

describe("checkManifest fields that must not be packed", () => {
    it("refuses bundled dependencies, publishConfig, scripts, workspaces, overrides and optional protocol ranges", () => {
        const problems = checkManifest(
            {
                name: "@x/y",
                version: "1.0.0",
                license: "Apache-2.0",
                ...repositoryFields("packages/y"),
                bundledDependencies: ["a"],
                bundleDependencies: ["a"],
                publishConfig: { access: "public" },
                scripts: {},
                workspaces: [],
                overrides: {},
                optionalDependencies: { a: "workspace:^" },
            },
            "packages/y",
        );
        expect(problems).toHaveLength(7);
    });
});

describe("checkClosure", () => {
    const pkg = (name: string, dependencies: Record<string, string> = {}, version = "0.1.0") => ({
        name,
        version,
        dependencies,
    });
    const good = () => [
        pkg("@launchpad-kit/sdk", { zod: "^4.0.0" }),
        pkg("@launchpad-kit/cli", { "@launchpad-kit/sdk": "^0.1.0", zod: "^4.0.0" }),
    ];

    it("accepts one version, caret internal ranges and one range per third-party package", () => {
        expect(checkClosure(good())).toEqual([]);
    });

    it("refuses another version, an exact or protocol range and a package that is not published", () => {
        const [sdk, cli] = good();
        expect(checkClosure([pkg("@launchpad-kit/sdk", {}, "0.1.1"), cli!])).not.toEqual([]);
        for (const spec of ["0.1.0", "~0.1.0", "*", "workspace:^", "^0.2.0"]) {
            const problems = checkClosure([
                sdk!,
                pkg("@launchpad-kit/cli", { "@launchpad-kit/sdk": spec }),
            ]);
            expect(problems, spec).toHaveLength(1);
        }
        expect(
            checkClosure([sdk!, pkg("@launchpad-kit/cli", { "@launchpad-kit/other": "^0.1.0" })]),
        ).toEqual([
            "@launchpad-kit/cli: dependencies.@launchpad-kit/other is not a published package",
        ]);
    });

    it("checks every dependency section", () => {
        const [sdk] = good();
        const cli = {
            ...pkg("@launchpad-kit/cli"),
            peerDependencies: { "@launchpad-kit/sdk": "0.1.0" },
        };
        expect(checkClosure([sdk!, cli])).toHaveLength(1);
    });

    it("refuses a third-party package at two ranges", () => {
        const [sdk] = good();
        const problems = checkClosure([sdk!, pkg("@launchpad-kit/cli", { zod: "^4.1.0" })]);
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain("zod has different ranges");
    });
});

describe("checkUnbundled", () => {
    const cli = { name: "@launchpad-kit/cli", dependencies: { "@launchpad-kit/sdk": "^0.1.0" } };

    it("accepts an executable under its budget that imports what it declares", () => {
        expect(
            checkUnbundled(cli, { "cli.mjs": 'import "@launchpad-kit/sdk";\nconsole.log(1);' }),
        ).toEqual([]);
    });

    it("checks declarations as well as modules", () => {
        const lib = { name: "@launchpad-kit/sdk", dependencies: { zod: "^4.0.0" } };
        expect(
            checkUnbundled(lib, {
                "index.d.ts": 'import { z } from "zod";\nexport type A = z.ZodType;',
            }),
        ).toEqual([]);
        expect(
            checkUnbundled(lib, { "index.d.ts": 'import type { X } from "undeclared";' }),
        ).toHaveLength(1);
        expect(
            checkUnbundled(lib, { "index.d.ts": '/// <reference types="undeclared" />' }),
        ).toHaveLength(1);
    });

    it("fails an executable over its size budget", () => {
        const big = `import "@launchpad-kit/sdk";\n${"x".repeat(SIZE_BUDGETS["@launchpad-kit/cli"]!)}`;
        expect(checkUnbundled(cli, { "cli.mjs": big }).join()).toContain("over the budget");
    });

    it("fails a file that holds the code of another package", () => {
        for (const [name, marker] of Object.entries(MARKERS)) {
            const problems = checkUnbundled(cli, { "cli.mjs": `// ${marker}` });
            expect(problems.join(), name).toContain(`code of ${name}`);
        }
        const own = { name: "@launchpad-kit/sdk" };
        expect(checkUnbundled(own, { "index.mjs": `// ${MARKERS["@launchpad-kit/sdk"]}` })).toEqual(
            [],
        );
    });
});

// The directory a package is installed in, found the way Node finds it from `from`.
function installed(name: string, from: string): string {
    for (let dir = from; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, "node_modules", name);
        if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) return candidate;
        if (dir === path.dirname(dir)) throw new Error(`${name} is not installed above ${from}`);
    }
}

function sourcesIn(dir: string): string {
    let text = "";
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && entry.name !== "__tests__")
                text += sourcesIn(file);
        } else if (/\.[cm]?[jt]s$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
            text += readFileSync(file, "utf8");
        }
    }
    return text;
}

describe("markers", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const where: Record<string, string> = {
        "@launchpad-kit/client-core": "packages/client-core",
        "@launchpad-kit/contracts": "packages/contracts",
        "@launchpad-kit/sdk": "packages/sdk",
    };
    const users: Record<string, string> = {
        "@elastic/micro-jq": "apps/cli",
        "@modelcontextprotocol/sdk": "apps/mcp",
        commander: "apps/cli",
        picomatch: "packages/client-core",
        tar: "packages/client-core",
        zod: "apps/mcp",
    };

    for (const [name, marker] of Object.entries(MARKERS)) {
        it(`${name}: the marker is still in the package`, () => {
            const dir = where[name]
                ? path.join(root, where[name], "src")
                : installed(name, path.join(root, users[name]!));
            expect(sourcesIn(dir)).toContain(marker);
        }, 30_000);
    }

    it("has a marker for every dependency a published package imports", () => {
        for (const target of TARGETS) {
            const manifest = JSON.parse(
                readFileSync(path.join(root, target.dir, "package.json"), "utf8"),
            );
            for (const name of Object.keys(manifest.dependencies)) {
                if (name === "@commander-js/extra-typings") continue;
                expect(MARKERS, `${manifest.name} -> ${name}`).toHaveProperty([name]);
            }
        }
    });
});

describe("budgets", () => {
    it("are the measured size plus 25 %, rounded up to the next kB", () => {
        expect(budgetFor(62_972)).toBe(79_000);
        expect(budgetFor(8_406)).toBe(11_000);
        expect(budgetFor(8_000)).toBe(10_000);
        for (const [name, measured] of Object.entries(MEASURED_SIZES)) {
            const budget = SIZE_BUDGETS[name]!;
            expect(budget, name).toBeGreaterThanOrEqual(measured * 1.25);
            expect(budget, name).toBeLessThan(measured * 1.25 + 1000);
        }
        expect(Object.keys(SIZE_BUDGETS)).toEqual(Object.keys(MEASURED_SIZES));
    });
});

describe("checkLock", () => {
    const bytes = new TextEncoder().encode("tarball");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const expected = [
        { name: "@x/sdk", version: "0.1.0", file: "/w/tarballs/x-sdk-0.1.0.tgz", bytes },
    ];
    const lock = (entry: Record<string, string>) => ({
        packages: { "node_modules/@x/sdk": entry },
    });

    it("accepts the local tarball with its own digest", () => {
        const entry = { version: "0.1.0", resolved: "file:../tarballs/x-sdk-0.1.0.tgz", integrity };
        expect(checkLock(lock(entry), expected)).toEqual([]);
    });

    it("refuses a registry resolution, another digest, another version and a missing entry", () => {
        const good = { version: "0.1.0", resolved: "file:../tarballs/x-sdk-0.1.0.tgz", integrity };
        expect(
            checkLock(
                lock({ ...good, resolved: "https://registry.npmjs.org/@x/sdk/-/sdk-0.1.0.tgz" }),
                expected,
            ),
        ).toHaveLength(1);
        expect(checkLock(lock({ ...good, integrity: "sha512-other" }), expected)).toHaveLength(1);
        expect(checkLock(lock({ ...good, version: "0.1.9" }), expected)).toHaveLength(1);
        expect(checkLock({ packages: {} }, expected)).toEqual(["@x/sdk: not in the lockfile"]);
    });
});

describe("checkLs", () => {
    it("accepts a clean tree and names invalid and missing packages", () => {
        expect(checkLs({ dependencies: { a: { dependencies: { b: {} } } } })).toEqual([]);
        expect(
            checkLs({
                dependencies: { a: { invalid: "x", dependencies: { b: { missing: true } } } },
            }),
        ).toEqual(["consumer > a is invalid", "consumer > a > b is missing"]);
        expect(checkLs({ problems: ["missing: a@1"] })).toEqual(["consumer: missing: a@1"]);
    });
});

describe("installedCopies", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it("finds one copy per name, and a second one nested in another package", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "copies-"));
        dirs.push(dir);
        const make = (...parts: string[]) =>
            mkdirSync(path.join(dir, ...parts), { recursive: true });
        make("@launchpad-kit", "sdk");
        make("@launchpad-kit", "cli");
        make("zod");
        expect(Object.values(installedCopies(dir)).every((found) => found.length === 1)).toBe(true);
        make("zod", "node_modules", "@launchpad-kit", "sdk");
        make("@scope", "pkg", "node_modules", "@launchpad-kit", "cli");
        const copies = installedCopies(dir);
        expect(copies["@launchpad-kit/sdk"]).toHaveLength(2);
        expect(copies["@launchpad-kit/cli"]).toHaveLength(2);
    });
});

describe("findNpm", () => {
    it("prefers the npm beside the selected Node, then the PATH, else null", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "npm-"));
        try {
            const node = path.join(dir, "node");
            expect(findNpm(node, "")).toBeNull();
            writeFileSync(path.join(dir, "npm"), "");
            expect(findNpm(node, "")).toBe(path.join(dir, "npm"));
            expect(findNpm(null, "")).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
