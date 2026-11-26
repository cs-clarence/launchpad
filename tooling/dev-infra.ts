// Starts and removes the development infrastructure of docker-compose.dev.yaml (PostgreSQL,
// Mailpit, Dokku, the alias router) so that the controller, worker and CLI can run on the host.
//
//   omni -i run dev:infra:up       [-a "options=--preset deploy"]
//   omni -i run dev:infra:status
//   omni -i run dev:infra:down     stop everything, keep the data
//   omni -i run dev:infra:destroy  remove everything this created
//
// State lives in <repo>/.dev-infra/ (git-ignored, mode 700). Secrets are only in mode-600 files
// there and are never printed. The generated settings for the host apps are written to
// .dev-infra/env/; this tool never writes an app's own .env.local. Dokku holds the host Docker
// socket, which is root-equivalent on this machine. See docs/local-dev-infra.md.
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ClientCoreError, configDirectory } from "../packages/client-core/src/index";
import { flagsOf, keyOf, optionHelp, parseOrFail, toolCommand, type Opt } from "./cli";
import { loadRaw, interpolate } from "./compose-production";
import { DEV_COMPOSE_FILE } from "./compose-dev";
import {
    APP_CONTAINER,
    appsNetwork,
    checkDirectory,
    checkDocker,
    checkOwnDirectory,
    checkProject as checkProjectFor,
    checkRecord,
    compose,
    composeHint as composeHintFor,
    composePrefix as composePrefixFor,
    conflictsWithoutRecord,
    DB_QUERY,
    DeployError,
    docker,
    ensureDirectory,
    freePorts,
    generateSecrets,
    inspectLabel,
    InventoryError,
    LABEL_APP,
    layoutFor as layoutForState,
    lines,
    mergeSites,
    must,
    networkOwner,
    NETWORK_MEMBERS_TEMPLATE,
    outOf,
    parseDatabaseRows,
    parseEnv,
    probePort,
    projectNameFor as projectNameForPrefix,
    readInventoryFile,
    readState,
    realFs,
    renderEnv,
    serviceHealth,
    spawnExec,
    teardown,
    waitForDokkuToSettle,
    waitHealthy,
    writeInventory,
    type BaseDeps,
    type Ctx,
    type Layout,
    type Profile,
    type Site,
} from "./local-docker";
import {
    ALIAS_KEY_SCOPES,
    DEPLOY_KEY_SCOPES,
    KEY_SCOPES,
    parseArgs as parseSeedArgs,
    seed,
    SeedError,
    spawnRun,
} from "./local-seed";

export const TOOL_VERSION = "1";
export const STATE_DIR = ".dev-infra";
export const PROJECT_PREFIX = "launchpad-dev-";
export const PROJECT_PATTERN = /^launchpad-dev-[a-z0-9-]{1,40}$/;
export const IMAGE_SERVICES = ["dokku", "router"] as const;
export const SERVICES = ["postgres", "mailpit", "dokku", "router"] as const;
export const FIXED_CHILDREN = ["dokku", "credentials", "data", "env"] as const;
export const IMAGE_LABEL = "com.launchpad.dev-project";
export const APPS_DOMAIN = "apps.localhost";
export const APP_MODE_BASE_URL = "http://127.0.0.1:3000";
export const DEPLOY_MODE_BASE_URL = "https://control.localhost:8443";
export const CONTROLLER_URL = "http://127.0.0.1:3000";
export const SEED_PROFILE = "dev-infra";
export const SMTP_FROM = "Launchpad <launchpad@localhost>";
export const PRESETS = ["app", "deploy"] as const;
export type Preset = (typeof PRESETS)[number];

// ---- ports ---------------------------------------------------------------------------------

export interface Ports {
    postgres: number;
    smtp: number;
    mailpit: number;
    ssh: number;
    http: number;
    routerData: number;
    routerControl: number;
}

export const PORT_DEFAULTS: Ports = {
    postgres: 35432,
    smtp: 31025,
    mailpit: 38025,
    ssh: 33222,
    http: 33181,
    routerData: 33182,
    routerControl: 33183,
};

// The same names docker-compose.dev.yaml reads.
export const PORT_KEYS: Record<keyof Ports, string> = {
    postgres: "DEV_POSTGRES_PORT",
    smtp: "DEV_SMTP_PORT",
    mailpit: "DEV_MAILPIT_UI_PORT",
    ssh: "DEV_DOKKU_SSH_PORT",
    http: "DEV_DOKKU_HTTP_PORT",
    routerData: "DEV_ROUTER_DATA_PORT",
    routerControl: "DEV_ROUTER_CONTROL_PORT",
};

