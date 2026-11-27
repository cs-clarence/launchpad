// Docker, state-directory and teardown logic shared by the tools that own a Compose project in a
// git-ignored state directory: tooling/local-deploy.ts and tooling/dev-infra.ts. Everything that
// differs between them (state directory, project prefix, images, services, files) is in a
// `Profile`; the deletion code is the same for both and is the code that needs the most review.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    rmdir,
    unlink,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { interpolate, loadRaw } from "./compose-production";
import type { Run, RunResult } from "./local-seed";

export class DeployError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeployError";
    }
}

export const DOCKER_HOST = "unix:///var/run/docker.sock";
export const DOCKER_SOCKET = "/var/run/docker.sock";
const SAFE_PATH = /^[A-Za-z0-9_@.+/-]+$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// Copied from tooling/experiments/acceptance/harness.ts (nothing imports from the experiments);
// a test ties them to the real generators.
export const NAME = {
    app: /^lp-[a-z0-9]{10}$/,
    tag: /^launchpad\/site:[0-9a-f]{32}$/,
};

export const imageTagFor = (deploymentId: string) =>
    `launchpad/site:${deploymentId.replaceAll("-", "")}`;

export interface Secrets {
    postgresPassword: string;
    authSecret: string;
    instanceId: string;
}

export function generateSecrets(): Secrets {
    return {
        postgresPassword: randomBytes(24).toString("hex"),
        authSecret: randomBytes(32).toString("hex"),
        instanceId: randomUUID(),
    };
}

export const renderEnv = (env: Record<string, string>) =>
    Object.entries(env)
        .map(([k, v]) => `${k}=${v}\n`)
        .join("");

export function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (m) env[m[1]!] = m[2]!;
    }
    return env;
}

export function parseSocketGid(statOutput: string): number {
    const gid = Number(statOutput.trim());
    if (!Number.isSafeInteger(gid) || gid < 0) {
        throw new DeployError("Could not read the group of /var/run/docker.sock.");
    }
    return gid;
}

export interface Site {
    id: string | null;
    app: string;
    tag: string | null;
}

export class InventoryError extends Error {}

// Rows are validated every time they are read; the image tag is derived from the id, never read.
export function siteFromRow(id: unknown, app: unknown): Site {
    if (
        typeof id !== "string" ||
        typeof app !== "string" ||
        !UUID.test(id) ||
        !NAME.app.test(app)
    ) {
        throw new InventoryError("Unexpected name in a deployment record.");
    }
    return { id, app, tag: imageTagFor(id) };
}

export function parseInventory(text: string, project?: string): Site[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new InventoryError("inventory.json is not valid JSON.");
    }
    const owner = (parsed as { project?: unknown } | null)?.project;
    if (project !== undefined && owner !== project) {
        throw new InventoryError("inventory.json belongs to another project.");
    }
    const rows = (parsed as { sites?: unknown } | null)?.sites;
    if (!Array.isArray(rows)) throw new InventoryError("inventory.json has an unexpected shape.");
    return rows.map((row) => {
        if (row?.id === null && typeof row?.app === "string" && NAME.app.test(row.app)) {
            return { id: null, app: row.app, tag: null };
        }
        return siteFromRow(row?.id, row?.app);
    });
}

export function mergeSites(...lists: Site[][]): Site[] {
    const byApp = new Map<string, Site>();
    for (const site of lists.flat()) {
        const old = byApp.get(site.app);
        if (!old || (old.id === null && site.id !== null)) byApp.set(site.app, site);
    }
    return [...byApp.values()].sort((a, b) => a.app.localeCompare(b.app));
}

export const renderInventory = (project: string, sites: Site[]) =>
    JSON.stringify({ project, sites: sites.map(({ id, app }) => ({ id, app })) }, null, 2);

export function parseDatabaseRows(out: string): Site[] {
    return (out ? out.split("\n") : [])
        .filter((line) => line.trim() !== "")
        .map((line) => {
            const [id, app, , extra] = line.split(" ");
            if (extra !== undefined) throw new InventoryError("Unexpected deployment row.");
            return siteFromRow(id, app);
        });
}

export interface State {
    project: string;
    repo: string;
    version: string;
    // True when `up` made the profile current because the config had none.
    profileSetByUp?: boolean;
}

export function parseState(text: string): State | null {
    try {
        const s = JSON.parse(text) as Partial<State>;
        if (
            typeof s.project === "string" &&
            typeof s.repo === "string" &&
            typeof s.version === "string"
        ) {
            return {
                project: s.project,
                repo: s.repo,
                version: s.version,
                ...(s.profileSetByUp === true ? { profileSetByUp: true } : {}),
            };
        }
    } catch {
        // A corrupt record is the same as none.
    }
    return null;
}

export function summarizeDockerProblems(input: {
    version: RunResult;
    compose: RunResult;
    buildx: RunResult;
    info: RunResult;
    env: Record<string, string | undefined>;
}): string | null {
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
        if (input.env[name]) {
            return `${name} is set; this tool only works with the local engine at ${DOCKER_HOST}. Unset it.`;
        }
    }
    if (input.version.code !== 0) {
        return "The Docker daemon did not answer (is Docker installed and running, and may you use it?).";
    }
    if (input.compose.code !== 0)
        return "Docker Compose v2 is required (`docker compose version`).";
    const builder = input.buildx.output;
    if (
        input.buildx.code !== 0 ||
        !/^Driver:\s+docker$/m.test(builder) ||
        !/^Status:\s+running$/m.test(builder)
    ) {
        return (
            "The default local Docker builder is required (`docker buildx inspect default`). See " +
            "docs/plans/production-fresh-host-recovery.md#repeat-the-rehearsal for combinations that were observed to work."
        );
    }
    if (
        /rootless/i.test(input.info.output) ||
        !/OSType: linux|Operating System:/i.test(input.info.output)
    ) {
        return "Rootless Docker and non-Linux engines are not supported.";
    }
    return null;
}

