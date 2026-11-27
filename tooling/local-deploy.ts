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
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ClientCoreError, configDirectory, createContext } from "../packages/client-core/src/index";
import { flagsOf, keyOf, optionHelp, parseOrFail, toolCommand, type Opt } from "./cli";
import { COMPOSE_FILE, interpolate, loadRaw, requiredVariables } from "./compose-production";
import {
    appsNetwork,
    checkDirectory,
    checkDocker,
    checkOwnDirectory,
    checkProject as checkProjectFor,
    checkRecord,
    composeHint as composeHintFor,
    composePrefix as composePrefixFor,
    compose,
    conflictsWithoutRecord,
    classifyDbQuery,
    DB_QUERY,
    DeployError,
    docker,
    DOCKER_HOST,
    DOCKER_SOCKET,
    ensureDirectory,
    freePorts,
    generateSecrets,
    IMAGE_FORMAT,
    imageTagFor,
    InventoryError,
    LABEL_APP,
    LABEL_ONEOFF,
    LABEL_PROJECT,
    LABEL_SERVICE,
    LABEL_TEMPLATE,
    layoutFor as layoutForState,
    mergeSites,
    must,
    NAME,
    NETWORK_LABEL_TEMPLATE,
    NETWORK_MEMBERS_TEMPLATE,
    outOf,
    parseDatabaseRows,
    parseEnv,
    parseInventory,
    parseSocketGid,
    parseState,
    probePort,
    projectNameFor as projectNameForPrefix,
    PS_FORMAT,
    readInventoryFile,
    readState,
    realFs,
    renderEnv,
    renderInventory,
    serviceHealth,
    siteFromRow,
    spawnExec,
    STATE_FORMAT,
    summarizeDockerProblems,
    teardown,
    waitHealthy,
    writeInventory,
    writeState,
    type BaseDeps,
    type Ctx,
    type Fs,
    type FsStat,
    type Labeled,
    type Layout,
    type Profile,
    type Secrets,
    type Site,
    type State,
} from "./local-docker";
import {
    scopesFor,
    parseArgs as parseSeedArgs,
    seed,
    SeedError,
    adminArgs,
    classifyAdmin,
    type AdminMode,
} from "./local-seed";

// What the specs and callers of this tool used before the shared module existed.
export {
    appsNetwork,
    DeployError,
    DOCKER_HOST,
    DOCKER_SOCKET,
    generateSecrets,
    IMAGE_FORMAT,
    imageTagFor,
    InventoryError,
    LABEL_APP,
    LABEL_ONEOFF,
    LABEL_PROJECT,
    LABEL_SERVICE,
    LABEL_TEMPLATE,
    mergeSites,
    NAME,
    NETWORK_LABEL_TEMPLATE,
    NETWORK_MEMBERS_TEMPLATE,
    parseDatabaseRows,
    parseEnv,
    parseInventory,
    parseSocketGid,
    parseState,
    probePort,
    PS_FORMAT,
    realFs,
    renderEnv,
    renderInventory,
    siteFromRow,
    spawnExec,
    STATE_FORMAT,
    summarizeDockerProblems,
};
export type { Fs, FsStat, Labeled, Layout, Secrets, Site, State };