function checkPort(key: string, value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const port = Number(value);
    if (!/^[0-9]+$/.test(value) || port < 1024 || port > 65535) {
        throw new DeployError(`${key} must be a whole number from 1024 to 65535.`);
    }
    if (port === 3000 || port === 5432 || port === 55432 || (port >= 32180 && port <= 32443)) {
        throw new DeployError(
            `${key}=${port} is reserved (3000 is the controller, 5432 and 55432 are the quickstart and ` +
                "test databases, 32180 to 32443 belong to local:deploy). Choose another port.",
        );
    }
    return port;
}

// Defaults, each replaceable by an environment variable of the same name the Compose file reads.
export function portsFrom(env: Record<string, string | undefined>): Ports {
    const ports = {} as Ports;
    for (const name of Object.keys(PORT_KEYS) as (keyof Ports)[]) {
        ports[name] = checkPort(PORT_KEYS[name], env[PORT_KEYS[name]], PORT_DEFAULTS[name]);
    }
    if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
        throw new DeployError("The seven host ports must all be different.");
    }
    return ports;
}

function portsFromRecord(env: Record<string, string>): Ports {
    const ports = {} as Ports;
    for (const name of Object.keys(PORT_KEYS) as (keyof Ports)[]) {
        const key = PORT_KEYS[name];
        const n = Number(env[key]);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) {
            throw new DeployError(`compose.env has no valid ${key}; run destroy, then up again.`);
        }
        ports[name] = n;
    }
    return ports;
}

// ---- pure planning -------------------------------------------------------------------------

export const projectNameFor = (repoPath: string) => projectNameForPrefix(repoPath, PROJECT_PREFIX);
export const projectImages = (project: string) =>
    Object.fromEntries(IMAGE_SERVICES.map((s) => [s, `${project}/${s}:local`])) as Record<
        (typeof IMAGE_SERVICES)[number],
        string
    >;
export const layoutFor = (repo: string) => layoutForState(repo, STATE_DIR);

export const DEV_PROFILE: Profile = {
    stateDir: STATE_DIR,
    version: TOOL_VERSION,
    projectPrefix: PROJECT_PREFIX,
    projectPattern: PROJECT_PATTERN,
    fixedChildren: FIXED_CHILDREN,
    stateFiles: ["compose.env"],
    cleanExtras: new Set([
        "compose.env",
        "inventory.json",
        "inventory.json.next",
        "state.json.next",
    ]),
    imageTags: (project) => Object.values(projectImages(project)),
    imageLabel: IMAGE_LABEL,
    services: SERVICES,
    writers: [],
    composeFiles: () => ["-f", DEV_COMPOSE_FILE],
    removeCommand: "destroy",
    portAdvice: (persisted) =>
        persisted
            ? "Run destroy, then up again with other DEV_*_PORT values to move."
            : "Set the DEV_*_PORT variable named in docker-compose.dev.yaml to another port.",
};

export const checkProject = (name: string) => checkProjectFor(DEV_PROFILE, name);
export const composePrefix = (layout: Layout, project: string) =>
    composePrefixFor({ layout, project, profile: DEV_PROFILE });
export const composeHint = (layout: Layout, project: string, args: string) =>
    composeHintFor({ layout, project, profile: DEV_PROFILE }, args);

export function composeEnv(
    layout: Layout,
    project: string,
    ports: Ports,
    secrets: { postgresPassword: string; authSecret: string; instanceId: string },
    version: string,
): Record<string, string> {
    const env: Record<string, string> = {
        POSTGRES_PASSWORD: secrets.postgresPassword,
        LAUNCHPAD_ALIAS_INSTANCE_ID: secrets.instanceId,
        LAUNCHPAD_APPS_DOMAIN: APPS_DOMAIN,
        LAUNCHPAD_APPS_NETWORK: appsNetwork(project),
        DOKKU_DATA_DIR: layout.file("dokku"),
        DEV_PROJECT: project,
        LAUNCHPAD_VERSION: version,
        // Not read by Compose: kept here so every `up` renders the same controller settings.
        DEV_AUTH_SECRET: secrets.authSecret,
    };
    for (const name of Object.keys(PORT_KEYS) as (keyof Ports)[]) {
        env[PORT_KEYS[name]] = String(ports[name]);
    }
    return env;
}