// ---- port probing ------------------------------------------------------------------------

export async function probePort(port: number): Promise<boolean> {
    return await new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

export interface FsStat {
    isDirectory: boolean;
    isSymlink: boolean;
    isFile: boolean;
    uid: number;
    mode: number;
    size: number;
}

export interface Fs {
    stat(file: string): Promise<FsStat | null>;
    realpath(file: string): Promise<string>;
    mkdir(dir: string, mode: number): Promise<void>;
    readdir(dir: string): Promise<string[]>;
    readFile(file: string): Promise<string | null>;
    writeFile(file: string, data: string, mode: number, exclusive?: boolean): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(file: string): Promise<void>;
    rmdir(dir: string): Promise<void>;
    // Removes a directory tree as far as this user may; throws if something stays.
    rmTree(dir: string): Promise<void>;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export const realFs: Fs = {
    async stat(file) {
        try {
            const s = await lstat(file);
            return {
                isDirectory: s.isDirectory(),
                isSymlink: s.isSymbolicLink(),
                isFile: s.isFile(),
                uid: s.uid,
                mode: s.mode & 0o7777,
                size: s.size,
            };
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    },
    realpath: (file) => realpath(file),
    async mkdir(dir, mode) {
        await mkdir(dir, { mode });
        await chmod(dir, mode);
    },
    readdir: (dir) => readdir(dir),
    async readFile(file) {
        try {
            return await readFile(file, "utf8");
        } catch (error) {
            if (missing(error)) return null;
            throw error;
        }
    },
    writeFile: (file, data, mode, exclusive = false) =>
        writeFile(file, data, { mode, flag: exclusive ? "wx" : "w" }),
    rename: (from, to) => rename(from, to),
    async unlink(file) {
        try {
            await unlink(file);
        } catch (error) {
            if (!missing(error)) throw error;
        }
    },
    async rmdir(dir) {
        try {
            await rmdir(dir);
        } catch (error) {
            if (!missing(error)) throw error;
        }
    },
    rmTree: (dir) => rm(dir, { recursive: true, force: true }),
};

export interface BaseDeps {
    run: Run;
    fetch: typeof fetch;
    fs: Fs;
    env: Record<string, string | undefined>;
    log: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    probePort: (port: number) => Promise<boolean>;
    uid: number;
    repo: string;
    version: string;
    signal?: AbortSignal;
}

// Children get a minimal environment on purpose: Compose lets the process environment override
// the env file, so a stray POSTGRES_PASSWORD in the shell must not leak in. Output is returned
// to be matched, never printed.
export async function spawnExec(
    args: string[],
    input?: string,
    timeoutMs = 20 * 60_000,
): Promise<RunResult> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(args, {
            stdin: input === undefined ? "ignore" : new Blob([input]),
            stdout: "pipe",
            stderr: "pipe",
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
        });
    } catch {
        return { code: 127, output: `${args[0]}: not found` };
    }
    const deadline = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout as ReadableStream).text(),
            new Response(proc.stderr as ReadableStream).text(),
            proc.exited,
        ]);
        return { code, output: `${out}\n${err}`, stdout: out };
    } finally {
        clearTimeout(deadline);
    }
}

// ---- Docker commands ---------------------------------------------------------------------

export const LABEL_PROJECT = "com.docker.compose.project";
export const LABEL_SERVICE = "com.docker.compose.service";
export const LABEL_ONEOFF = "com.docker.compose.oneoff";
export const LABEL_APP = "com.dokku.app-name";
// Templates are fixed strings so every Docker query has one shape.
export const PS_FORMAT = `{{.ID}} {{.State}} {{.Label "${LABEL_SERVICE}"}}`;
export const LABEL_TEMPLATE = (key: string) => `{{index .Config.Labels "${key}"}}`;
export const NETWORK_LABEL_TEMPLATE = `{{index .Labels "${LABEL_PROJECT}"}}`;
export const NETWORK_MEMBERS_TEMPLATE = '{{range .Containers}}{{.Name}}{{"\\n"}}{{end}}';
export const IMAGE_FORMAT = "{{.Repository}} {{.Tag}} {{.ID}}";
export const STATE_FORMAT = "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}";

// Everything that differs between the tools that share this module.
export interface Profile {
    stateDir: string;
    version: string;
    projectPrefix: string;
    projectPattern: RegExp;
    // Children of the state directory that hold secrets or root-owned data; removed by name.
    fixedChildren: readonly string[];
    // Files of the state directory removed last, after the record check.
    stateFiles: readonly string[];
    // Files that may sit in a directory that has no state.json (leftovers of an interrupted run).
    cleanExtras: ReadonlySet<string>;
    // Exact image tags this project builds.
    imageTags(project: string): string[];
    // When set, an image is removed only if it carries this label with the project as its value.
    imageLabel?: string;
    // Compose services whose health `serviceHealth` can report.
    services: readonly string[];
    // Services stopped before sites are removed.
    writers: readonly string[];
    // Arguments after `--env-file <compose.env>` that select the Compose files.
    composeFiles(layout: Layout): string[];
    // The word the messages use for the command that removes everything.
    removeCommand: string;
    portAdvice(persisted: boolean): string;
}

export interface Ctx {
    d: BaseDeps;
    layout: Layout;
    project: string;
    profile: Profile;
}

export const appsNetwork = (project: string) => `${project}-apps`;

export function projectNameFor(repoPath: string, prefix: string): string {
    return `${prefix}${createHash("sha256").update(repoPath).digest("hex").slice(0, 8)}`;
}

