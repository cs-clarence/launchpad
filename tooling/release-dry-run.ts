// A rehearsal of a release that publishes nothing: it checks that the versions agree, packs the
// client packages exactly as `test:packages` does, records checksums, and builds (does not push)
// the controller and worker images. The output is a directory a person can inspect.
//
// It holds no credential and needs none: `bun pm pack` writes tarballs and `docker build` loads
// local images; there is no `publish`, `push`, `login`, tag or release call anywhere here. The
// images it builds are removed by exact name before it exits.
//
//   bun tooling/release-dry-run.ts [outDir] [--skip-images]
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build, checkListing, checkManifest, pack, stage, TARGETS } from "./package-clients";
import { checkVersions, sharedWorkspaces } from "./versions";

const root = path.resolve(import.meta.dirname, "..");

export function sha256(file: string): string {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// `sha256sum -c` format: digest, two spaces, file name.
export function checksumLines(files: { name: string; digest: string }[]): string {
    return (
        files
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((f) => `${f.digest}  ${f.name}`)
            .join("\n") + "\n"
    );
}

async function exec(command: string[], cwd = root) {
    const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}):\n${out}\n${err}`);
    return out.trim();
}

async function main() {
    const args = process.argv.slice(2);
    const skipImages = args.includes("--skip-images");
    const out = path.resolve(
        args.find((a) => !a.startsWith("--")) ?? path.join(root, ".release-dry-run"),
    );
    const problems = checkVersions(root);
    if (problems.length > 0) throw new Error(`Versions disagree:\n${problems.join("\n")}`);
    const version = sharedWorkspaces(root)[0]!.version;

    // The folder is emptied first: only ever one named for this purpose, inside the repository.
    if (!path.basename(out).includes("release-dry-run") || !out.startsWith(`${root}${path.sep}`)) {
        throw new Error(
            `Refusing to empty ${out}: use a folder named *release-dry-run* inside the repository.`,
        );
    }
    rmSync(out, { recursive: true, force: true });
    const tarballs = path.join(out, "packages");
    mkdirSync(tarballs, { recursive: true });

    const checked: string[] = [];
    for (const target of TARGETS) {
        await build(target);
        const staged = await stage(target, out);
        const tarball = await pack(staged, tarballs);
        const manifest = JSON.parse(readFileSync(path.join(staged, "package.json"), "utf8"));
        const listing = (await exec(["tar", "tzf", tarball]))
            .split("\n")
            .filter(Boolean)
            .map((line) => line.replace(/^package\//, ""));
        const found = [
            ...checkListing(listing),
            ...checkManifest(manifest),
            ...(manifest.version === version
                ? []
                : [`version ${manifest.version} is not the release version ${version}`]),
        ];
        if (found.length > 0) throw new Error(`${manifest.name}:\n${found.join("\n")}`);
        checked.push(`${manifest.name}@${manifest.version}`);
    }
    // The staging directories are scratch; only tarballs and checksums are the result.
    rmSync(path.join(out, "stage"), { recursive: true, force: true });
    writeFileSync(
        path.join(tarballs, "SHA256SUMS"),
        checksumLines(
            readdirSync(tarballs)
                .filter((name) => name.endsWith(".tgz"))
                .map((name) => ({ name, digest: sha256(path.join(tarballs, name)) })),
        ),
    );

    const images: string[] = [];
    if (!skipImages) {
        const run = process.pid.toString(36);
        const built: string[] = [];
        try {
            for (const name of ["controller", "worker"]) {
                const tag = `launchpad-release-dry-run-${run}/${name}:${version}`;
                built.push(tag);
                await exec([
                    "docker",
                    "build",
                    "-q",
                    "-f",
                    `containers/${name}/Dockerfile`,
                    "-t",
                    tag,
                    ".",
                ]);
                const id = await exec(["docker", "image", "inspect", "--format", "{{.Id}}", tag]);
                images.push(`${name} ${id}`);
            }
        } finally {
            for (const tag of built) {
                Bun.spawnSync(["docker", "image", "rm", tag], {
                    stdout: "ignore",
                    stderr: "ignore",
                });
            }
        }
    }

    const commit = await exec(["git", "rev-parse", "HEAD"]).catch(() => "unknown");
    writeFileSync(
        path.join(out, "RELEASE-DRY-RUN.txt"),
        [
            `Release dry run for version ${version} at commit ${commit}.`,
            "NOTHING WAS PUBLISHED, PUSHED, TAGGED OR RELEASED.",
            "",
            "Packed (see packages/SHA256SUMS):",
            ...checked.map((c) => `  ${c}`),
            "",
            skipImages ? "Images: skipped." : "Images built locally and removed again:",
            ...images.map((i) => `  ${i}`),
            "",
        ].join("\n"),
    );
    console.log(`Dry run complete for ${version}: ${out}`);
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