// Host and port exactly as the worker's knownHostsName writes them for a non-default port.
export const knownHostsLine = (port: number, hostKey: string) => `[127.0.0.1]:${port} ${hostKey}\n`;

const GENERATED = [
    "credentials/epoch",
    "credentials/known_hosts",
    "credentials/token",
    "credentials/id_ed25519",
    "credentials/id_ed25519.pub",
] as const;

export function sshKeygen(layout: Layout): string[] {
    return [
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        layout.file("credentials/id_ed25519"),
    ];
}

const quote = (value: string) => (/[\s<>]/.test(value) ? `"${value}"` : value);
export const renderApp = (env: Record<string, string>) =>
    Object.entries(env)
        .map(([k, v]) => `${k}=${quote(v)}\n`)
        .join("");

export function nginxBaseImage(): string {
    const value = interpolate(loadRaw().services.worker.environment.LAUNCHPAD_BASE_IMAGE, {});
    if (typeof value !== "string" || !/^nginx:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(value)) {
        throw new DeployError("Cannot read the pinned base image from docker-compose.yaml.");
    }
    return value;
}

export interface AppEnv {
    controller: Record<string, string>;
    // Only the deploy preset needs a worker.
    worker: Record<string, string> | null;
}

// The settings of the controller and the worker on the host. `compose` is the parsed compose.env.
export function appEnv(
    layout: Layout,
    compose: Record<string, string>,
    preset: Preset,
    aliases: boolean,
    baseImage = nginxBaseImage(),
): AppEnv {
    const ports = portsFromRecord(compose);
    const common = {
        DATABASE_URL: `postgresql://launchpad:${compose.POSTGRES_PASSWORD}@127.0.0.1:${ports.postgres}/launchpad`,
        LAUNCHPAD_DATA_DIR: layout.file("data"),
    };
    const routing = {
        LAUNCHPAD_APPS_DOMAIN: APPS_DOMAIN,
        LAUNCHPAD_ALIAS_INSTANCE_ID: compose.LAUNCHPAD_ALIAS_INSTANCE_ID!,
        LAUNCHPAD_ALIAS_CONTROL_URL: `http://127.0.0.1:${ports.routerControl}`,
        LAUNCHPAD_APPS_PROXY_URL: `http://127.0.0.1:${ports.http}`,
        LAUNCHPAD_ALIAS_PROBE_URL: `http://127.0.0.1:${ports.routerData}`,
        LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: layout.file("credentials/token"),
        LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: layout.file("credentials/epoch"),
    };
    const deploy = preset === "deploy";
    const controller: Record<string, string> = {
        ...common,
        LAUNCHPAD_AUTH_SECRET: compose.DEV_AUTH_SECRET!,
        LAUNCHPAD_BASE_URL: deploy ? DEPLOY_MODE_BASE_URL : APP_MODE_BASE_URL,
        LAUNCHPAD_DEPLOYMENTS: deploy ? "on" : "off",
        LAUNCHPAD_ENROLLMENT: "invitation",
        LAUNCHPAD_SMTP_URL: `smtp://127.0.0.1:${ports.smtp}`,
        LAUNCHPAD_EMAIL_FROM: SMTP_FROM,
        HOST: "127.0.0.1",
        PORT: "3000",
    };
    if (!deploy) return { controller, worker: null };
    controller.LAUNCHPAD_ALIASES = aliases ? "on" : "off";
    Object.assign(controller, routing);
    const worker: Record<string, string> = {
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_ALIASES: aliases ? "on" : "off",
        ...common,
        LAUNCHPAD_BASE_URL: DEPLOY_MODE_BASE_URL,
        ...routing,
        DOKKU_SSH_HOST: "127.0.0.1",
        DOKKU_SSH_PORT: String(ports.ssh),
        DOKKU_SSH_USER: "dokku",
        DOKKU_SSH_KEY_PATH: layout.file("credentials/id_ed25519"),
        DOKKU_SSH_KNOWN_HOSTS_PATH: layout.file("credentials/known_hosts"),
        LAUNCHPAD_BASE_IMAGE: baseImage,
    };
    return { controller, worker };
}

// ---- seams ---------------------------------------------------------------------------------