export function checkProject(profile: Profile, name: string): string {
    if (!profile.projectPattern.test(name)) {
        throw new DeployError(
            `--project must match ${profile.projectPattern.source}, so that its image tags cannot be your own.`,
        );
    }
    return name;
}

export interface Layout {
    repo: string;
    dir: string;
    file: (name: string) => string;
}

export function layoutFor(repo: string, stateDir: string): Layout {
    if (!path.isAbsolute(repo) || !SAFE_PATH.test(repo)) {
        throw new DeployError(
            `${repo} may only contain letters, digits and _ @ . + / - (Compose reads these paths from an env file).`,
        );
    }
    const dir = path.join(repo, stateDir);
    return { repo, dir, file: (name) => path.join(dir, name) };
}

export const docker = (c: { d: BaseDeps }, args: string[], input?: string) =>
    c.d.run(["docker", "--host", DOCKER_HOST, ...args], input);

export function composePrefix(c: Pick<Ctx, "layout" | "project" | "profile">): string[] {
    return [
        "docker",
        "--host",
        DOCKER_HOST,
        "compose",
        "-p",
        c.project,
        "--env-file",
        c.layout.file("compose.env"),
        ...c.profile.composeFiles(c.layout),
    ];
}

// The command a person can paste: the same arguments the tool uses, without the engine flag.
export function composeHint(c: Pick<Ctx, "layout" | "project" | "profile">, args: string): string {
    const prefix = composePrefix(c);
    const shown = [...prefix.slice(0, 1), ...prefix.slice(3)];
    return `${shown.join(" ")} ${args}`.trimEnd();
}

export const compose = (c: Ctx, args: string[], input?: string) =>
    c.d.run([...composePrefix(c), ...args], input);

export function must(result: RunResult, what: string, hint = ""): RunResult {
    if (result.code !== 0) {
        throw new DeployError(`${what} failed (exit ${result.code}).${hint ? ` ${hint}` : ""}`);
    }
    return result;
}

export const outOf = (r: RunResult) => r.stdout ?? r.output;

export const lines = (text: string) =>
    text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

export interface Labeled {
    id: string;
    state: string;
    service: string;
}

export async function labeledContainers(c: Ctx, extra: string[] = []): Promise<Labeled[]> {
    const result = must(
        await docker(c, [
            "ps",
            "-a",
            "--no-trunc",
            "--filter",
            `label=${LABEL_PROJECT}=${c.project}`,
            ...extra,
            "--format",
            PS_FORMAT,
        ]),
        "Listing the project's containers",
    );
    return lines(outOf(result)).map((line) => {
        const [id = "", state = "", service = ""] = line.split(" ");
        if (!/^[0-9a-f]{64}$/.test(id)) throw new DeployError("Unexpected container listing.");
        return { id, state, service };
    });
}

export async function inspectLabel(c: Ctx, id: string, key: string): Promise<string> {
    const result = await docker(c, ["inspect", "-f", LABEL_TEMPLATE(key), id]);
    return result.code === 0 ? outOf(result).trim() : "";
}

// A container is touched only after its Compose project label is confirmed by inspect.
export async function confirmed(c: Ctx, containers: Labeled[]): Promise<Labeled[]> {
    for (const container of containers) {
        if ((await inspectLabel(c, container.id, LABEL_PROJECT)) !== c.project) {
            throw new DeployError(
                `Container ${container.id.slice(0, 12)} does not carry the project label ${c.project}; refusing to touch it.`,
            );
        }
    }
    return containers;
}

async function labeledNames(c: Ctx, kind: "network" | "volume"): Promise<string[]> {
    const result = must(
        await docker(c, [
            kind,
            "ls",
            "--filter",
            `label=${LABEL_PROJECT}=${c.project}`,
            "--format",
            "{{.Name}}",
        ]),
        `Listing the project's ${kind}s`,
    );
    return lines(outOf(result));
}

export async function projectResources(c: Ctx) {
    return {
        containers: await labeledContainers(c),
        networks: await labeledNames(c, "network"),
        volumes: await labeledNames(c, "volume"),
    };
}

export async function networkOwner(c: Ctx, name: string): Promise<"absent" | "ours" | "foreign"> {
    const result = await docker(c, ["network", "inspect", "-f", NETWORK_LABEL_TEMPLATE, name]);
    if (result.code !== 0) return "absent";
    return outOf(result).trim() === c.project ? "ours" : "foreign";
}

export async function imageExists(c: Ctx, name: string): Promise<boolean> {
    return (await docker(c, ["image", "inspect", "-f", "{{.Id}}", name])).code === 0;
}

const IMAGE_ROW = /^([a-z0-9][a-z0-9._/-]*) ([A-Za-z0-9_.-]+|<none>) ([0-9a-f]{12,64})$/;

// Every tag of one exact repository (never a prefix): `docker image ls --filter reference=`
// lists them and each row is checked against the repository before use.
async function repositoryImages(c: Ctx, repository: string, tag?: string) {
    const result = must(
        await docker(c, [
            "image",
            "ls",
            "--filter",
            `reference=${tag ? `${repository}:${tag}` : repository}`,
            "--format",
            IMAGE_FORMAT,
        ]),
        "Listing images",
    );
    return lines(outOf(result)).map((line) => {
        const m = IMAGE_ROW.exec(line);
        if (!m || m[1] !== repository || (tag !== undefined && m[2] !== tag)) {
            throw new DeployError(`Unexpected image listing for ${repository}.`);
        }
        return { ref: m[2] === "<none>" ? m[3]! : `${m[1]}:${m[2]}`, id: m[3]! };
    });
}

export function checkSiteName(site: Site): void {
    if (!NAME.app.test(site.app) || (site.tag !== null && !NAME.tag.test(site.tag))) {
        throw new DeployError("Refusing a deployment name that does not match the fixed patterns.");
    }
}

