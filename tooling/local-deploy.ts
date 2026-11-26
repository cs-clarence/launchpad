// Deploys examples/hello on this machine with the production Compose stack, and removes
// everything the run created.
//
//   omni -i run local:deploy -a options=up
//   omni -i run local:deploy -a options=status
//   omni -i run local:deploy -a options=down
//
// State lives in <repo>/.local-deploy/ (git-ignored, mode 700). Secrets are only in mode-600
// files there: no password, key or token is ever in an argument, the environment or the output.
// The Docker socket is mounted into the worker and Dokku by docker-compose.yaml, which is
// root-equivalent on this machine. See docs/local-deploy.md.
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
import { ClientCoreError, configDirectory, createContext } from "../packages/client-core/src/index";
import { COMPOSE_FILE, interpolate, loadRaw, requiredVariables } from "./compose-production";
import {
    DEPLOY_KEY_SCOPES,
    parseArgs as parseSeedArgs,
    seed,
    SeedError,
    adminArgs,
    classifyAdmin,
    type AdminMode,
    type Run,
    type RunResult,
} from "./local-seed";

export class DeployError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeployError";
    }
}

export const TOOL_VERSION = "1";
export const STATE_DIR = ".local-deploy";
export const PROFILE = "local-deploy";
export const DEFAULT_PORT_BASE = 32180;
// Offsets from the port base: controller, Dokku HTTP, router data, Dokku SSH, Dokku HTTPS. The
// default base reproduces docker-compose.yaml's defaults.
export const PORT_OFFSETS = { controller: 0, http: 1, router: 2, ssh: 42, https: 263 } as const;
export const MAX_OFFSET = 263;
export const SERVICE_UID = 10001;
export const PROJECT_PATTERN = /^launchpad-local-[a-z0-9-]{1,40}$/;
export const BASE_URL = "https://control.localhost:8443";
export const APPS_DOMAIN = "apps.localhost";
export const IMAGE_SERVICES = ["controller", "worker", "dokku", "router", "admin"] as const;
export const FIXED_CHILDREN = ["dokku", "backups", "credentials", "tls"] as const;
export const STATE_FILES = [
    "compose.env",
    "override.json",
    "state.json",
    "inventory.json",
] as const;
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

// ---- pure planning -----------------------------------------------------------------------

export function projectNameFor(repoPath: string): string {
    return `launchpad-local-${createHash("sha256").update(repoPath).digest("hex").slice(0, 8)}`;
}

export function checkProject(name: string): string {
    if (!PROJECT_PATTERN.test(name)) {
        throw new DeployError(
            `--project must match ${PROJECT_PATTERN.source}, so that its image tags cannot be your own.`,
        );
    }
    return name;
}

export interface Ports {
    controller: number;
    http: number;
    router: number;
    ssh: number;
    https: number;
}

export function checkPortBase(base: number): number {
    if (!Number.isInteger(base) || base < 1024 || base + MAX_OFFSET > 65535) {
        throw new DeployError(
            `--port-base must be a whole number from 1024 to ${65535 - MAX_OFFSET}.`,
        );
    }
    return base;
}

export function portsFor(base: number): Ports {
    checkPortBase(base);
    return {
        controller: base + PORT_OFFSETS.controller,
        http: base + PORT_OFFSETS.http,
        router: base + PORT_OFFSETS.router,
        ssh: base + PORT_OFFSETS.ssh,
        https: base + PORT_OFFSETS.https,
    };
}

export function projectImages(project: string): Record<(typeof IMAGE_SERVICES)[number], string> {
    return Object.fromEntries(IMAGE_SERVICES.map((s) => [s, `${project}/${s}:local`])) as never;
}

export function appsNetwork(project: string) {
    return `${project}-apps`;
}

export interface Layout {
    repo: string;
    dir: string;
    file: (name: string) => string;
}

export function layoutFor(repo: string): Layout {
    if (!path.isAbsolute(repo) || !SAFE_PATH.test(repo)) {
        throw new DeployError(
            `${repo} may only contain letters, digits and _ @ . + / - (Compose reads these paths from an env file).`,
        );
    }
    const dir = path.join(repo, STATE_DIR);
    return { repo, dir, file: (name) => path.join(dir, name) };
}

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