export interface Deps extends BaseDeps {
    seed?: typeof seed;
}

// ---- up ------------------------------------------------------------------------------------

export interface UpOptions {
    project?: string;
    preset?: Preset;
    aliases?: boolean;
}

async function verifyCredentials(c: Ctx): Promise<void> {
    const f = c.layout.file;
    await checkOwnDirectory(c, "credentials", 0o700);
    const problems: string[] = [];
    for (const [name, secret] of [
        ["credentials/id_ed25519", true],
        ["credentials/id_ed25519.pub", false],
        ["credentials/known_hosts", false],
        ["credentials/token", true],
        ["credentials/epoch", false],
    ] as const) {
        const stat = await c.d.fs.stat(f(name));
        if (!stat || !stat.isFile) problems.push(`${name} is missing or not a file`);
        else if (secret && (stat.mode & 0o077) !== 0) problems.push(`${name} must be mode 600`);
    }
    const dokku = await c.d.fs.stat(f("dokku"));
    if (!dokku || dokku.isSymlink || !dokku.isDirectory) {
        problems.push("dokku is missing or not a real directory");
    }
    if (problems.length > 0) {
        throw new DeployError(`${problems.join("; ")}. Run destroy, then up again.`);
    }
}

async function generateCredentials(c: Ctx): Promise<void> {
    const { d, layout } = c;
    const f = layout.file;
    const epoch = await d.fs.stat(f("credentials/epoch"));
    if (epoch && epoch.size > 0) {
        throw new DeployError(
            "The credentials are incomplete but the router was already initialised; run destroy, then up again.",
        );
    }
    await ensureDirectory(c, "dokku", 0o755);
    for (const name of ["credentials", "data", "env"]) await ensureDirectory(c, name, 0o700);
    for (const name of GENERATED) {
        try {
            await d.fs.unlink(f(name));
        } catch {
            throw new DeployError(
                `Could not remove ${f(name)} (is it a directory?). Remove it by hand, then run up again.`,
            );
        }
    }
    await d.fs.writeFile(f("credentials/epoch"), "", 0o600, true);
    await d.fs.writeFile(f("credentials/known_hosts"), "", 0o600, true);
    await d.fs.writeFile(
        f("credentials/token"),
        `${randomBytes(32).toString("hex")}\n`,
        0o600,
        true,
    );
    const generated = await d.run(sshKeygen(layout));
    if (generated.code !== 0) {
        throw new DeployError(
            `Generating the worker's SSH key failed (exit ${generated.code}); is ssh-keygen installed?`,
        );
    }
}

async function bootstrapDokkuAndRouter(c: Ctx, ports: Ports): Promise<void> {
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
    await d.fs.writeFile(f("credentials/known_hosts"), knownHostsLine(ports.ssh, hostKey), 0o600);
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
        "If it says state exists, run destroy and up again.",
    );
    const epoch = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/.exec(outOf(init))?.[0];
    if (!epoch) throw new DeployError("The router did not print an epoch.");
    await d.fs.writeFile(f("credentials/epoch"), `${epoch}\n`, 0o600);
}

export interface Summary {
    project: string;
    ports: Ports;
    preset: Preset;
    aliases: boolean;
    controllerEnv: string;
    workerEnv: string | null;
}

// destroy reads the same record and refuses it too, so it is not the way out.
const unreadableMessage = (layout: Layout) =>
    `${layout.file("state.json")} is unreadable. Restore it, or remove the project's resources by exact ` +
    `name (docker ps -a --filter label=com.docker.compose.project=<project>, then docker rm -f, docker ` +
    `volume rm, docker network rm and docker image rm on what you created), then delete ${layout.dir} ` +
    "(its dokku/ child is root-owned: sudo rm -rf).";

async function ensureIgnored(d: BaseDeps, layout: Layout): Promise<void> {
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
}