async function removeImages(c: Ctx, images: { ref: string }[]): Promise<void> {
    for (const image of images)
        must(await docker(c, ["image", "rm", image.ref]), "Removing an image");
}

async function siteImages(c: Ctx, site: Site) {
    const images = await repositoryImages(c, `dokku/${site.app}`);
    if (site.tag) {
        const [repository, tag] = site.tag.split(":") as [string, string];
        images.push(...(await repositoryImages(c, repository, tag)));
    }
    return images;
}

async function siteContainers(c: Ctx, site: Site): Promise<string[]> {
    const result = must(
        await docker(c, ["ps", "-aq", "--no-trunc", "--filter", `label=${LABEL_APP}=${site.app}`]),
        "Listing a site's containers",
    );
    const ids = lines(outOf(result));
    for (const id of ids) {
        if (!/^[0-9a-f]{64}$/.test(id)) throw new DeployError("Unexpected container listing.");
        if ((await inspectLabel(c, id, LABEL_APP)) !== site.app) {
            throw new DeployError(`A container for ${site.app} does not carry its app label.`);
        }
    }
    // Another Compose project's container with the same app label is not ours to remove.
    const mine: string[] = [];
    for (const id of ids) {
        const looked = must(
            await docker(c, ["inspect", "-f", LABEL_TEMPLATE(LABEL_PROJECT), id]),
            `Reading the project label of a container of ${site.app}`,
        );
        const owner = outOf(looked).trim();
        // Dokku creates site containers itself, so they carry no Compose project label: an empty
        // label is accepted, another project's label is not.
        if (owner === "" || owner === c.project) mine.push(id);
    }
    return mine;
}

export function aborted(c: Pick<Ctx, "d" | "profile">, tearingDown = false) {
    if (c.d.signal?.aborted) {
        const remove = c.profile.removeCommand;
        throw new DeployError(
            tearingDown
                ? `Interrupted. Nothing further was removed and ${c.profile.stateDir}/ is kept; run ${remove} again to continue.`
                : `Interrupted. Nothing was rolled back: run \`up\` again to continue, or \`${remove}\` to remove it.`,
        );
    }
}

export async function waitFor(
    c: Pick<Ctx, "d" | "profile">,
    label: string,
    budgetMs: number,
    check: () => Promise<boolean>,
): Promise<void> {
    const { d } = c;
    const deadline = d.now() + budgetMs;
    let next = d.now() + 30_000;
    for (;;) {
        aborted(c);
        if (await check()) return;
        if (d.now() >= deadline) throw new DeployError(`Timed out waiting for ${label}.`);
        if (d.now() >= next) {
            d.log(`Still waiting for ${label}...`);
            next = d.now() + 30_000;
        }
        await d.sleep(2000);
    }
}

// "unknown" means the state could not be read; it is never reported as running or exited.
export async function serviceHealth(c: Ctx, service: string): Promise<string> {
    let found: Labeled[];
    try {
        found = await labeledContainers(c, [
            "--filter",
            `label=${LABEL_SERVICE}=${service}`,
            "--filter",
            `label=${LABEL_ONEOFF}=False`,
        ]);
    } catch {
        return "unknown";
    }
    if (found.length === 0) return "absent";
    if (found.length > 1) throw new DeployError(`More than one ${service} container.`);
    const out = await docker(c, ["inspect", "-f", STATE_FORMAT, found[0]!.id]);
    const state = outOf(out).trim();
    if (out.code !== 0 || state === "") return "unknown";
    if (/^(exited|dead|restarting)\b/.test(state)) {
        throw new DeployError(
            `${service} exited or keeps restarting. See: ${composeHint(c, `logs --tail 50 ${service}`)}`,
        );
    }
    return state.trim();
}

export async function waitHealthy(c: Ctx, service: string, budgetMs: number) {
    try {
        await waitFor(c, `${service} to be healthy`, budgetMs, async () => {
            return (await serviceHealth(c, service)) === "running healthy";
        });
    } catch (error) {
        if (error instanceof DeployError && /Timed out/.test(error.message)) {
            throw new DeployError(
                `${error.message} Everything is kept; look at: ${composeHint(c, `logs --tail 50 ${service}`)}`,
            );
        }
        throw error;
    }
}

// Atomic: a kill leaves the old record or the new one, never a torn file.
export async function writeState(c: Ctx, profileSetByUp: boolean): Promise<void> {
    const next = c.layout.file("state.json.next");
    await c.d.fs.writeFile(
        next,
        JSON.stringify({
            project: c.project,
            repo: c.layout.repo,
            version: c.profile.version,
            ...(profileSetByUp ? { profileSetByUp: true } : {}),
        }),
        0o600,
    );
    await c.d.fs.rename(next, c.layout.file("state.json"));
}

export async function readState(
    c: Ctx,
): Promise<{ kind: "none" | "corrupt" | "ok"; state?: State }> {
    const text = await c.d.fs.readFile(c.layout.file("state.json"));
    if (text === null) return { kind: "none" };
    const state = parseState(text);
    return state ? { kind: "ok", state } : { kind: "corrupt" };
}

export function checkRecord(c: Ctx, state: State): void {
    if (
        state.project !== c.project ||
        state.repo !== c.layout.repo ||
        state.version !== c.profile.version
    ) {
        throw new DeployError(
            `${c.layout.file("state.json")} belongs to project ${state.project} (${state.repo}, tool ` +
                `version ${state.version}), not ${c.project} here. Run ${c.profile.removeCommand} from the checkout that created it` +
                (state.project !== c.project ? `, or pass --project ${state.project}` : "") +
                ".",
        );
    }
}

