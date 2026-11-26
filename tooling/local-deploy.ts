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
import { createServer } from "node:net";
import path from "node:path";
import { interpolate, loadRaw, requiredVariables } from "./compose-production";
import type { RunResult } from "./local-seed";

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

export function parseInventory(text: string): Site[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new InventoryError("inventory.json is not valid JSON.");
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
}

export function parseState(text: string): State | null {
    try {
        const s = JSON.parse(text) as Partial<State>;
        if (
            typeof s.project === "string" &&
            typeof s.repo === "string" &&
            typeof s.version === "string"
        ) {
            return { project: s.project, repo: s.repo, version: s.version };
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
            "docs/production-fresh-host-recovery.md#repeat-the-rehearsal for combinations that were observed to work."
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