export async function up(d: Deps, options: UpOptions = {}): Promise<Summary> {
    const layout = layoutFor(d.repo);
    const preset = options.preset ?? "app";
    const aliases = options.aliases ?? true;
    const first = await readState({ d, layout, project: "", profile: DEV_PROFILE });
    if (first.kind === "corrupt") throw new DeployError(unreadableMessage(layout));
    const project = checkProject(options.project ?? first.state?.project ?? projectNameFor(d.repo));
    const c: Ctx = { d, layout, project, profile: DEV_PROFILE };
    await checkDocker(d);
    await ensureIgnored(d, layout);

    const dirStat = await checkDirectory(c);
    const record = await readState(c);
    if (record.kind === "corrupt") throw new DeployError(unreadableMessage(layout));
    if (record.kind === "ok") checkRecord(c, record.state!);
    else if (dirStat && (await d.fs.readdir(layout.dir)).length > 0) {
        throw new DeployError(
            `${layout.dir} exists without a state.json; refusing to reuse it. Run destroy first.`,
        );
    }
    if (record.kind !== "ok") await conflictsWithoutRecord(c);

    // The record comes first: an interrupted up always leaves what destroy needs.
    if (!dirStat) await d.fs.mkdir(layout.dir, 0o700);
    if (record.kind !== "ok") {
        try {
            // Exclusive, so a concurrent up for another project cannot replace this record.
            await d.fs.writeFile(
                layout.file("state.json"),
                JSON.stringify({ project, repo: layout.repo, version: TOOL_VERSION }),
                0o600,
                true,
            );
        } catch {
            throw new DeployError(
                `${layout.file("state.json")} appeared while starting: is another up running? Nothing was changed.`,
            );
        }
    }

    const envText = await d.fs.readFile(layout.file("compose.env"));
    let ports: Ports;
    if (envText === null) {
        ports = portsFrom(d.env);
        await freePorts(c, ports, false);
        const env = composeEnv(layout, project, ports, generateSecrets(), d.version);
        await d.fs.writeFile(layout.file("compose.env"), renderEnv(env), 0o600, true);
    } else {
        ports = portsFromRecord(parseEnv(envText));
        await freePorts(c, ports, true);
    }
    const key = await d.fs.stat(layout.file("credentials/id_ed25519"));
    const pub = await d.fs.stat(layout.file("credentials/id_ed25519.pub"));
    if (key === null || pub === null) await generateCredentials(c);
    await verifyCredentials(c);
    await checkOwnDirectory(c, "data", 0o700);
    await checkOwnDirectory(c, "env", 0o700);

    d.log("Building the Dokku and router images (the slow part on a first run)...");
    must(
        await compose(c, ["build", "--builder", "default", "dokku", "router"]),
        "Building the images",
        `See: ${composeHint(layout, project, "build dokku router")}`,
    );
    d.log("Starting PostgreSQL, Mailpit and Dokku (Dokku's first start takes minutes)...");
    must(
        await compose(c, ["up", "-d", "--no-build", "postgres", "mailpit", "dokku"]),
        "Starting PostgreSQL, Mailpit and Dokku",
    );
    await waitHealthy(c, "postgres", 7 * 60_000);
    await waitHealthy(c, "mailpit", 2 * 60_000);
    await waitHealthy(c, "dokku", 11 * 60_000);

    const epoch = await d.fs.stat(layout.file("credentials/epoch"));
    if (!epoch || epoch.size === 0) {
        d.log("Pinning Dokku's host key, registering the worker's key, initialising the router...");
        await bootstrapDokkuAndRouter(c, ports);
    }

    d.log("Starting the router...");
    must(await compose(c, ["up", "-d", "--no-build"]), "Starting the services");
    await waitHealthy(c, "router", 7 * 60_000);

    const compose2 = parseEnv((await d.fs.readFile(layout.file("compose.env"))) ?? "");
    const rendered = appEnv(layout, compose2, preset, aliases);
    const controllerEnv = layout.file("env/controller.env");
    await d.fs.writeFile(controllerEnv, renderApp(rendered.controller), 0o600);
    const workerEnv = layout.file("env/worker.env");
    if (rendered.worker) {
        await d.fs.writeFile(workerEnv, renderApp(rendered.worker), 0o600);
    } else {
        await d.fs.unlink(workerEnv);
    }
    const summary: Summary = {
        project,
        ports,
        preset,
        aliases,
        controllerEnv,
        workerEnv: rendered.worker ? workerEnv : null,
    };
    printSummary(d, summary);
    return summary;
}