// The one directory every secret and the root helper's mount live in: a real directory we own,
// mode 700, whose physical path is exactly <repo>/<state directory>.
export async function checkDirectory(c: Ctx): Promise<FsStat | null> {
    const stat = await c.d.fs.stat(c.layout.dir);
    if (stat === null) return null;
    if (stat.isSymlink || !stat.isDirectory) {
        throw new DeployError(`${c.layout.dir} must be a real directory, not a link or a file.`);
    }
    if (stat.uid !== c.d.uid) throw new DeployError(`${c.layout.dir} is owned by another user.`);
    if ((stat.mode & 0o777) !== 0o700) {
        throw new DeployError(`${c.layout.dir} must be mode 700; run chmod 700 on it.`);
    }
    if ((await c.d.fs.realpath(c.layout.dir)) !== c.layout.dir) {
        throw new DeployError(`${c.layout.dir} does not resolve to itself; refusing to use it.`);
    }
    return stat;
}

export async function checkDocker(d: BaseDeps): Promise<void> {
    const ctx = { d };
    const [version, composeVersion, buildx, info] = [
        await docker(ctx, ["version", "--format", "{{.Server.Version}}"]),
        await docker(ctx, ["compose", "version"]),
        await docker(ctx, ["buildx", "inspect", "default"]),
        await docker(ctx, ["info"]),
    ];
    const problem = summarizeDockerProblems({
        version,
        compose: composeVersion,
        buildx,
        info,
        env: d.env,
    });
    if (problem) throw new DeployError(problem);
}

export async function freePorts(c: Ctx, ports: object, persisted: boolean): Promise<void> {
    const busy: string[] = [];
    let published: string | null = null;
    for (const [name, port] of Object.entries(ports as Record<string, number>)) {
        if (await c.d.probePort(port)) continue;
        if (persisted) {
            if (published === null) {
                const result = await docker(c, [
                    "ps",
                    "--filter",
                    `label=${LABEL_PROJECT}=${c.project}`,
                    "--format",
                    "{{.Ports}}",
                ]);
                published = outOf(result);
            }
            if (published.includes(`127.0.0.1:${port}->`)) continue;
        }
        busy.push(`${name} port ${port}`);
    }
    if (busy.length > 0) {
        throw new DeployError(
            `${busy.join(", ")} ${busy.length > 1 ? "are" : "is"} in use on 127.0.0.1. ` +
                c.profile.portAdvice(persisted),
        );
    }
}

export async function conflictsWithoutRecord(c: Ctx): Promise<void> {
    const found = await projectResources(c);
    const tags = c.profile.imageTags(c.project);
    const present: string[] = [];
    for (const tag of tags) if (await imageExists(c, tag)) present.push(tag);
    if ((await networkOwner(c, appsNetwork(c.project))) !== "absent") {
        present.push(appsNetwork(c.project));
    }
    const leftovers = [
        ...found.containers.map((x) => `container ${x.id.slice(0, 12)}`),
        ...found.networks.map((x) => `network ${x}`),
        ...found.volumes.map((x) => `volume ${x}`),
        ...present,
    ];
    if (leftovers.length > 0) {
        throw new DeployError(
            `Project ${c.project} already has resources (${leftovers.join(", ")}) but this checkout has no ` +
                `matching ${c.profile.stateDir}/state.json. Run ${c.profile.removeCommand} from the checkout that created them, or pick another ` +
                "--project. Nothing was changed.",
        );
    }
}

export async function checkOwnDirectory(c: Ctx, name: string, mode: number): Promise<void> {
    const stat = await c.d.fs.stat(c.layout.file(name));
    if (!stat || stat.isSymlink || !stat.isDirectory) {
        throw new DeployError(
            `${c.profile.stateDir}/${name} must be a real directory, not a link or a file. Run ${c.profile.removeCommand}, then up again.`,
        );
    }
    if (stat.uid !== c.d.uid || (stat.mode & 0o777) !== mode) {
        throw new DeployError(
            `${c.profile.stateDir}/${name} must be owned by you with mode ${mode.toString(8)}. Run ${c.profile.removeCommand}, then up again.`,
        );
    }
}

export async function ensureDirectory(c: Ctx, name: string, mode: number): Promise<void> {
    const path = c.layout.file(name);
    if ((await c.d.fs.stat(path)) === null) await c.d.fs.mkdir(path, mode);
    await checkOwnDirectory(c, name, mode);
}

export const DB_QUERY = [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-v",
    "VERBOSITY=sqlstate",
    "-U",
    "launchpad",
    "-d",
    "launchpad",
    "-At",
    "-F",
    " ",
    "-c",
    "select id, app_name, desired_state from deployment",
];

export type DbQueryState = "ok" | "no-schema" | "unreachable";

export function classifyDbQuery(result: RunResult): DbQueryState {
    if (result.code === 0) return "ok";
    return /\b42P01\b|relation "deployment" does not exist/.test(result.output)
        ? "no-schema"
        : "unreachable";
}

export async function readInventoryFile(c: Ctx): Promise<Site[]> {
    const text = await c.d.fs.readFile(c.layout.file("inventory.json"));
    return text === null ? [] : parseInventory(text, c.project);
}

export async function writeInventory(c: Ctx, sites: Site[]): Promise<void> {
    const next = c.layout.file("inventory.json.next");
    await c.d.fs.writeFile(next, renderInventory(c.project, sites), 0o600);
    await c.d.fs.rename(next, c.layout.file("inventory.json"));
}

// A copy of the acceptance harness's check: `docker top` shows no build or Dokku command.
export function dokkuIdle(result: RunResult): boolean {
    const [header, ...commands] = outOf(result).split("\n");
    return (
        result.code === 0 &&
        /^PID\s+COMMAND\s+COMMAND$/.test(header ?? "") &&
        commands.length > 0 &&
        !commands.some((line) =>
            /(?:^|[\s/])(?:dokku|docker|sshcommand)(?=\s|$)|sshd:\s+dokku\b/.test(line),
        )
    );
}