export function composeEnv(
    layout: Layout,
    project: string,
    ports: Ports,
    secrets: Secrets,
    socketGid: number,
    version: string,
): Record<string, string> {
    const f = layout.file;
    return {
        POSTGRES_PASSWORD: secrets.postgresPassword,
        LAUNCHPAD_AUTH_SECRET: secrets.authSecret,
        LAUNCHPAD_ALIAS_INSTANCE_ID: secrets.instanceId,
        LAUNCHPAD_BASE_URL: BASE_URL,
        LAUNCHPAD_APPS_DOMAIN: APPS_DOMAIN,
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_ALIASES: "off",
        DOCKER_SOCKET_GID: String(socketGid),
        DOKKU_DATA_DIR: f("dokku"),
        LAUNCHPAD_BACKUP_DIR: f("backups"),
        LAUNCHPAD_DOKKU_SSH_KEY_FILE: f("credentials/id_ed25519"),
        LAUNCHPAD_DOKKU_KNOWN_HOSTS_FILE: f("credentials/known_hosts"),
        LAUNCHPAD_ROUTER_TOKEN_FILE: f("credentials/token"),
        LAUNCHPAD_ROUTER_EPOCH_FILE: f("credentials/epoch"),
        LAUNCHPAD_ROUTER_TLS_CA_FILE: f("tls/ca.pem"),
        LAUNCHPAD_ROUTER_TLS_CERT_FILE: f("tls/server.pem"),
        LAUNCHPAD_ROUTER_TLS_KEY_FILE: f("tls/server.key"),
        LAUNCHPAD_APPS_NETWORK: appsNetwork(project),
        CONTROLLER_HOST_PORT: String(ports.controller),
        PREVIEW_HTTP_HOST_PORT: String(ports.http),
        ROUTER_DATA_HOST_PORT: String(ports.router),
        DOKKU_SSH_HOST_PORT: String(ports.ssh),
        PREVIEW_HTTPS_HOST_PORT: String(ports.https),
        LAUNCHPAD_VERSION: version,
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

export function overrideFor(project: string) {
    const images = projectImages(project);
    return {
        services: Object.fromEntries(IMAGE_SERVICES.map((s) => [s, { image: images[s] }])),
    };
}

// Required `${VAR:?}` variables of docker-compose.yaml that this env leaves unset.
export function missingVariables(env: Record<string, string>, raw = loadRaw()): string[] {
    const missing = new Set<string>();
    interpolate(raw, env, missing);
    return [...missing].sort();
}

export const requiredNames = () => requiredVariables(loadRaw());

export function hostnamePattern() {
    return new RegExp(`^[a-z0-9-]+\\.${APPS_DOMAIN.replaceAll(".", "\\.")}$`);
}

export interface CredentialCommands {
    sshKeygen: string[];
    caKey: string[];
    serverCsr: string[];
    serverCert: string[];
    extensions: string;
}

// Host `ssh-keygen` and `openssl`, as the rehearsal runner does. No secret is an argument: keys
// are written to files, the passphrase is empty.
export function credentialCommands(layout: Layout): CredentialCommands {
    const f = layout.file;
    return {
        sshKeygen: [
            "ssh-keygen",
            "-q",
            "-t",
            "ed25519",
            "-N",
            "",
            "-f",
            f("credentials/id_ed25519"),
        ],
        caKey: [
            "openssl",
            "req",
            "-new",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "30",
            "-subj",
            "/CN=Launchpad local deploy CA",
            "-addext",
            "basicConstraints=critical,CA:TRUE",
            "-keyout",
            f("tls/ca.key"),
            "-out",
            f("tls/ca.pem"),
        ],
        serverCsr: [
            "openssl",
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-subj",
            "/CN=router",
            "-keyout",
            f("tls/server.key"),
            "-out",
            f("tls/server.csr"),
        ],
        serverCert: [
            "openssl",
            "x509",
            "-req",
            "-days",
            "30",
            "-in",
            f("tls/server.csr"),
            "-CA",
            f("tls/ca.pem"),
            "-CAkey",
            f("tls/ca.key"),
            "-CAcreateserial",
            "-extfile",
            f("tls/extensions"),
            "-out",
            f("tls/server.pem"),
        ],
        extensions: "subjectAltName=DNS:router\nextendedKeyUsage=serverAuth\n",
    };
}

// Files the 10001 service user must own (relative to the state directory).
export const OWNED_BY_SERVICE = [
    "tls/server.key",
    "credentials/id_ed25519",
    "credentials/token",
    "credentials/epoch",
    "credentials/known_hosts",
    "backups",
] as const;

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

// ---- seams -------------------------------------------------------------------------------

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

export interface Deps {
    run: Run;
    fetch: typeof fetch;
    fs: Fs;
    env: Record<string, string | undefined>;
    log: (line: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    probePort: (port: number) => Promise<boolean>;
    // Deletes the profile if it names this controller; resets the current profile only when asked.
    removeProfile: (controller: string, resetCurrent: boolean) => Promise<void>;
    currentProfile: () => Promise<string | null>;
    uid: number;
    repo: string;
    version: string;
    signal?: AbortSignal;
    // The seed, replaceable so a test need not run a controller.
    seed?: typeof seed;
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
const SERVICES = ["postgres", "dokku", "controller", "worker", "router"] as const;

interface Ctx {
    d: Deps;
    layout: Layout;
    project: string;
}

const docker = (c: Ctx, args: string[], input?: string) =>
    c.d.run(["docker", "--host", DOCKER_HOST, ...args], input);

export function composePrefix(layout: Layout, project: string): string[] {
    return [
        "docker",
        "--host",
        DOCKER_HOST,
        "compose",
        "-p",
        project,
        "--env-file",
        layout.file("compose.env"),
        "-f",
        COMPOSE_FILE,
        "-f",
        layout.file("override.json"),
    ];
}

// The command a person can paste: the same arguments the tool uses (generated env file and
// override), without the engine flag. Every hint is built here so none can drift from them.
export function composeHint(layout: Layout, project: string, args: string): string {
    const prefix = composePrefix(layout, project);
    const shown = [...prefix.slice(0, 1), ...prefix.slice(3)];
    return `${shown.join(" ")} ${args}`.trimEnd();
}

const compose = (c: Ctx, args: string[], input?: string) =>
    c.d.run([...composePrefix(c.layout, c.project), ...args], input);

function must(result: RunResult, what: string, hint = ""): RunResult {
    if (result.code !== 0) {
        throw new DeployError(`${what} failed (exit ${result.code}).${hint ? ` ${hint}` : ""}`);
    }
    return result;
}

const outOf = (r: RunResult) => r.stdout ?? r.output;

const lines = (text: string) =>
    text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

export interface Labeled {
    id: string;
    state: string;
    service: string;
}

async function labeledContainers(c: Ctx, extra: string[] = []): Promise<Labeled[]> {
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

async function inspectLabel(c: Ctx, id: string, key: string): Promise<string> {
    const result = await docker(c, ["inspect", "-f", LABEL_TEMPLATE(key), id]);
    return result.code === 0 ? outOf(result).trim() : "";
}

// A container is touched only after its Compose project label is confirmed by inspect.
async function confirmed(c: Ctx, containers: Labeled[]): Promise<Labeled[]> {
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

async function projectResources(c: Ctx) {
    return {
        containers: await labeledContainers(c),
        networks: await labeledNames(c, "network"),
        volumes: await labeledNames(c, "volume"),
    };
}

async function networkOwner(c: Ctx, name: string): Promise<"absent" | "ours" | "foreign"> {
    const result = await docker(c, ["network", "inspect", "-f", NETWORK_LABEL_TEMPLATE, name]);
    if (result.code !== 0) return "absent";
    return outOf(result).trim() === c.project ? "ours" : "foreign";
}

async function imageExists(c: Ctx, name: string): Promise<boolean> {
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
        const owner = await inspectLabel(c, id, LABEL_PROJECT);
        if (owner === "" || owner === c.project) mine.push(id);
    }
    return mine;
}

function aborted(d: Deps, tearingDown = false) {
    if (d.signal?.aborted) {
        throw new DeployError(
            tearingDown
                ? "Interrupted. Nothing further was removed and .local-deploy/ is kept; run down again to continue."
                : "Interrupted. Nothing was rolled back: run `up` again to continue, or `down` to remove it.",
        );
    }
}

async function waitFor(
    d: Deps,
    label: string,
    budgetMs: number,
    check: () => Promise<boolean>,
): Promise<void> {
    const deadline = d.now() + budgetMs;
    let next = d.now() + 30_000;
    for (;;) {
        aborted(d);
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
async function serviceHealth(c: Ctx, service: string): Promise<string> {
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
            `${service} exited or keeps restarting. See: ${composeHint(c.layout, c.project, `logs --tail 50 ${service}`)}`,
        );
    }
    return state.trim();
}

async function waitHealthy(c: Ctx, service: string, budgetMs: number) {
    try {
        await waitFor(c.d, `${service} to be healthy`, budgetMs, async () => {
            return (await serviceHealth(c, service)) === "running healthy";
        });
    } catch (error) {
        if (error instanceof DeployError && /Timed out/.test(error.message)) {
            throw new DeployError(
                `${error.message} Everything is kept; look at: ${composeHint(c.layout, c.project, `logs --tail 50 ${service}`)}`,
            );
        }
        throw error;
    }
}

// ---- state directory ---------------------------------------------------------------------

// Atomic: a kill leaves the old record or the new one, never a torn file.
async function writeState(c: Ctx, profileSetByUp: boolean): Promise<void> {
    const next = c.layout.file("state.json.next");
    await c.d.fs.writeFile(
        next,
        JSON.stringify({
            project: c.project,
            repo: c.layout.repo,
            version: TOOL_VERSION,
            ...(profileSetByUp ? { profileSetByUp: true } : {}),
        }),
        0o600,
    );
    await c.d.fs.rename(next, c.layout.file("state.json"));
}

async function readState(c: Ctx): Promise<{ kind: "none" | "corrupt" | "ok"; state?: State }> {
    const text = await c.d.fs.readFile(c.layout.file("state.json"));
    if (text === null) return { kind: "none" };
    const state = parseState(text);
    return state ? { kind: "ok", state } : { kind: "corrupt" };
}

function checkRecord(c: Ctx, state: State): void {
    if (
        state.project !== c.project ||
        state.repo !== c.layout.repo ||
        state.version !== TOOL_VERSION
    ) {
        throw new DeployError(
            `${c.layout.file("state.json")} belongs to project ${state.project} (${state.repo}, tool ` +
                `version ${state.version}), not ${c.project} here. Run down from the checkout that created it` +
                (state.project !== c.project ? `, or pass --project ${state.project}` : "") +
                ".",
        );
    }
}

// The one directory every secret and the root helper's mount live in: a real directory we own,
// mode 700, whose physical path is exactly <repo>/.local-deploy.
async function checkDirectory(c: Ctx): Promise<FsStat | null> {
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

async function checkDocker(d: Deps): Promise<void> {
    const ctx = { d } as Ctx;
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

// ---- up ----------------------------------------------------------------------------------

export interface UpOptions {
    project?: string;
    portBase?: number;
    newKey?: boolean;
}

const PORT_KEYS = {
    controller: "CONTROLLER_HOST_PORT",
    http: "PREVIEW_HTTP_HOST_PORT",
    router: "ROUTER_DATA_HOST_PORT",
    ssh: "DOKKU_SSH_HOST_PORT",
    https: "PREVIEW_HTTPS_HOST_PORT",
} as const;

function portsFromEnv(env: Record<string, string>): Ports {
    const out = {} as Ports;
    for (const [name, key] of Object.entries(PORT_KEYS)) {
        const n = Number(env[key]);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
            throw new DeployError(`compose.env has no valid ${key}; run down, then up again.`);
        }
        out[name as keyof Ports] = n;
    }
    return out;
}

async function freePorts(c: Ctx, ports: Ports, persisted: boolean): Promise<void> {
    const busy: string[] = [];
    let published: string | null = null;
    for (const [name, port] of Object.entries(ports)) {
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
                (persisted
                    ? "Run down, then up again with --port-base <n> to move."
                    : "Pass --port-base <n> to choose another range (offsets 0, 1, 2, 42 and 263)."),
        );
    }
}

async function conflictsWithoutRecord(c: Ctx): Promise<void> {
    const found = await projectResources(c);
    const tags = Object.values(projectImages(c.project));
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
                "matching .local-deploy/state.json. Run down from the checkout that created them, or pick another " +
                "--project. Nothing was changed.",
        );
    }
}

// Everything below is derived from fixed names inside the validated state directory. The last
// artifact, tls/server.pem, marks a complete set: without it, partial output from an earlier
// run is removed and everything is generated again (nothing has used it yet). Once the router has
// been initialised the files are in use, so a partial set is refused instead.
const GENERATED = [
    "credentials/epoch",
    "credentials/known_hosts",
    "credentials/token",
    "credentials/id_ed25519",
    "credentials/id_ed25519.pub",
    "tls/extensions",
    "tls/ca.key",
    "tls/ca.pem",
    "tls/ca.srl",
    "tls/server.key",
    "tls/server.csr",
    "tls/server.pem",
] as const;

// A real directory (not a link) that the invoking user owns, with the exact mode.
async function checkOwnDirectory(c: Ctx, name: string, mode: number): Promise<void> {
    const stat = await c.d.fs.stat(c.layout.file(name));
    if (!stat || stat.isSymlink || !stat.isDirectory) {
        throw new DeployError(
            `${STATE_DIR}/${name} must be a real directory, not a link or a file. Run down, then up again.`,
        );
    }
    if (stat.uid !== c.d.uid || (stat.mode & 0o777) !== mode) {
        throw new DeployError(
            `${STATE_DIR}/${name} must be owned by you with mode ${mode.toString(8)}. Run down, then up again.`,
        );
    }
}

async function ensureDirectory(c: Ctx, name: string, mode: number): Promise<void> {
    const path = c.layout.file(name);
    if ((await c.d.fs.stat(path)) === null) await c.d.fs.mkdir(path, mode);
    await checkOwnDirectory(c, name, mode);
}

async function generateCredentials(c: Ctx): Promise<void> {
    const { d, layout } = c;
    const f = layout.file;
    const epoch = await d.fs.stat(f("credentials/epoch"));
    if (epoch && epoch.size > 0) {
        throw new DeployError(
            "The credentials are incomplete but the router was already initialised; run down, then up again.",
        );
    }
    await ensureDirectory(c, "dokku", 0o755);
    for (const name of ["backups", "tls", "credentials"]) await ensureDirectory(c, name, 0o700);
    for (const name of GENERATED) {
        try {
            await d.fs.unlink(f(name));
        } catch {
            throw new DeployError(
                `Could not remove ${f(name)} (is it a directory?). Remove it by hand: rm -rf ${f(name)}, then run up again.`,
            );
        }
    }
    const cmds = credentialCommands(layout);
    const gen = async (args: string[], what: string) => {
        const r = await d.run(args);
        if (r.code !== 0) {
            throw new DeployError(`${what} failed (exit ${r.code}); is ${args[0]} installed?`);
        }
    };
    await d.fs.writeFile(f("credentials/epoch"), "", 0o600, true);
    await d.fs.writeFile(f("credentials/known_hosts"), "", 0o600, true);
    await d.fs.writeFile(
        f("credentials/token"),
        `${randomBytes(32).toString("hex")}\n`,
        0o600,
        true,
    );
    await gen(cmds.sshKeygen, "Generating the worker's SSH key");
    await gen(cmds.caKey, "Generating the throwaway CA");
    await gen(cmds.serverCsr, "Generating the router key");
    await d.fs.writeFile(f("tls/extensions"), cmds.extensions, 0o600, true);
    await gen(cmds.serverCert, "Signing the router certificate");
    for (const name of ["tls/ca.key", "tls/server.csr", "tls/extensions", "tls/ca.srl"]) {
        await d.fs.unlink(f(name));
    }
}

// Compose would create a root-owned directory for a missing bind source, so check first.
async function verifyCredentials(c: Ctx): Promise<void> {
    const f = c.layout.file;
    await checkOwnDirectory(c, "tls", 0o700);
    await checkOwnDirectory(c, "credentials", 0o700);
    const problems: string[] = [];
    for (const [name, secret] of [
        ["credentials/id_ed25519", true],
        ["credentials/id_ed25519.pub", false],
        ["credentials/known_hosts", false],
        ["credentials/token", true],
        ["credentials/epoch", false],
        ["tls/ca.pem", false],
        ["tls/server.pem", false],
        ["tls/server.key", true],
    ] as const) {
        const stat = await c.d.fs.stat(f(name));
        if (!stat || !stat.isFile) problems.push(`${name} is missing or not a file`);
        else if (secret && (stat.mode & 0o077) !== 0) problems.push(`${name} must be mode 600`);
    }
    for (const name of ["dokku", "backups"]) {
        const stat = await c.d.fs.stat(f(name));
        if (!stat || stat.isSymlink || !stat.isDirectory) {
            problems.push(`${name} is missing or not a real directory`);
        }
    }
    if (problems.length > 0) {
        throw new DeployError(`${problems.join("; ")}. Run down, then up again.`);
    }
}

async function ownedByServiceUser(c: Ctx): Promise<void> {
    const image = projectImages(c.project).worker;
    must(
        await docker(c, [
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
            "chown",
            image,
            "-h",
            "10001:10001",
            ...OWNED_BY_SERVICE.map((name) => `/state/${name}`),
        ]),
        "Fixing file ownership for the services",
    );
}

async function bootstrapDokkuAndRouter(c: Ctx): Promise<void> {
    const { d, layout } = c;
    const f = layout.file;
    must(
        await compose(c, [
            "exec",
            "-T",
            "dokku",
            "dokku",
            "network:set",
            "--global",
            "initial-network",
            appsNetwork(c.project),
        ]),
        "Setting Dokku's initial network",
    );
    const key =
        must(
            await compose(c, ["exec", "-T", "dokku", "cat", "/etc/ssh/ssh_host_ed25519_key.pub"]),
            "Reading Dokku's host key",
        ).stdout?.trim() ?? "";
    const hostKey = /ssh-ed25519 [A-Za-z0-9+/=]+/.exec(key)?.[0];
    if (!hostKey) throw new DeployError("Unexpected Dokku host key.");
    await d.fs.writeFile(f("credentials/known_hosts"), `dokku ${hostKey}\n`, 0o600);
    const pub = await d.fs.readFile(f("credentials/id_ed25519.pub"));
    if (!pub) throw new DeployError("The worker's public key is missing.");
    await compose(c, ["exec", "-T", "dokku", "dokku", "ssh-keys:remove", "launchpad-worker"]);
    must(
        await compose(c, ["exec", "-T", "dokku", "dokku", "ssh-keys:add", "launchpad-worker"], pub),
        "Registering the worker's key with Dokku",
    );
    const token = await d.fs.readFile(f("credentials/token"));
    if (!token) throw new DeployError("The router token is missing.");
    const init = must(
        await compose(
            c,
            [
                "run",
                "--rm",
                "--no-deps",
                "--pull",
                "never",
                "-T",
                "router",
                "init",
                "--token-stdin",
            ],
            token,
        ),
        "Initialising the router",
        "If it says state exists, run down and up again.",
    );
    const epoch = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/.exec(outOf(init))?.[0];
    if (!epoch) throw new DeployError("The router did not print an epoch.");
    await d.fs.writeFile(f("credentials/epoch"), `${epoch}\n`, 0o600);
    await ownedByServiceUser(c);
}

export function adminMode(layout: Layout, project: string): AdminMode {
    return {
        kind: "compose",
        prefix: composePrefix(layout, project),
        project,
        stateDir: layout.dir,
        composeCommand: composeHint(layout, project, ""),
    };
}

export interface Summary {
    stopHint: string;
    project: string;
    ports: Ports;
    profile: string;
    organization: string;
    projectSlug: string;
}

export async function up(d: Deps, options: UpOptions = {}): Promise<Summary> {
    const layout = layoutFor(d.repo);
    const project = checkProject(options.project ?? projectNameFor(d.repo));
    if (options.portBase !== undefined) checkPortBase(options.portBase);
    const c: Ctx = { d, layout, project };
    await checkDocker(d);
    const ignored = await d.run([
        "git",
        "-C",
        layout.repo,
        "check-ignore",
        "-q",
        `${STATE_DIR}/state.json`,
    ]);
    if (ignored.code !== 0) {
        throw new DeployError(
            `${STATE_DIR}/ is not ignored by git; add it to .gitignore before secrets are written there.`,
        );
    }

    // check-ignore does not see tracked files: a tracked path would be committed with its secrets.
    const tracked = await d.run(["git", "-C", layout.repo, "ls-files", "--", STATE_DIR]);
    if (tracked.code !== 0 || outOf(tracked).trim() !== "") {
        throw new DeployError(
            `Files under ${STATE_DIR}/ are tracked by git (or git could not say); secrets would be ` +
                `committed. Run git rm -r --cached ${STATE_DIR} first. Nothing was written.`,
        );
    }

    const dirStat = await checkDirectory(c);
    const record = await readState(c);
    if (record.kind === "corrupt") {
        throw new DeployError(`${layout.file("state.json")} is unreadable; run down first.`);
    }
    if (record.kind === "ok") checkRecord(c, record.state!);
    else if (dirStat && (await d.fs.readdir(layout.dir)).length > 0) {
        throw new DeployError(
            `${layout.dir} exists without a state.json; refusing to reuse it. Run down first.`,
        );
    }
    if (record.kind !== "ok") await conflictsWithoutRecord(c);

    // The record comes first: an interrupted up always leaves what down needs.
    if (!dirStat) await d.fs.mkdir(layout.dir, 0o700);
    if (record.kind !== "ok") {
        await d.fs.writeFile(
            layout.file("state.json"),
            JSON.stringify({ project, repo: layout.repo, version: TOOL_VERSION }),
            0o600,
        );
    }

    const envText = await d.fs.readFile(layout.file("compose.env"));
    let ports: Ports;
    if (envText === null) {
        ports = portsFor(options.portBase ?? DEFAULT_PORT_BASE);
        await freePorts(c, ports, false);
        const gid = parseSocketGid(
            outOf(
                must(await d.run(["stat", "-c", "%g", DOCKER_SOCKET]), "Reading the socket group"),
            ),
        );
        const env = composeEnv(layout, project, ports, generateSecrets(), gid, d.version);
        const missing = missingVariables(env);
        if (missing.length > 0) throw new DeployError(`Missing settings: ${missing.join(", ")}.`);
        await d.fs.writeFile(layout.file("compose.env"), renderEnv(env), 0o600, true);
        await d.fs.writeFile(
            layout.file("override.json"),
            JSON.stringify(overrideFor(project)),
            0o600,
            true,
        );
    } else {
        ports = portsFromEnv(parseEnv(envText));
        if (options.portBase !== undefined) {
            const asked = portsFor(options.portBase);
            if (JSON.stringify(asked) !== JSON.stringify(ports)) {
                throw new DeployError(
                    "Ports are fixed by the first up. Run down, then up --port-base again to move.",
                );
            }
        }
        await freePorts(c, ports, true);
    }
    if ((await d.fs.stat(layout.file("override.json"))) === null) {
        throw new DeployError("override.json is missing; run down, then up again.");
    }
    if ((await d.fs.stat(layout.file("tls/server.pem"))) === null) {
        await generateCredentials(c);
    }
    await verifyCredentials(c);

    d.log("Building the five images (the slow part on a first run)...");
    must(
        await d.run([
            ...composePrefix(layout, project),
            "--profile",
            "admin",
            "build",
            "--builder",
            "default",
        ]),
        "Building the images",
        `See: ${composeHint(layout, project, "--profile admin build")}`,
    );
    d.log("Starting PostgreSQL and Dokku (Dokku's first start takes minutes)...");
    must(
        await compose(c, ["up", "-d", "--no-build", "postgres", "dokku"]),
        "Starting PostgreSQL and Dokku",
    );
    await waitHealthy(c, "postgres", 7 * 60_000);
    await waitHealthy(c, "dokku", 11 * 60_000);

    const epoch = await d.fs.stat(layout.file("credentials/epoch"));
    if (!epoch || epoch.size === 0) {
        d.log("Pinning Dokku's host key, registering the worker's key, initialising the router...");
        await bootstrapDokkuAndRouter(c);
    } else {
        // An earlier run may have stopped part-way through the chown: every entry must be ours to
        // the service user, not just the first one it reaches.
        let wrong = false;
        for (const name of OWNED_BY_SERVICE) {
            const stat = await d.fs.stat(layout.file(name));
            if (!stat || stat.uid !== SERVICE_UID) wrong = true;
        }
        if (wrong) await ownedByServiceUser(c);
    }
    const mode = adminMode(layout, project);
    classifyAdmin("migrate", await d.run(adminArgs("migrate", [], mode)), mode);
    d.log("Database is migrated.");

    d.log("Starting the controller, worker and router...");
    must(await compose(c, ["up", "-d", "--no-build"]), "Starting the services");
    for (const service of ["controller", "router", "worker"])
        await waitHealthy(c, service, 7 * 60_000);

    const config = path.resolve(configDirectory(d.env));
    const options2 = parseSeedArgs([
        "--controller",
        `http://127.0.0.1:${ports.controller}`,
        "--origin",
        BASE_URL,
        "--profile",
        PROFILE,
        "--operator-password-file",
        path.join(config, "local-deploy-operator.password"),
        "--owner-password-file",
        path.join(config, "local-deploy-owner.password"),
        ...(options.newKey ? ["--new-key"] : []),
    ]);
    const profileBefore = await d.currentProfile();
    // Recorded before the seed's login can make the profile current, so a kill in between
    // cannot leave a current profile that `down` does not know about.
    const claimedBefore = record.kind === "ok" && record.state?.profileSetByUp === true;
    if (profileBefore === null && !claimedBefore) await writeState(c, true);
    const summary = await (d.seed ?? seed)(
        {
            fetch: d.fetch,
            run: d.run,
            env: d.env,
            log: d.log,
            sleep: d.sleep,
            now: d.now,
            admin: mode,
            scopes: DEPLOY_KEY_SCOPES,
            keyName: PROFILE,
        },
        options2,
    );
    if (profileBefore === null && !claimedBefore && (await d.currentProfile()) !== PROFILE) {
        await writeState(c, false);
    }
    const result: Summary = {
        stopHint: composeHint(layout, project, "stop"),
        project,
        ports,
        profile: summary.profile,
        organization: summary.organization,
        projectSlug: summary.project,
    };
    printSummary(d, result);
    return result;
}

function printSummary(d: Deps, s: Summary): void {
    d.log("");
    d.log(`Project ${s.project} is up. Everything listens on 127.0.0.1 only:`);
    d.log(`  controller     http://127.0.0.1:${s.ports.controller}`);
    d.log(`  Dokku HTTP     http://127.0.0.1:${s.ports.http}  (send a Host header, see the guide)`);
    d.log(`  Dokku SSH      127.0.0.1:${s.ports.ssh}`);
    d.log(`  Dokku HTTPS    127.0.0.1:${s.ports.https}`);
    d.log(`  router (data)  127.0.0.1:${s.ports.router}`);
    d.log(`CLI profile: ${s.profile}; organization ${s.organization}, project ${s.projectSlug}.`);
    d.log("Next: deploy examples/hello with the launchpad CLI (docs/local-deploy.md).");
    d.log(`To stop without deleting: ${s.stopHint}. To remove everything: down.`);
}

// ---- status ------------------------------------------------------------------------------

async function loadContext(d: Deps, options: UpOptions): Promise<{ c: Ctx; state: State | null }> {
    const layout = layoutFor(d.repo);
    const record = await (async () => {
        const c0: Ctx = { d, layout, project: "" };
        return readState(c0);
    })();
    const project = checkProject(
        options.project ?? record.state?.project ?? projectNameFor(d.repo),
    );
    const c: Ctx = { d, layout, project };
    if (record.kind === "ok") checkRecord(c, record.state!);
    return { c, state: record.kind === "ok" ? record.state! : null };
}

const DB_QUERY = [
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
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

async function readInventoryFile(c: Ctx): Promise<Site[]> {
    const text = await c.d.fs.readFile(c.layout.file("inventory.json"));
    return text === null ? [] : parseInventory(text, c.project);
}

async function writeInventory(c: Ctx, sites: Site[]): Promise<void> {
    const next = c.layout.file("inventory.json.next");
    await c.d.fs.writeFile(next, renderInventory(c.project, sites), 0o600);
    await c.d.fs.rename(next, c.layout.file("inventory.json"));
}

export async function status(d: Deps, options: UpOptions = {}): Promise<void> {
    await checkDocker(d);
    const { c, state } = await loadContext(d, options);
    if (!state) throw new DeployError("No .local-deploy/state.json here: run up first.");
    await checkDirectory(c);
    const envText = await d.fs.readFile(c.layout.file("compose.env"));
    if (envText === null) throw new DeployError("compose.env is missing; run down, then up.");
    const ports = portsFromEnv(parseEnv(envText));
    d.log(`Project ${c.project}`);
    for (const service of SERVICES) {
        let health: string;
        try {
            health = await serviceHealth(c, service);
        } catch (error) {
            health =
                error instanceof DeployError && /exited or keeps restarting/.test(error.message)
                    ? "exited"
                    : "unknown";
        }
        d.log(`  ${service.padEnd(11)} ${health}`);
    }
    d.log(
        `Ports (127.0.0.1): controller ${ports.controller}, Dokku HTTP ${ports.http}, SSH ${ports.ssh}`,
    );
    d.log(`CLI profile: ${PROFILE}`);
    const query = await compose(c, DB_QUERY);
    if (query.code !== 0) {
        d.log("The database is not reachable; the recorded inventory was kept as it is.");
        return;
    }
    let previous: Site[] = [];
    try {
        previous = await readInventoryFile(c);
    } catch {
        // A bad file is replaced by what the database says.
    }
    const sites = mergeSites(previous, parseDatabaseRows(outOf(query).trim()));
    await writeInventory(c, sites);
    d.log(`Recorded ${sites.length} deployment${sites.length === 1 ? "" : "s"} in the inventory.`);
}

// ---- down --------------------------------------------------------------------------------

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

const APP_CONTAINER = /^(lp-[a-z0-9]{10})\.[a-z0-9_-]+\.[0-9]+$/;
const CLEAN_EXTRAS = new Set([
    "compose.env",
    "override.json",
    "inventory.json",
    "inventory.json.next",
    "state.json.next",
]);

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
function inventoryHint(error: Error): string {
    return /belongs to another project/.test(error.message)
        ? " Run status to rewrite it, or delete .local-deploy/inventory.json."
        : "";
}

async function discover(
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
            throw new DeployError(`${error.message} Nothing was removed.${inventoryHint(error)}`);
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

async function stopWriters(c: Ctx): Promise<void> {
    for (const service of ["controller", "worker"]) {
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

async function waitForDokkuToSettle(c: Ctx, dokkuId: string): Promise<void> {
    try {
        await waitFor(c.d, "Dokku to finish its running commands", 60_000, async () =>
            dokkuIdle(await docker(c, ["top", dokkuId, "-eo", "pid,comm,args"])),
        );
    } catch (error) {
        if (error instanceof DeployError && /Timed out/.test(error.message)) {
            throw new DeployError(
                "A build or Dokku command is still running in Dokku. Nothing was removed and " +
                    ".local-deploy/ is kept; run down again in a minute.",
            );
        }
        throw error;
    }
}

async function destroySite(c: Ctx, dokkuId: string | null, site: Site): Promise<void> {
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

async function leftovers(c: Ctx, sites: Site[]): Promise<string[]> {
    const left: string[] = [];
    for (const site of sites) {
        if ((await siteContainers(c, site)).length > 0) left.push(`containers of ${site.app}`);
        for (const image of await siteImages(c, site)) left.push(`image ${image.ref}`);
    }
    return left;
}

function manualRemoval(c: Ctx): string[] {
    return FIXED_CHILDREN.map((name) => `sudo rm -rf ${c.layout.file(name)}`);
}

async function removeStateChildren(c: Ctx): Promise<void> {
    const present: string[] = [];
    for (const name of FIXED_CHILDREN) {
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
            ...FIXED_CHILDREN.map((name) => `/state/${name}`),
        ]);
        if (result.code !== 0) failed = "The root helper container could not run.";
    }
    if (!failed) return;
    for (const name of present) await c.d.fs.rmTree(c.layout.file(name)).catch(() => undefined);
    const rest: string[] = [];
    for (const name of FIXED_CHILDREN) if (await c.d.fs.stat(c.layout.file(name))) rest.push(name);
    throw new DeployError(
        `${failed} ${c.layout.dir} is kept. Remove what is left by hand, then run down again:\n` +
            manualRemoval(c)
                .filter((line) => rest.some((name) => line.endsWith(`/${name}`)))
                .join("\n"),
    );
}

export async function down(d: Deps, options: UpOptions = {}): Promise<void> {
    const layout = layoutFor(d.repo);
    const record = await readState({ d, layout, project: "" });
    const project = checkProject(
        options.project ?? record.state?.project ?? projectNameFor(d.repo),
    );
    const c: Ctx = { d, layout, project };
    if (record.kind === "ok") checkRecord(c, record.state!);
    if ((await docker(c, ["version", "--format", "{{.Server.Version}}"])).code !== 0) {
        throw new DeployError("The Docker daemon did not answer. Nothing was removed.");
    }
    const dirStat = await checkDirectory(c);
    const resources = await projectResources(c);
    const hasResources =
        resources.containers.length + resources.networks.length + resources.volumes.length > 0;
    if (!dirStat) {
        if (hasResources) {
            throw new DeployError(
                `Project ${project} has resources but ${layout.dir} does not exist, so down cannot ` +
                    `remove them. Run it from the checkout that created them, or remove them by exact name ` +
                    `(docker ps -a --filter label=${LABEL_PROJECT}=${project}, then docker rm -f, ` +
                    "docker volume rm and docker network rm on what it lists).",
            );
        }
        d.log(`Nothing to remove for ${project}.`);
        return;
    }
    if (record.kind === "corrupt") {
        throw new DeployError(`${layout.file("state.json")} is unreadable; down refuses to guess.`);
    }
    if (record.kind === "none") {
        const children = await d.fs.readdir(layout.dir);
        const strange = children.filter(
            (name) =>
                !(FIXED_CHILDREN as readonly string[]).includes(name) && !CLEAN_EXTRAS.has(name),
        );
        if (hasResources || strange.length > 0) {
            throw new DeployError(
                `${layout.dir} has no state.json but ${hasResources ? `project ${project} has resources` : `holds ${strange.join(", ")}`}; ` +
                    "refusing to remove anything.",
            );
        }
    }
    const dokku = resources.containers.find((x) => x.service === "dokku");
    if (dokku && dokku.state !== "running") {
        throw new DeployError(
            `The Dokku container exists but is not running. Nothing was removed; run: ` +
                `${composeHint(layout, project, "start dokku postgres")}, then down again.`,
        );
    }

    let sites: Site[] = [];
    if (resources.containers.length > 0) {
        d.log("Stopping the controller and worker...");
        await stopWriters(c);
        if (dokku) await waitForDokkuToSettle(c, dokku.id);
        const found = await discover(c, dokku?.id ?? null);
        for (const name of found.ignored) d.log(`Ignoring ${name}: not a Launchpad site name.`);
        sites = found.sites;
        if (!found.databaseReadable)
            d.log("The database could not be read; using the other sources.");
        await writeInventory(c, sites);
        d.log(`Removing ${sites.length} deployed site${sites.length === 1 ? "" : "s"}...`);
        for (const site of sites) {
            aborted(d, true);
            await destroySite(c, dokku?.id ?? null, site);
        }
        for (const site of sites.filter((x) => x.tag === null)) {
            d.log(
                `The image launchpad/site:<id> of ${site.app} could not be derived (no deployment id is known); ` +
                    "if one remains, find it with: docker image ls launchpad/site",
            );
        }
        const again = await discover(c, dokku?.id ?? null);
        const known = new Set(sites.map((s) => s.app));
        const added = again.sites.filter((s) => !known.has(s.app)).map((s) => s.app);
        const left = await leftovers(c, sites);
        if (added.length > 0 || left.length > 0) {
            throw new DeployError(
                `Something appeared or remained while removing the sites: ${[...added, ...left].join(", ")}. ` +
                    ".local-deploy/ is kept; run down again.",
            );
        }
    } else {
        try {
            sites = await readInventoryFile(c);
        } catch (error) {
            if (error instanceof InventoryError)
                throw new DeployError(
                    `${error.message} Nothing was removed.${inventoryHint(error)}`,
                );
            throw error;
        }
    }

    if (resources.containers.length === 0) {
        // The project's containers are gone, but a site container may still sit on the apps
        // network: the same ownership-checked cleanup, without a Dokku to ask.
        for (const site of sites) {
            aborted(d, true);
            await destroySite(c, null, site);
        }
    }
    aborted(d, true);
    if (hasResources) {
        for (const container of await confirmed(c, await labeledContainers(c))) {
            must(await docker(c, ["rm", "-f", container.id]), "Removing a container");
        }
        if ((await d.fs.stat(layout.file("compose.env"))) === null) {
            throw new DeployError("compose.env is missing, so Compose cannot remove the project.");
        }
        must(
            await compose(c, ["down", "--volumes", "--remove-orphans"]),
            "Removing the Compose project",
        );
    }
    if ((await networkOwner(c, appsNetwork(project))) === "ours") {
        must(await docker(c, ["network", "rm", appsNetwork(project)]), "Removing the apps network");
    }

    aborted(d, true);
    d.log("Removing the root-owned state...");
    await removeStateChildren(c);
    aborted(d, true);

    for (const tag of Object.values(projectImages(project))) {
        if (await imageExists(c, tag))
            must(await docker(c, ["image", "rm", tag]), "Removing an image");
    }
    for (const site of sites) {
        checkSiteName(site);
        await removeImages(c, await siteImages(c, site));
    }

    aborted(d, true);
    const envText = await d.fs.readFile(layout.file("compose.env"));
    if (envText !== null) {
        try {
            await d.removeProfile(
                `http://127.0.0.1:${portsFromEnv(parseEnv(envText)).controller}`,
                record.state?.profileSetByUp === true,
            );
        } catch {
            d.log(
                `Could not remove the CLI profile ${PROFILE}; run: launchpad logout --profile ${PROFILE}.`,
            );
        }
    }
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
    for (const tag of Object.values(projectImages(project))) {
        if (await imageExists(c, tag)) remaining.push(`image ${tag}`);
    }
    for (const name of FIXED_CHILDREN) {
        if (await d.fs.stat(layout.file(name))) remaining.push(`directory ${layout.file(name)}`);
    }
    if (remaining.length > 0) {
        throw new DeployError(
            `Not everything was removed: ${remaining.join(", ")}. ${layout.dir} is kept so down can run again.`,
        );
    }

    // The record goes last, so an interruption never leaves a directory that looks foreign.
    for (const name of [
        "compose.env",
        "override.json",
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
        `Removed project ${project}: its containers, volumes, network, images and ${STATE_DIR}/.`,
    );
    d.log(
        "Pulled base images and the build cache stay (docker image prune, docker builder prune).",
    );
}

// ---- command line ------------------------------------------------------------------------

export const COMMANDS = ["up", "status", "down"] as const;
export const VALUE_FLAGS = ["--project", "--port-base"] as const;
export const SWITCH_FLAGS = ["--new-key", "--help"] as const;

export const HELP = `Deploy examples/hello on this machine and remove it again (see docs/local-deploy.md).

Usage: omni -i run local:deploy -a "options=<command> [flags]"

  up        build, start and seed a Compose project, everything on 127.0.0.1
  status    show service health, ports and the profile; refresh the recorded inventory
  down      remove this project's containers, volumes, network, images, sites and ${STATE_DIR}/

  --project <name>    project name (default launchpad-local-<8 hex of this checkout's path>;
                      must match ${PROJECT_PATTERN.source})
  --port-base <n>     first of the five host ports (default ${DEFAULT_PORT_BASE}; offsets 0, 1, 2, 42, 263; up only)
  --new-key           up only: issue a replacement key for the local-deploy profile (needed if its
                      saved key lacks the scopes deploying needs)
  --help              show this text

This mounts the host Docker socket into the worker and Dokku, which is root-equivalent on this
machine. Secrets stay in ${STATE_DIR}/ (mode 700, git-ignored) and are never printed.
`;

export interface Parsed {
    newKey?: boolean;
    command: (typeof COMMANDS)[number] | null;
    project?: string;
    portBase?: number;
    help: boolean;
}

export function parseArgs(argv: string[]): Parsed {
    const parsed: Parsed = { command: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if ((COMMANDS as readonly string[]).includes(arg) && parsed.command === null) {
            parsed.command = arg as Parsed["command"];
        } else if (arg === "--new-key") {
            parsed.newKey = true;
        } else if (arg === "--help") {
            parsed.help = true;
        } else if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
            const value = argv[++i];
            if (value === undefined || value.startsWith("--")) {
                throw new DeployError(`${arg} needs a value.`);
            }
            if (arg === "--project") parsed.project = checkProject(value);
            else {
                if (!/^[0-9]+$/.test(value)) throw new DeployError("--port-base must be a number.");
                parsed.portBase = checkPortBase(Number(value));
            }
        } else {
            throw new DeployError(`Unknown argument ${arg}. Run with --help to list the commands.`);
        }
    }
    if (!parsed.help && parsed.command === null) {
        throw new DeployError("Say what to do: up, status or down (see --help).");
    }
    if ((parsed.portBase !== undefined || parsed.newKey) && parsed.command !== "up") {
        throw new DeployError("--port-base and --new-key only apply to up.");
    }
    return parsed;
}

function interruptible(): AbortController {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return controller;
}

export function realDeps(
    repo: string,
    version: string,
    signal: AbortSignal,
    env: Record<string, string | undefined> = process.env,
): Deps {
    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });
    return {
        run: (args, input) =>
            spawnExec(args, input, args.includes("build") ? 45 * 60_000 : undefined),
        fetch,
        fs: realFs,
        env,
        log: (line) => console.log(line),
        sleep,
        now: Date.now,
        probePort,
        currentProfile: async () =>
            (await createContext(env, { fetch }).store.load()).currentProfile ?? null,
        removeProfile: async (controller, resetCurrent) => {
            const ctx = createContext(env, { fetch });
            const config = await ctx.store.load();
            if (config.profiles[PROFILE]?.controller !== controller) return;
            await ctx.store.update((current) => {
                delete current.profiles[PROFILE];
                if (current.currentProfile === PROFILE) {
                    // `up` made it current because none existed: none is current again. If the
                    // user chose it themselves, the first remaining profile takes over instead of
                    // a dangling name.
                    current.currentProfile = resetCurrent
                        ? null
                        : (Object.keys(current.profiles)[0] ?? null);
                }
            });
        },
        uid: process.getuid?.() ?? -1,
        repo,
        version,
        signal,
    };
}

export async function main(argv: string[]): Promise<number> {
    try {
        const parsed = parseArgs(argv);
        if (parsed.help) {
            console.log(HELP);
            return 0;
        }
        if (process.platform !== "linux") {
            throw new DeployError("Only Linux with native Docker Engine is supported.");
        }
        const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
            cwd: path.resolve(import.meta.dirname, ".."),
            stdout: "pipe",
            stderr: "ignore",
        });
        if (!top.success) throw new DeployError("Run this inside the repository checkout.");
        const repo = await realpath(top.stdout.toString().trim());
        const { version } = await Bun.file(path.join(repo, "package.json")).json();
        const controller = interruptible();
        const deps = realDeps(
            repo,
            typeof version === "string" ? version : "unknown",
            controller.signal,
        );
        if (parsed.command === "up") await up(deps, parsed);
        else if (parsed.command === "status") await status(deps, parsed);
        else await down(deps, parsed);
        return 0;
    } catch (error) {
        console.error(
            error instanceof DeployError ||
                error instanceof SeedError ||
                error instanceof ClientCoreError
                ? error.message
                : "The command failed unexpectedly.",
        );
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