function printSummary(d: BaseDeps, s: Summary): void {
    const p = s.ports;
    d.log("");
    d.log(`Project ${s.project} is up. Everything listens on 127.0.0.1 only:`);
    d.log(`  PostgreSQL     127.0.0.1:${p.postgres}  (user and database launchpad)`);
    d.log(`  Mailpit SMTP   127.0.0.1:${p.smtp}`);
    d.log(`  Mailpit web    http://127.0.0.1:${p.mailpit}`);
    d.log(`  Dokku SSH      127.0.0.1:${p.ssh}`);
    d.log(`  Dokku HTTP     http://127.0.0.1:${p.http}  (send a Host header, see the guide)`);
    d.log(`  router (data)  http://127.0.0.1:${p.routerData}`);
    d.log(`  router control http://127.0.0.1:${p.routerControl}  (plain HTTP, loopback only)`);
    d.log("");
    d.log(
        `Settings for the host apps (preset ${s.preset}${s.preset === "deploy" ? `, aliases ${s.aliases ? "on" : "off"}` : ""}); secrets are in these files, not printed:`,
    );
    d.log(`  install -m 600 ${s.controllerEnv} apps/controller/.env.local`);
    if (s.workerEnv) d.log(`  install -m 600 ${s.workerEnv} apps/worker/.env.local`);
    d.log("Then run the controller (omni -i run dev -p @launchpad-kit/controller)");
    if (s.workerEnv) d.log("and the worker (omni -i run dev -p @launchpad-kit/worker).");
    d.log("Seed with: omni -i run dev:infra:seed");
    d.log("To stop and keep the data: dev:infra:down. To remove everything: dev:infra:destroy.");
}

// ---- status --------------------------------------------------------------------------------

async function loadContext(d: BaseDeps, options: { project?: string }) {
    const layout = layoutFor(d.repo);
    const record = await readState({ d, layout, project: "", profile: DEV_PROFILE });
    if (record.kind === "corrupt") throw new DeployError(unreadableMessage(layout));
    const project = checkProject(
        options.project ?? record.state?.project ?? projectNameFor(d.repo),
    );
    const c: Ctx = { d, layout, project, profile: DEV_PROFILE };
    if (record.kind === "ok") checkRecord(c, record.state!);
    return { c, state: record.kind === "ok" ? record.state! : null };
}

export async function status(d: Deps, options: { project?: string } = {}): Promise<void> {
    await checkDocker(d);
    const { c, state } = await loadContext(d, options);
    if (!state) throw new DeployError(`No ${STATE_DIR}/state.json here: run up first.`);
    await checkDirectory(c);
    const envText = await d.fs.readFile(c.layout.file("compose.env"));
    if (envText === null) throw new DeployError("compose.env is missing; run destroy, then up.");
    const ports = portsFromRecord(parseEnv(envText));
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
        d.log(`  ${service.padEnd(9)} ${health}`);
    }
    d.log(
        `Ports (127.0.0.1): PostgreSQL ${ports.postgres}, Mailpit ${ports.smtp}/${ports.mailpit}, ` +
            `Dokku SSH ${ports.ssh}, HTTP ${ports.http}, router ${ports.routerData}/${ports.routerControl}`,
    );
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

// ---- down ----------------------------------------------------------------------------------

// Dokku's site containers sit outside the Compose project and keep running after `compose stop`.
// Only containers on this project's apps network whose name and Dokku app label agree are stopped.
async function stopSites(c: Ctx): Promise<number> {
    const network = appsNetwork(c.project);
    if ((await networkOwner(c, network)) !== "ours") return 0;
    const members = must(
        await docker(c, ["network", "inspect", "-f", NETWORK_MEMBERS_TEMPLATE, network]),
        `Listing the members of ${network}`,
    );
    let stopped = 0;
    for (const name of lines(outOf(members))) {
        const app = APP_CONTAINER.exec(name)?.[1];
        if (!app) continue;
        if ((await inspectLabel(c, name, LABEL_APP)) !== app) continue;
        must(
            await docker(c, ["stop", "--time", "30", name]),
            `Stopping a site container of ${app}`,
        );
        stopped++;
    }
    return stopped;
}