export const APP_CONTAINER = /^(lp-[a-z0-9]{10})\.[a-z0-9_-]+\.[0-9]+$/;

function postgresImage(): string {
    const image = interpolate(loadRaw().services.postgres.image, {});
    if (
        typeof image !== "string" ||
        !/^postgres:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(image)
    ) {
        throw new DeployError("Cannot read the pinned PostgreSQL image from docker-compose.yaml.");
    }
    return image;
}

// Deleting inventory.json is safe: it only records sites for a resumed down, which rediscovers
// them from the database, Dokku and the apps network.
function inventoryHint(c: Ctx, error: Error): string {
    return /belongs to another project/.test(error.message)
        ? ` Run status to rewrite it, or delete ${c.profile.stateDir}/inventory.json.`
        : "";
}

export async function discover(
    c: Ctx,
    dokkuId: string | null,
): Promise<{ sites: Site[]; ignored: string[]; databaseReadable: boolean }> {
    const ignored: string[] = [];
    let database: Site[] = [];
    let databaseReadable = false;
    let fromFile: Site[] = [];
    try {
        const query = await compose(c, DB_QUERY);
        if (query.code === 0) {
            database = parseDatabaseRows(outOf(query).trim());
            databaseReadable = true;
        }
        fromFile = await readInventoryFile(c);
    } catch (error) {
        if (error instanceof InventoryError) {
            throw new DeployError(
                `${error.message} Nothing was removed.${inventoryHint(c, error)}`,
            );
        }
        throw error;
    }
    const fromDokku: Site[] = [];
    if (dokkuId) {
        const listed = await docker(c, ["exec", dokkuId, "dokku", "--quiet", "apps:list"]);
        if (listed.code === 0) {
            for (const name of lines(outOf(listed))) {
                if (NAME.app.test(name)) fromDokku.push({ id: null, app: name, tag: null });
                else ignored.push(name);
            }
        }
    }
    const fromNetwork: Site[] = [];
    const network = appsNetwork(c.project);
    if ((await networkOwner(c, network)) === "ours") {
        const members = await docker(c, [
            "network",
            "inspect",
            "-f",
            NETWORK_MEMBERS_TEMPLATE,
            network,
        ]);
        for (const name of lines(outOf(members))) {
            const app = APP_CONTAINER.exec(name)?.[1];
            if (app) fromNetwork.push({ id: null, app, tag: null });
            else if (!name.startsWith(`${c.project}-`)) ignored.push(name);
        }
    }
    return {
        sites: mergeSites(database, fromFile, fromDokku, fromNetwork),
        ignored,
        databaseReadable,
    };
}

export async function stopWriters(c: Ctx): Promise<void> {
    for (const service of c.profile.writers) {
        const found = await confirmed(
            c,
            await labeledContainers(c, ["--filter", `label=${LABEL_SERVICE}=${service}`]),
        );
        for (const container of found) {
            must(
                await docker(c, ["stop", "--time", "30", container.id]),
                `Stopping the ${service}`,
            );
        }
    }
}

export async function waitForDokkuToSettle(c: Ctx, dokkuId: string): Promise<void> {
    try {
        await waitFor(c, "Dokku to finish its running commands", 60_000, async () =>
            dokkuIdle(await docker(c, ["top", dokkuId, "-eo", "pid,comm,args"])),
        );
    } catch (error) {
        if (error instanceof DeployError && /Timed out/.test(error.message)) {
            throw new DeployError(
                "A build or Dokku command is still running in Dokku. Nothing was removed and " +
                    `${c.profile.stateDir}/ is kept; run ${c.profile.removeCommand} again in a minute.`,
            );
        }
        throw error;
    }
}

export async function destroySite(c: Ctx, dokkuId: string | null, site: Site): Promise<void> {
    checkSiteName(site);
    if (dokkuId) {
        const result = await docker(c, [
            "exec",
            dokkuId,
            "dokku",
            "apps:destroy",
            site.app,
            "--force",
        ]);
        if (result.code !== 0) {
            const exists = await docker(c, ["exec", dokkuId, "dokku", "apps:exists", site.app]);
            if (exists.code === 0)
                throw new DeployError(`Could not destroy the Dokku app ${site.app}.`);
        }
    }
    for (const id of await siteContainers(c, site)) {
        must(await docker(c, ["rm", "-f", id]), `Removing a container of ${site.app}`);
    }
    await removeImages(c, await siteImages(c, site));
}

export async function leftovers(c: Ctx, sites: Site[]): Promise<string[]> {
    const left: string[] = [];
    for (const site of sites) {
        if ((await siteContainers(c, site)).length > 0) left.push(`containers of ${site.app}`);
        for (const image of await siteImages(c, site)) left.push(`image ${image.ref}`);
    }
    return left;
}

function manualRemoval(c: Ctx): string[] {
    return c.profile.fixedChildren.map((name) => `sudo rm -rf ${c.layout.file(name)}`);
}

