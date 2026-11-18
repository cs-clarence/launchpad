// A rehearsal of a release that publishes nothing: it checks that the versions agree, packs the
// client packages exactly as `test:packages` does, records checksums, and builds (does not push)
// the controller and worker images. The output is a directory a person can inspect.
//
// It holds no credential and needs none: `bun pm pack` writes tarballs and `docker build` loads
// local images; there is no `publish`, `push`, `login`, tag or release call anywhere here. The
// images it builds are removed by exact name before it exits.
//
//   bun tooling/release-dry-run.ts [outDir] [--skip-images]
import { createHash, randomBytes } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
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

// The folder is emptied first, so it is only ever one named for this purpose that really lies
// inside the repository: its nearest existing ancestor is resolved through symlinks, so a link
// out of the checkout cannot redirect the delete.
const LOCK = ".release-dry-run.lock";

export function checkOutput(out: string, repository = root): string | null {
    if (!path.basename(out).includes("release-dry-run"))
        return "its name must contain release-dry-run";
    const lock = path.join(repository, LOCK);
    if (out === lock || out.startsWith(`${lock}${path.sep}`)) return "it is the lock folder";
    const inside = (candidate: string, base: string) => candidate.startsWith(`${base}${path.sep}`);
    if (!inside(out, repository)) return "it must be inside the repository";
    let ancestor = out;
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    if (
        !inside(realpathSync(ancestor), realpathSync(repository)) &&
        realpathSync(ancestor) !== realpathSync(repository)
    ) {
        return "it resolves outside the repository through a symbolic link";
    }
    if (existsSync(out) && !inside(realpathSync(out), realpathSync(repository))) {
        return "it resolves outside the repository through a symbolic link";
    }
    // Where the folder will really be, missing parts included, against the real lock folder:
    // a link to the checkout root must not smuggle the output into the lock.
    const canonical = path.join(realpathSync(ancestor), path.relative(ancestor, out));
    const canonicalLock = path.join(realpathSync(repository), LOCK);
    if (canonical === canonicalLock || canonical.startsWith(`${canonicalLock}${path.sep}`)) {
        return "it resolves inside the lock folder";
    }
    return null;
}

// A fixed, short tag under a run-specific image name: a SemVer version can hold characters and
// a length Docker refuses in a tag. The release version stays in the report.
export const IMAGE_TAG = "dry-run";

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

    const refused = checkOutput(out);
    if (refused) throw new Error(`Refusing to empty ${out}: ${refused}.`);
    // One run at a time, whatever folders they use: a second would empty the first's folder, or
    // one holding it. The lock sits at the checkout root, outside every selectable folder.
    const lock = path.join(root, LOCK);
    try {
        mkdirSync(lock);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new Error(`Another dry run holds ${lock}; remove it only if none is running.`);
    }
    try {
        await rehearse(out, version, skipImages);
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}

async function rehearse(out: string, version: string, skipImages: boolean) {
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
        // Random per invocation: a PID repeats across containers sharing one Docker daemon.
        const run = randomBytes(4).toString("hex");
        const built: string[] = [];
        let failure: unknown;
        try {
            for (const name of ["controller", "worker"]) {
                const tag = `launchpad-release-dry-run-${run}/${name}:${IMAGE_TAG}`;
                built.push(tag);
                await exec([
                    "docker",
                    "build",
                    "-q",
                    "--build-arg",
                    `LAUNCHPAD_VERSION=${version}`,
                    "-f",
                    `containers/${name}/Dockerfile`,
                    "-t",
                    tag,
                    ".",
                ]);
                const id = await exec(["docker", "image", "inspect", "--format", "{{.Id}}", tag]);
                images.push(`${name} ${id}`);
            }
        } catch (error) {
            failure = error;
        }
        // Removed by exact name; an image that never got built is not a leftover.
        const remaining = built.filter((tag) => {
            const removed = Bun.spawnSync(["docker", "image", "rm", tag], {
                stdout: "ignore",
                stderr: "ignore",
            });
            if (removed.exitCode === 0) return false;
            const present = Bun.spawnSync(["docker", "image", "inspect", tag], {
                stdout: "ignore",
                stderr: "pipe",
            });
            return !(present.exitCode !== 0 && present.stderr.toString().includes("No such"));
        });
        if (remaining.length > 0) {
            const leftover = new Error(
                `Images could not be removed; remove them by exact name: ${remaining.join(", ")}`,
            );
            throw failure ? new AggregateError([failure, leftover], "Dry run failed.") : leftover;
        }
        if (failure) throw failure;
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