export async function down(d: Deps, options: { project?: string } = {}): Promise<void> {
    if ((await docker({ d }, ["version", "--format", "{{.Server.Version}}"])).code !== 0) {
        throw new DeployError("The Docker daemon did not answer. Nothing was stopped.");
    }
    const { c, state } = await loadContext(d, options);
    if (!state) {
        d.log(`No ${STATE_DIR}/state.json here: nothing to stop.`);
        return;
    }
    await checkDirectory(c);
    if ((await d.fs.stat(c.layout.file("compose.env"))) === null) {
        throw new DeployError("compose.env is missing; run destroy.");
    }
    const running = must(
        await docker(c, [
            "ps",
            "--filter",
            `label=com.docker.compose.project=${c.project}`,
            "--filter",
            "label=com.docker.compose.service=dokku",
            "--format",
            "{{.ID}}",
        ]),
        "Looking for the Dokku container",
    );
    const dokkuId = lines(outOf(running))[0];
    if (dokkuId) await waitForDokkuToSettle(c, dokkuId);
    const sites = await stopSites(c);
    d.log(`Stopped ${sites} site container${sites === 1 ? "" : "s"}.`);
    must(await compose(c, ["stop"]), "Stopping the services");
    d.log(
        `Stopped project ${c.project}. The database, Dokku state, credentials and images are kept: ` +
            "run up to start it again, destroy to remove everything.",
    );
}

// ---- destroy -------------------------------------------------------------------------------

export async function destroy(d: Deps, options: { project?: string } = {}): Promise<void> {
    await teardown(d, DEV_PROFILE, options, {
        // `down` leaves Dokku stopped; it is needed to list and destroy the sites.
        async startDokku(c) {
            must(
                await compose(c, ["up", "-d", "--no-build", "postgres", "dokku"]),
                "Starting PostgreSQL and Dokku",
            );
            await waitHealthy(c, "postgres", 7 * 60_000);
            await waitHealthy(c, "dokku", 11 * 60_000);
        },
    });
    d.log(
        "The apps' own .env.local files were not touched; remove the ones you copied from .dev-infra/env.",
    );
}

// ---- seed ----------------------------------------------------------------------------------

export function seedScopes(controllerEnv: Record<string, string>): string[] {
    if (controllerEnv.LAUNCHPAD_DEPLOYMENTS !== "on") return KEY_SCOPES;
    return controllerEnv.LAUNCHPAD_ALIASES === "on" ? ALIAS_KEY_SCOPES : DEPLOY_KEY_SCOPES;
}

// Seeds the host controller (which must be running with the generated settings): migrations,
// operator, owner, an organization, a project and a CLI profile whose key can deploy.
export async function seedController(d: Deps, options: { newKey?: boolean } = {}): Promise<void> {
    const layout = layoutFor(d.repo);
    const text = await d.fs.readFile(layout.file("env/controller.env"));
    if (text === null) throw new DeployError("No .dev-infra/env/controller.env: run up first.");
    const env = parseEnv(text.replaceAll('"', ""));
    const config = path.resolve(configDirectory(d.env));
    const parsed = parseSeedArgs([
        "--controller",
        CONTROLLER_URL,
        "--origin",
        env.LAUNCHPAD_BASE_URL ?? APP_MODE_BASE_URL,
        "--profile",
        SEED_PROFILE,
        "--operator-password-file",
        path.join(config, "dev-infra-operator.password"),
        "--owner-password-file",
        path.join(config, "dev-infra-owner.password"),
        ...(options.newKey ? ["--new-key"] : []),
    ]);
    await (d.seed ?? seed)(
        {
            fetch: d.fetch,
            run: d.run,
            env: d.env,
            log: d.log,
            sleep: d.sleep,
            now: d.now,
            scopes: seedScopes(env),
            keyName: SEED_PROFILE,
        },
        parsed,
    );
}

// ---- command line --------------------------------------------------------------------------

export const COMMANDS = ["up", "status", "down", "destroy", "logs", "seed"] as const;
export const OPTIONS: Opt[] = [
    {
        flag: "--project",
        arg: "name",
        help: `project name (default launchpad-dev-<8 hex of this checkout's path>;\nmust match ${PROJECT_PATTERN.source})`,
    },
    {
        flag: "--preset",
        arg: "kind",
        help: "up only: app (dashboard and Mailpit, deployments off; default) or deploy\n(deployments on, CLI and API only)",
    },
    {
        flag: "--aliases",
        arg: "on|off",
        help: "up only, with --preset deploy: the aliases switch in the settings (default on)",
    },
    { flag: "--service", arg: "name", help: "logs only: one service (default all)" },
    {
        flag: "--new-key",
        help: "seed only: issue a replacement key for the dev-infra profile",
    },
    { flag: "--help", help: "show this text" },
];
export const VALUE_FLAGS: readonly string[] = flagsOf(OPTIONS).value;
export const SWITCH_FLAGS: readonly string[] = flagsOf(OPTIONS).switch;