export async function removeStateChildren(c: Ctx): Promise<void> {
    const present: string[] = [];
    for (const name of c.profile.fixedChildren) {
        if (await c.d.fs.stat(c.layout.file(name))) present.push(name);
    }
    if (present.length === 0) return;
    await checkDirectory(c);
    const image = postgresImage();
    let failed = "";
    const have = await docker(c, ["image", "inspect", "-f", "{{.Id}}", image]);
    if (have.code !== 0 && (await docker(c, ["pull", image])).code !== 0) {
        failed = "The pinned PostgreSQL image is not available and could not be pulled.";
    }
    if (!failed) {
        const result = await docker(c, [
            "run",
            "--rm",
            "--pull",
            "never",
            "--network",
            "none",
            "--user",
            "0",
            "--mount",
            `type=bind,src=${c.layout.dir},dst=/state`,
            "--entrypoint",
            "rm",
            image,
            "-rf",
            ...c.profile.fixedChildren.map((name) => `/state/${name}`),
        ]);
        if (result.code !== 0) failed = "The root helper container could not run.";
    }
    if (!failed) return;
    for (const name of present) await c.d.fs.rmTree(c.layout.file(name)).catch(() => undefined);
    const rest: string[] = [];
    for (const name of c.profile.fixedChildren) {
        if (await c.d.fs.stat(c.layout.file(name))) rest.push(name);
    }
    throw new DeployError(
        `${failed} ${c.layout.dir} is kept. Remove what is left by hand, then run ${c.profile.removeCommand} again:\n` +
            manualRemoval(c)
                .filter((line) => rest.some((name) => line.endsWith(`/${name}`)))
                .join("\n"),
    );
}

async function removeProjectImage(c: Ctx, tag: string): Promise<void> {
    const label = c.profile.imageLabel;
    if (label) {
        const result = await docker(c, ["image", "inspect", "-f", LABEL_TEMPLATE(label), tag]);
        if (result.code !== 0 || outOf(result).trim() !== c.project) {
            throw new DeployError(
                `Image ${tag} does not carry the label ${label}=${c.project}; refusing to remove it.`,
            );
        }
    }
    must(await docker(c, ["image", "rm", tag]), "Removing an image");
}

export interface TeardownHooks {
    // Called when the Dokku container exists but is not running; it must start it and wait until
    // it is healthy. Without it the teardown refuses.
    startDokku?(c: Ctx): Promise<void>;
    // Called after the images are removed, before the final check of what remains.
    afterImages?(c: Ctx, record: State | null): Promise<void>;
}

// The way out when Compose cannot be used: the remove command refuses, so name each resource.
export const recoveryByHand = (layout: Layout, project?: string): string =>
    `To recover by hand, ${
        project
            ? ""
            : `find the project name (it is derived from this checkout's path; docker ps -a --filter ` +
              `label=${LABEL_PROJECT} --format '{{.Label "${LABEL_PROJECT}"}}' lists the names, and ` +
              "the one starting with the dev prefix and matching this checkout is yours), then "
    }remove the project's resources by exact name ` +
    `(docker ps -a --filter label=${LABEL_PROJECT}=${project ?? "<project>"}, then docker rm -f, docker volume rm, ` +
    `docker network rm and docker image rm on what it lists), then delete ${layout.dir} ` +
    "(its dokku/ child is root-owned: sudo rm -rf).";