export interface Deps extends BaseDeps {
    // Deletes the profile if it names this controller; resets the current profile only when asked.
    removeProfile: (controller: string, resetCurrent: boolean) => Promise<void>;
    currentProfile: () => Promise<string | null>;
    // The seed, replaceable so a test need not run a controller.
    seed?: typeof seed;
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

const CLEAN_EXTRAS = new Set([
    "compose.env",
    "override.json",
    "inventory.json",
    "inventory.json.next",
    "state.json.next",
]);

const SERVICES = ["postgres", "dokku", "controller", "worker", "router"] as const;

export const DEPLOY_PROFILE: Profile = {
    stateDir: STATE_DIR,
    version: TOOL_VERSION,
    projectPrefix: "launchpad-local-",
    projectPattern: PROJECT_PATTERN,
    fixedChildren: FIXED_CHILDREN,
    stateFiles: STATE_FILES,
    cleanExtras: CLEAN_EXTRAS,
    imageTags: (project) => Object.values(projectImages(project)),
    services: SERVICES,
    writers: ["controller", "worker"],
    composeFiles: (layout) => ["-f", COMPOSE_FILE, "-f", layout.file("override.json")],
    removeCommand: "down",
    portAdvice: (persisted) =>
        persisted
            ? "Run down, then up again with --port-base <n> to move."
            : "Pass --port-base <n> to choose another range (offsets 0, 1, 2, 42 and 263).",
};

export const projectNameFor = (repoPath: string) =>
    projectNameForPrefix(repoPath, DEPLOY_PROFILE.projectPrefix);
export const checkProject = (name: string) => checkProjectFor(DEPLOY_PROFILE, name);
export const layoutFor = (repo: string) => layoutForState(repo, STATE_DIR);
export const composePrefix = (layout: Layout, project: string) =>
    composePrefixFor({ layout, project, profile: DEPLOY_PROFILE });
export const composeHint = (layout: Layout, project: string, args: string) =>
    composeHintFor({ layout, project, profile: DEPLOY_PROFILE }, args);

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
    const c: Ctx = { d, layout, project, profile: DEPLOY_PROFILE };
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
            scopes: scopesFor(parseEnv((await d.fs.readFile(layout.file("compose.env"))) ?? "")),
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
        const c0: Ctx = { d, layout, project: "", profile: DEPLOY_PROFILE };
        return readState(c0);
    })();
    const project = checkProject(
        options.project ?? record.state?.project ?? projectNameFor(d.repo),
    );
    const c: Ctx = { d, layout, project, profile: DEPLOY_PROFILE };
    if (record.kind === "ok") checkRecord(c, record.state!);
    return { c, state: record.kind === "ok" ? record.state! : null };
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
    const dbState = classifyDbQuery(query);
    if (dbState === "no-schema") {
        d.log(
            "PostgreSQL is running but the schema has not been migrated yet (up has not completed); the recorded inventory was kept as it is. Run `up` again.",
        );
        return;
    }
    if (dbState === "unreachable") {
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

export async function down(d: Deps, options: UpOptions = {}): Promise<void> {
    await teardown(d, DEPLOY_PROFILE, options, {
        async afterImages(c, state) {
            const envText = await d.fs.readFile(c.layout.file("compose.env"));
            if (envText === null) return;
            try {
                await d.removeProfile(
                    `http://127.0.0.1:${portsFromEnv(parseEnv(envText)).controller}`,
                    state?.profileSetByUp === true,
                );
            } catch {
                d.log(
                    `Could not remove the CLI profile ${PROFILE}; run: launchpad logout --profile ${PROFILE}.`,
                );
            }
        },
    });
}

// ---- command line ------------------------------------------------------------------------

export const COMMANDS = ["up", "status", "down"] as const;
// The single source of options: commander, the two flag lists below (the documentation tests
// read them) and the option list of HELP.
export const OPTIONS: Opt[] = [
    {
        flag: "--project",
        arg: "name",
        help: `project name (default launchpad-local-<8 hex of this checkout's path>;\nmust match ${PROJECT_PATTERN.source})`,
    },
    {
        flag: "--port-base",
        arg: "n",
        help: `first of the five host ports (default ${DEFAULT_PORT_BASE}; offsets 0, 1, 2, 42, 263; up only)`,
    },
    {
        flag: "--new-key",
        help: "up only: issue a replacement key for the local-deploy profile (needed if its\nsaved key lacks the scopes deploying needs, or was revoked)",
    },
    { flag: "--help", help: "show this text" },
];
export const VALUE_FLAGS: readonly string[] = flagsOf(OPTIONS).value;
export const SWITCH_FLAGS: readonly string[] = flagsOf(OPTIONS).switch;

export const HELP = `Deploy examples/hello on this machine and remove it again (see docs/local-deploy.md).

Usage: omni -i run local:deploy -a "options=<command> [flags]"

  up        build, start and seed a Compose project, everything on 127.0.0.1
  status    show service health, ports and the profile; refresh the recorded inventory
  down      remove this project's containers, volumes, network, images, sites and ${STATE_DIR}/

${optionHelp(OPTIONS, 20)}

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
    const unknownArgument = (token: string) =>
        `Unknown argument ${token}. Run with --help to list the commands.`;
    const program = toolCommand("local-deploy", OPTIONS).argument("[command]");
    const opts = parseOrFail(program, argv, (message) => new DeployError(message), {
        unknownOption: unknownArgument,
        rejectDashValues: "--",
    });
    const [word, ...rest] = program.args;
    if (word !== undefined && !(COMMANDS as readonly string[]).includes(word)) {
        throw new DeployError(unknownArgument(word));
    }
    if (rest.length > 0) throw new DeployError(unknownArgument(rest[0]!));
    const parsed: Parsed = { command: (word as Parsed["command"]) ?? null, help: false };
    if (opts.newKey === true) parsed.newKey = true;
    if (opts.help === true) parsed.help = true;
    const project = opts[keyOf("--project")] as string | undefined;
    if (project !== undefined) parsed.project = checkProject(project);
    const portBase = opts[keyOf("--port-base")] as string | undefined;
    if (portBase !== undefined) {
        if (!/^[0-9]+$/.test(portBase)) throw new DeployError("--port-base must be a number.");
        parsed.portBase = checkPortBase(Number(portBase));
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