export const HELP = `Run the development infrastructure on this machine (see docs/local-dev-infra.md).

Usage: omni -i run dev:infra:<command> [-a "options=<flags>"]

  up        build and start PostgreSQL, Mailpit, Dokku and the router, write the app settings
  status    show service health, ports and the number of recorded deployments
  down      stop everything and keep the data (database, Dokku state, credentials, images)
  destroy   remove everything this created: sites, containers, volumes, network, images, ${STATE_DIR}/
  logs      follow the Compose logs
  seed      migrate and seed the running host controller (operator, owner, organization, project, key)

${optionHelp(OPTIONS, 20)}

This mounts the host Docker socket into Dokku, which is root-equivalent on this machine. Secrets
stay in ${STATE_DIR}/ (mode 700, git-ignored) and are never printed.
`;

export interface Parsed {
    command: (typeof COMMANDS)[number] | null;
    project?: string;
    preset?: Preset;
    aliases?: boolean;
    service?: string;
    newKey?: boolean;
    help: boolean;
}

export function parseArgs(argv: string[]): Parsed {
    const unknownArgument = (token: string) =>
        `Unknown argument ${token}. Run with --help to list the commands.`;
    const program = toolCommand("dev-infra", OPTIONS).argument("[command]");
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
    if (opts.help === true) parsed.help = true;
    if (opts.newKey === true) parsed.newKey = true;
    const project = opts[keyOf("--project")] as string | undefined;
    if (project !== undefined) parsed.project = checkProject(project);
    const preset = opts[keyOf("--preset")] as string | undefined;
    if (preset !== undefined) {
        if (!(PRESETS as readonly string[]).includes(preset)) {
            throw new DeployError("--preset must be app or deploy.");
        }
        parsed.preset = preset as Preset;
    }
    const aliases = opts[keyOf("--aliases")] as string | undefined;
    if (aliases !== undefined) {
        if (aliases !== "on" && aliases !== "off")
            throw new DeployError("--aliases must be on or off.");
        parsed.aliases = aliases === "on";
    }
    const service = opts[keyOf("--service")] as string | undefined;
    if (service !== undefined) {
        if (!(SERVICES as readonly string[]).includes(service)) {
            throw new DeployError(`--service must be one of ${SERVICES.join(", ")}.`);
        }
        parsed.service = service;
    }
    if (!parsed.help && parsed.command === null) {
        throw new DeployError(
            "Say what to do: up, status, down, destroy, logs or seed (see --help).",
        );
    }
    if ((parsed.preset !== undefined || parsed.aliases !== undefined) && parsed.command !== "up") {
        throw new DeployError("--preset and --aliases only apply to up.");
    }
    if (parsed.aliases !== undefined && parsed.preset !== "deploy") {
        throw new DeployError("--aliases only applies with --preset deploy.");
    }
    if (parsed.service !== undefined && parsed.command !== "logs") {
        throw new DeployError("--service only applies to logs.");
    }
    if (parsed.newKey && parsed.command !== "seed") {
        throw new DeployError("--new-key only applies to seed.");
    }
    return parsed;
}

export function logsArgs(layout: Layout, project: string, service?: string): string[] {
    return [
        ...composePrefix(layout, project),
        "logs",
        "--tail",
        "100",
        "-f",
        ...(service ? [service] : []),
    ];
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
            args[0] === "omni"
                ? spawnRun(args, input)
                : spawnExec(args, input, args.includes("build") ? 45 * 60_000 : undefined),
        fetch,
        fs: realFs,
        env,
        log: (line) => console.log(line),
        sleep,
        now: Date.now,
        probePort,
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
        else if (parsed.command === "down") await down(deps, parsed);
        else if (parsed.command === "destroy") await destroy(deps, parsed);
        else if (parsed.command === "seed") await seedController(deps, parsed);
        else {
            const { c } = await loadContext(deps, parsed);
            const proc = Bun.spawn(logsArgs(c.layout, c.project, parsed.service), {
                stdin: "ignore",
                stdout: "inherit",
                stderr: "inherit",
                env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
            });
            return await proc.exited;
        }
        return 0;
    } catch (error) {
        console.error(
            error instanceof DeployError ||
                error instanceof SeedError ||
                error instanceof ClientCoreError ||
                error instanceof InventoryError
                ? error.message
                : "The command failed unexpectedly.",
        );
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