// Removes everything the tool created for this checkout; see the module comment. Every removal is
// gated by a label check or an exact name derived from the recorded project.
export async function teardown(
    d: BaseDeps,
    profile: Profile,
    options: { project?: string },
    hooks: TeardownHooks = {},
): Promise<void> {
    const layout = layoutFor(d.repo, profile.stateDir);
    const record = await readState({ d, layout, project: "", profile });
    const project = checkProject(
        profile,
        options.project ?? record.state?.project ?? projectNameFor(d.repo, profile.projectPrefix),
    );
    const c: Ctx = { d, layout, project, profile };
    if (record.kind === "ok") checkRecord(c, record.state!);
    if ((await docker(c, ["version", "--format", "{{.Server.Version}}"])).code !== 0) {
        throw new DeployError("The Docker daemon did not answer. Nothing was removed.");
    }
    const dirStat = await checkDirectory(c);
    let resources = await projectResources(c);
    const hasResources =
        resources.containers.length + resources.networks.length + resources.volumes.length > 0;
    if (!dirStat) {
        if (hasResources) {
            throw new DeployError(
                `Project ${project} has resources but ${layout.dir} does not exist, so ${profile.removeCommand} cannot ` +
                    `remove them. Run it from the checkout that created them, or remove them by exact name ` +
                    `(docker ps -a --filter label=${LABEL_PROJECT}=${project}, then docker rm -f, ` +
                    "docker volume rm and docker network rm on what it lists).",
            );
        }
        d.log(`Nothing to remove for ${project}.`);
        return;
    }
    if (record.kind === "corrupt") {
        throw new DeployError(
            `${layout.file("state.json")} is unreadable; ${profile.removeCommand} refuses to guess. ` +
                recoveryByHand(layout, project),
        );
    }
    if (record.kind === "none") {
        const children = await d.fs.readdir(layout.dir);
        const strange = children.filter(
            (name) => !profile.fixedChildren.includes(name) && !profile.cleanExtras.has(name),
        );
        const images: string[] = [];
        for (const tag of profile.imageTags(project)) {
            if (await imageExists(c, tag)) images.push(tag);
        }
        if (hasResources || strange.length > 0 || images.length > 0) {
            const why = hasResources
                ? `project ${project} has resources`
                : images.length > 0
                  ? `project ${project} has images (${images.join(", ")})`
                  : `holds ${strange.join(", ")}`;
            throw new DeployError(
                `${layout.dir} has no state.json but ${why}; refusing to remove anything.`,
            );
        }
    }
    // Every Compose command reads compose.env: check before anything is removed, so a retry is
    // not stuck half-way.
    if (hasResources && (await d.fs.stat(layout.file("compose.env"))) === null) {
        throw new DeployError(
            `compose.env is missing, so Compose cannot remove project ${project} and ` +
                `${profile.removeCommand} refuses. Nothing was removed. ${recoveryByHand(layout, project)}`,
        );
    }
    let dokku = resources.containers.find((x) => x.service === "dokku");
    if (dokku && dokku.state !== "running") {
        if (!hooks.startDokku) {
            throw new DeployError(
                `The Dokku container exists but is not running. Nothing was removed; run: ` +
                    `${composeHint(c, "start dokku postgres")}, then ${profile.removeCommand} again.`,
            );
        }
        await hooks.startDokku(c);
        resources = await projectResources(c);
        dokku = resources.containers.find((x) => x.service === "dokku");
    }

    let sites: Site[] = [];
    if (resources.containers.length > 0) {
        if (profile.writers.length > 0) {
            d.log(`Stopping ${profile.writers.join(" and ")}...`);
            await stopWriters(c);
        }
        if (dokku) await waitForDokkuToSettle(c, dokku.id);
        const found = await discover(c, dokku?.id ?? null);
        for (const name of found.ignored) d.log(`Ignoring ${name}: not a Launchpad site name.`);
        sites = found.sites;
        if (!found.databaseReadable)
            d.log("The database could not be read; using the other sources.");
        await writeInventory(c, sites);
        d.log(`Removing ${sites.length} deployed site${sites.length === 1 ? "" : "s"}...`);
        for (const site of sites) {
            aborted(c, true);
            await destroySite(c, dokku?.id ?? null, site);
        }
        for (const site of sites.filter((x) => x.tag === null)) {
            d.log(
                `The image launchpad/site:<id> of ${site.app} could not be derived (no deployment id is known); ` +
                    "if one remains, find it with: docker image ls launchpad/site",
            );
        }
        const again = await discover(c, dokku?.id ?? null);
        // A tag the first pass could not derive may be known now (the database was unreadable
        // before): remove that image too, so success never leaves it behind.
        for (let i = 0; i < sites.length; i++) {
            const old = sites[i]!;
            const found =
                old.tag === null ? again.sites.find((s) => s.app === old.app && s.tag) : undefined;
            if (found) {
                sites[i] = found;
                checkSiteName(found);
                await removeImages(c, await siteImages(c, found));
            }
        }
        await writeInventory(c, sites);
        const known = new Set(sites.map((s) => s.app));
        const added = again.sites.filter((s) => !known.has(s.app)).map((s) => s.app);
        const left = await leftovers(c, sites);
        if (added.length > 0 || left.length > 0) {
            throw new DeployError(
                `Something appeared or remained while removing the sites: ${[...added, ...left].join(", ")}. ` +
                    `${c.profile.stateDir}/ is kept; run ${c.profile.removeCommand} again.`,
            );
        }
    } else {
        try {
            sites = await readInventoryFile(c);
        } catch (error) {
            if (error instanceof InventoryError)
                throw new DeployError(
                    `${error.message} Nothing was removed.${inventoryHint(c, error)}`,
                );
            throw error;
        }
    }

    if (resources.containers.length === 0) {
        // The project's containers are gone, but a site container may still sit on the apps
        // network: the same ownership-checked cleanup, without a Dokku to ask.
        for (const site of sites) {
            aborted(c, true);
            await destroySite(c, null, site);
        }
    }
    aborted(c, true);
    if (hasResources) {
        for (const container of await confirmed(c, await labeledContainers(c))) {
            must(await docker(c, ["rm", "-f", container.id]), "Removing a container");
        }
        if ((await d.fs.stat(layout.file("compose.env"))) === null) {
            throw new DeployError(
                `compose.env is missing, so Compose cannot remove project ${project}. ${recoveryByHand(layout, project)}`,
            );
        }
        must(
            await compose(c, ["down", "--volumes", "--remove-orphans"]),
            "Removing the Compose project",
        );
    }
    if ((await networkOwner(c, appsNetwork(project))) === "ours") {
        must(await docker(c, ["network", "rm", appsNetwork(project)]), "Removing the apps network");
    }

    aborted(c, true);
    d.log("Removing the root-owned state...");
    await removeStateChildren(c);
    aborted(c, true);

    for (const tag of profile.imageTags(project)) {
        if (await imageExists(c, tag)) await removeProjectImage(c, tag);
    }
    for (const site of sites) {
        checkSiteName(site);
        await removeImages(c, await siteImages(c, site));
    }

    aborted(c, true);
    await hooks.afterImages?.(c, record.kind === "ok" ? record.state! : null);
    const remaining: string[] = [];
    const after = await projectResources(c);
    remaining.push(
        ...after.containers.map((x) => `container ${x.id.slice(0, 12)}`),
        ...after.networks.map((x) => `network ${x}`),
        ...after.volumes.map((x) => `volume ${x}`),
    );
    if ((await networkOwner(c, appsNetwork(project))) === "ours")
        remaining.push(`network ${appsNetwork(project)}`);
    remaining.push(...(await leftovers(c, sites)));
    for (const tag of profile.imageTags(project)) {
        if (await imageExists(c, tag)) remaining.push(`image ${tag}`);
    }
    for (const name of profile.fixedChildren) {
        if (await d.fs.stat(layout.file(name))) remaining.push(`directory ${layout.file(name)}`);
    }
    if (remaining.length > 0) {
        throw new DeployError(
            `Not everything was removed: ${remaining.join(", ")}. ${layout.dir} is kept so ${profile.removeCommand} can run again.`,
        );
    }

    // The record goes last, so an interruption never leaves a directory that looks foreign.
    for (const name of [
        ...profile.stateFiles,
        "inventory.json",
        "inventory.json.next",
        "state.json.next",
        "state.json",
    ]) {
        await d.fs.unlink(layout.file(name));
    }
    try {
        await d.fs.rmdir(layout.dir);
    } catch {
        throw new DeployError(`${layout.dir} still holds other files; remove it by hand.`);
    }
    d.log(
        `Removed project ${project}: its containers, volumes, network, images and ${profile.stateDir}/.`,
    );
    d.log(
        "Pulled base images and the build cache stay (docker image prune, docker builder prune).",
    );
}
