// Seeds a local controller for development: migrates the database, creates an operator and an
// owner, an organization and a project, issues an API key and saves it as a CLI profile.
//
//   omni -i run local:seed                                     (defaults)
//   omni -i run local:seed -a "options=--org acme --profile acme"
//
// It talks to a controller you started yourself and runs the operator commands through Omni.
// It never starts a server or a database. No password or key is printed or put in an argument
// or the environment: passwords live in mode-600 files, and the key goes straight into the
// credential store through the same `login` the CLI uses. See docs/local-quickstart.md.
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LaunchpadApiError } from "../packages/sdk/src/index";
import {
    ClientCoreError,
    configDirectory,
    createContext,
    login,
    whoami,
} from "../packages/client-core/src/index";

export class SeedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SeedError";
    }
}

export const DEFAULT_CONTROLLER = "http://127.0.0.1:5173";
export const KEY_DAYS = 90;
const KEY_NAME = "local-quickstart";
// What the guide's walkthrough needs: whoami, reading and creating projects, reading apps.
export const KEY_SCOPES = ["organization:read", "project:read", "project:create", "app:read"];
const ADMIN_PROJECT = "@launchpad-kit/controller";
const FILE_SAFE = /^[A-Za-z0-9_@.+/~-]+$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export interface Options {
    controller: string;
    origin: string;
    org: string;
    project: string;
    operatorEmail: string;
    ownerEmail: string;
    profile: string;
    out: string | undefined;
    operatorPasswordFile: string | undefined;
    ownerPasswordFile: string | undefined;
    newKey: boolean;
    force: boolean;
    allowRemote: boolean;
    help: boolean;
}

// Each flag takes a value except the booleans listed after it. The documentation test reads this
// table, so a flag the guide names must exist here.
export const VALUE_FLAGS = [
    "--controller",
    "--origin",
    "--org",
    "--project",
    "--operator-email",
    "--owner-email",
    "--profile",
    "--out",
    "--operator-password-file",
    "--owner-password-file",
] as const;
export const SWITCH_FLAGS = ["--new-key", "--force", "--allow-remote", "--help"] as const;

export const HELP = `Seed a local Launchpad controller (see docs/local-quickstart.md).

Usage: omni -i run local:seed [-a "options=<flags>"]

  --controller <url>             controller to seed (default ${DEFAULT_CONTROLLER})
  --origin <origin>              origin to send; must equal LAUNCHPAD_BASE_URL (default: the controller's)
  --org <slug>                   organization slug (default local)
  --project <slug>               project slug (default demo)
  --operator-email <email>       operator account (default operator@launchpad.local)
  --owner-email <email>          organization owner account (default owner@launchpad.local)
  --profile <name>               CLI profile to save the key in (default local)
  --out <dir>                    directory for password files and the credential store (default: $LAUNCHPAD_CONFIG_DIR, $XDG_CONFIG_HOME/launchpad or ~/.config/launchpad); must be a directory you own
  --operator-password-file <f>   mode-600 file holding the operator password (default <out>/local-operator.password)
  --owner-password-file <f>      mode-600 file holding the owner password (default <out>/local-owner.password)
  --new-key                      issue another API key and replace the profile's key
  --force                        replace a profile that is not this controller's working profile
  --allow-remote                 allow a controller that is not on this machine (https only)
  --help                         show this text

Re-running is safe: an existing operator, owner, organization, project and working profile are
reused. Passwords and keys are never printed; password files are never overwritten.
`;

export function parseArgs(argv: string[]): Options {
    const values = new Map<string, string>();
    const switches = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        if ((SWITCH_FLAGS as readonly string[]).includes(flag)) {
            switches.add(flag);
        } else if ((VALUE_FLAGS as readonly string[]).includes(flag)) {
            const value = argv[++i];
            if (value === undefined || value.startsWith("--")) {
                throw new SeedError(`${flag} needs a value.`);
            }
            values.set(flag, value);
        } else {
            throw new SeedError(`Unknown option ${flag}. Run with --help to list the options.`);
        }
    }
    const controller = values.get("--controller") ?? DEFAULT_CONTROLLER;
    const options: Options = {
        controller,
        origin: values.get("--origin") ?? controller,
        org: values.get("--org") ?? "local",
        project: values.get("--project") ?? "demo",
        operatorEmail: values.get("--operator-email") ?? "operator@launchpad.local",
        ownerEmail: values.get("--owner-email") ?? "owner@launchpad.local",
        profile: values.get("--profile") ?? "local",
        out: values.get("--out"),
        operatorPasswordFile: values.get("--operator-password-file"),
        ownerPasswordFile: values.get("--owner-password-file"),
        newKey: switches.has("--new-key"),
        force: switches.has("--force"),
        allowRemote: switches.has("--allow-remote"),
        help: switches.has("--help"),
    };
    if (!options.help) validate(options);
    return options;
}

function validate(options: Options): void {
    if (!SLUG.test(options.org)) {
        throw new SeedError("--org must be lowercase letters, digits and hyphens (40 at most).");
    }
    if (!SLUG.test(options.project)) {
        throw new SeedError(
            "--project must be lowercase letters, digits and hyphens (40 at most).",
        );
    }
    for (const [flag, email] of [
        ["--operator-email", options.operatorEmail],
        ["--owner-email", options.ownerEmail],
    ] as const) {
        if (!EMAIL.test(email)) throw new SeedError(`${flag} must be an email address.`);
    }
    if (options.operatorEmail.toLowerCase() === options.ownerEmail.toLowerCase()) {
        throw new SeedError("The operator and the owner need different email addresses.");
    }
    if (!PROFILE.test(options.profile)) {
        throw new SeedError("--profile is letters, digits, _ . - (40 at most).");
    }
    // Paths reach the admin commands through Omni's shell, so only plain characters are allowed.
    for (const [flag, file] of [
        ["--out", options.out],
        ["--operator-password-file", options.operatorPasswordFile],
        ["--owner-password-file", options.ownerPasswordFile],
    ] as const) {
        if (file !== undefined && !FILE_SAFE.test(file)) {
            throw new SeedError(
                `${flag} may only contain letters, digits and _ @ . + / ~ - (no spaces or quotes).`,
            );
        }
    }
}

export function isLoopbackHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

// The controller must be an origin. http is only for this machine, and anything else needs
// --allow-remote (and https).
export function checkController(value: string, allowRemote: boolean): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new SeedError("--controller must be a URL such as http://127.0.0.1:5173.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new SeedError("--controller must be an http or https URL.");
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new SeedError("--controller must be an origin: no credentials, path or query.");
    }
    const loopback = isLoopbackHost(url.hostname);
    if (!loopback && !allowRemote) {
        throw new SeedError(
            `${url.origin} is not on this machine. This script creates accounts and a key; ` +
                "pass --allow-remote only if you mean to seed a remote controller.",
        );
    }
    if (!loopback && url.protocol !== "https:") {
        throw new SeedError("A controller that is not on this machine must use https.");
    }
    return url.origin;
}

export function checkOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new SeedError("--origin must be an origin such as http://127.0.0.1:5173.");
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/") {
        throw new SeedError("--origin must be an http or https origin with no path.");
    }
    return url.origin;
}

// ---- operator commands -------------------------------------------------------------------

export type RunResult = { code: number; output: string };
export type Run = (args: string[]) => Promise<RunResult>;

export function adminArgs(command: string, options: string[]): string[] {
    return [
        "omni",
        "-i",
        "run",
        "admin",
        "-p",
        ADMIN_PROJECT,
        "-a",
        `command=${command}`,
        ...(options.length > 0 ? ["-a", `options=${options.join(" ")}`] : []),
    ];
}

function adminHint(command: string): string {
    return `omni -i run admin -p ${ADMIN_PROJECT} -a command=${command}`;
}

export type AdminOutcome = "done" | "exists";

// The child's output is never echoed: it is only matched, so a message from the database driver
// cannot carry a connection string into this script's output.
export function classifyAdmin(command: string, result: RunResult): AdminOutcome {
    if (result.code === 0) return "done";
    const text = result.output;
    if (command !== "migrate" && /already exists/i.test(text)) return "exists";
    if (/DATABASE_URL is required/.test(text)) {
        throw new SeedError(
            "DATABASE_URL is not set. Copy apps/controller/.env.local.example to " +
                "apps/controller/.env.local and fill it in.",
        );
    }
    if (
        /ECONNREFUSED|ENOTFOUND|password authentication failed|database "[^"]*" does not exist/i.test(
            text,
        )
    ) {
        throw new SeedError(
            `${command} could not use the database. Check DATABASE_URL in apps/controller/.env.local ` +
                "and that PostgreSQL is running.",
        );
    }
    if (/Invalid authentication configuration/.test(text)) {
        throw new SeedError(
            `${command} stopped on the LAUNCHPAD_* settings. Check LAUNCHPAD_AUTH_SECRET (32 or ` +
                "more characters) and LAUNCHPAD_BASE_URL in apps/controller/.env.local.",
        );
    }
    if (/password must be/i.test(text)) {
        throw new SeedError(
            `${command} refused the password: it must be 12 to 128 characters. Fix the password file.`,
        );
    }
    throw new SeedError(
        `${command} failed (exit ${result.code}). Run it directly to see why: ${adminHint(command)}`,
    );
}

export async function spawnRun(args: string[]): Promise<RunResult> {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
    } catch {
        throw new SeedError("Could not run omni. Install Omni and put it on your PATH.");
    }
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 120_000);
    try {
        const [out, err, code] = await Promise.all([
            new Response(proc.stdout as ReadableStream).text(),
            new Response(proc.stderr as ReadableStream).text(),
            proc.exited,
        ]);
        return { code, output: `${out}\n${err}` };
    } finally {
        clearTimeout(deadline);
    }
}

// ---- password files ----------------------------------------------------------------------

export function generatePassword(): string {
    return randomBytes(24).toString("base64url");
}

async function modeOf(file: string) {
    try {
        return await lstat(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function readPasswordFile(file: string): Promise<string | null> {
    const stat = await modeOf(file);
    if (!stat) return null;
    if (!stat.isFile()) throw new SeedError(`${file} is not a regular file.`);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new SeedError(`${file} is readable by other users; run chmod 600 on it.`);
    }
    return (await readFile(file, "utf8")).replace(/\r?\n$/, "");
}

// One absolute path is used both by this script and by `admin` (which runs in apps/controller
// through a shell), so it is resolved here and only the resolved form is checked and passed on.
export function resolvePath(file: string, home: string = homedir()): string {
    if (file.startsWith("~") && file !== "~" && !file.startsWith("~/")) {
        throw new SeedError(
            `${file}: only ~ and ~/... are expanded, not ~user; use an absolute path.`,
        );
    }
    const expanded =
        file === "~" ? home : file.startsWith("~/") ? path.join(home, file.slice(2)) : file;
    const resolved = path.resolve(expanded);
    if (!FILE_SAFE.test(resolved)) {
        throw new SeedError(
            `${resolved} may only contain letters, digits and _ @ . + / ~ - (no spaces or quotes); ` +
                "choose another location with --out.",
        );
    }
    return resolved;
}

// The directory holding passwords and the key must be ours alone: not a link, not writable by others.
export async function ensureOutDirectory(dir: string): Promise<void> {
    if (!(await modeOf(dir))) await mkdir(dir, { recursive: true, mode: 0o700 });
    // Checked after creation as well, so a link planted between the two steps is caught.
    const stat = await modeOf(dir);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new SeedError(`${dir} must be a real directory, not a link or a file.`);
    }
    if (process.platform !== "win32") {
        if (process.getuid && stat.uid !== process.getuid()) {
            throw new SeedError(`${dir} is owned by another user; use a directory you own.`);
        }
        if ((stat.mode & 0o022) !== 0) {
            throw new SeedError(`${dir} is writable by other users; run chmod 700 on it.`);
        }
    }
}

async function createPasswordFile(file: string, password: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, password, { flag: "wx", mode: 0o600 });
}

// ---- HTTP --------------------------------------------------------------------------------

export interface Api {
    controller: string;
    origin: string;
    fetch: typeof fetch;
}

async function send(api: Api, url: string, init: RequestInit): Promise<Response> {
    try {
        return await api.fetch(url, {
            ...init,
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw new SeedError(
            `Cannot reach the controller at ${api.controller}. Start it with ` +
                "`omni -i run dev -p @launchpad-kit/controller` and check --controller.",
        );
    }
}

export async function checkHealth(api: Api): Promise<void> {
    const response = await send(api, `${api.controller}/api/health`, { method: "GET" });
    await response.body?.cancel();
    if (response.status !== 200) {
        throw new SeedError(
            `${api.controller}/api/health answered ${response.status}, not 200. ` +
                "Is that the Launchpad controller?",
        );
    }
}

function failure(api: Api, what: string, status: number): SeedError {
    if (status === 403) {
        return new SeedError(
            `${what} was refused (403). The controller only accepts the origin in LAUNCHPAD_BASE_URL; ` +
                `this script sent ${api.origin}. Make them equal (see --origin), or the signed-in ` +
                "account is not allowed to do this.",
        );
    }
    if (status === 429) {
        return new SeedError(`${what} was throttled (429). Wait a minute and run it again.`);
    }
    if (status === 503) {
        return new SeedError(
            `${what} failed: the controller is not ready (503). Its database may need ` +
                `migrating or its LAUNCHPAD_DATA_DIR directory may be missing; see its log.`,
        );
    }
    return new SeedError(`${what} failed with ${status}.`);
}

export async function signIn(
    api: Api,
    who: { role: string; email: string; password: string },
): Promise<string> {
    const response = await send(api, `${api.controller}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: api.origin },
        body: JSON.stringify({ email: who.email, password: who.password }),
    });
    await response.body?.cancel();
    if (response.status === 401 || response.status === 400) {
        throw new SeedError(
            `The controller rejected the ${who.role} sign-in for ${who.email}. The password in ` +
                `the ${who.role} password file is not that account's password: write the right ` +
                "one there, or reset it with the reset-password admin command.",
        );
    }
    if (response.status !== 200) throw failure(api, `The ${who.role} sign-in`, response.status);
    const cookie = response.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
    if (!cookie) throw new SeedError(`The ${who.role} sign-in returned no session.`);
    return cookie;
}

// An error never carries a response body: the reply to a key request holds the secret.
async function call(
    api: Api,
    cookie: string,
    method: string,
    pathname: string,
    what: string,
    body?: unknown,
    slugConflict = false,
): Promise<unknown> {
    const response = await send(api, `${api.controller}/api/v1${pathname}`, {
        method,
        headers: { cookie, origin: api.origin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 409 && slugConflict) {
        throw new SeedError(`${what} was refused: that slug is already taken (409).`);
    }
    if (response.status >= 300) throw failure(api, what, response.status);
    try {
        return JSON.parse(text);
    } catch {
        throw new SeedError(`${what} returned something that is not JSON.`);
    }
}

type Slugged = { id: string; slug: string };

function slugged(value: unknown, what: string): Slugged[] {
    if (!Array.isArray(value)) throw new SeedError(`${what} returned an unexpected shape.`);
    return value.filter(
        (item): item is Slugged =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as Slugged).id === "string" &&
            typeof (item as Slugged).slug === "string",
    );
}

function idOf(value: unknown, what: string): string {
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new SeedError(`${what} returned an unexpected shape.`);
    return id;
}

export interface Workspace {
    organizationId: string;
    organizationCreated: boolean;
    projectId: string;
    projectCreated: boolean;
    ownerCookie: string;
}

// The owner finds an existing organization and project by slug; only a missing organization
// needs the operator, who is signed in lazily so an existing one never needs that password.
export async function ensureWorkspace(
    api: Api,
    input: {
        org: string;
        project: string;
        owner: { email: string; password: string };
        operator: () => Promise<{ email: string; password: string }>;
        ownerEmail: string;
    },
): Promise<Workspace> {
    let ownerCookie = await signIn(api, { role: "owner", ...input.owner });
    const orgs = slugged(
        await call(api, ownerCookie, "GET", "/organizations", "Listing organizations"),
        "Listing organizations",
    );
    let organizationId = orgs.find((org) => org.slug === input.org)?.id;
    const organizationCreated = organizationId === undefined;
    if (organizationId === undefined) {
        const operator = await input.operator();
        const operatorCookie = await signIn(api, { role: "operator", ...operator });
        organizationId = idOf(
            await call(
                api,
                operatorCookie,
                "POST",
                "/organizations",
                "Creating the organization",
                {
                    name: input.org,
                    slug: input.org,
                    ownerEmail: input.ownerEmail,
                },
                true,
            ),
            "Creating the organization",
        );
        ownerCookie = await signIn(api, { role: "owner", ...input.owner });
    }
    const base = `/organizations/${encodeURIComponent(organizationId)}`;
    const projects = slugged(
        await call(api, ownerCookie, "GET", `${base}/projects`, "Listing projects"),
        "Listing projects",
    );
    let projectId = projects.find((project) => project.slug === input.project)?.id;
    const projectCreated = projectId === undefined;
    if (projectId === undefined) {
        projectId = idOf(
            await call(
                api,
                ownerCookie,
                "POST",
                `${base}/projects`,
                "Creating the project",
                {
                    name: input.project,
                    slug: input.project,
                },
                true,
            ),
            "Creating the project",
        );
    }
    return { organizationId, organizationCreated, projectId, projectCreated, ownerCookie };
}

// Key issuance needs a sign-in from the last 15 minutes, so it signs in again first.
export async function issueKey(
    api: Api,
    organizationId: string,
    owner: { email: string; password: string },
): Promise<string> {
    const cookie = await signIn(api, { role: "owner", ...owner });
    const issued = await call(
        api,
        cookie,
        "POST",
        `/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        "Issuing the API key",
        { name: KEY_NAME, scopes: [...KEY_SCOPES], expiresInDays: KEY_DAYS },
    );
    const secret = (issued as { secret?: unknown } | null)?.secret;
    if (typeof secret !== "string" || secret.length === 0) {
        throw new SeedError("Issuing the API key returned an unexpected shape.");
    }
    return secret;
}

// ---- the whole run -----------------------------------------------------------------------

export interface Deps {
    fetch: typeof fetch;
    run: Run;
    env: Record<string, string | undefined>;
    log: (line: string) => void;
}

export interface Summary {
    organization: string;
    project: string;
    profile: string;
    keyIssued: boolean;
    passwordFiles: string[];
}

async function ensureAccount(
    deps: Deps,
    kind: "setup" | "create-user",
    role: string,
    email: string,
    file: string,
    files: string[],
): Promise<string | null> {
    let password = await readPasswordFile(file);
    const generated = password === null;
    if (password === null) {
        password = generatePassword();
        await createPasswordFile(file, password);
    }
    try {
        const outcome = classifyAdmin(
            kind,
            await deps.run(adminArgs(kind, ["--email", email, "--password-file", file])),
        );
        if (outcome === "done") deps.log(`Created the ${role} ${email}.`);
        else deps.log(`The ${role} already exists; reusing it.`);
        if (generated && outcome === "exists") {
            // The password we just wrote does not belong to the existing account.
            await unlink(file);
            return null;
        }
        if (generated) files.push(file);
        return password;
    } catch (error) {
        // A file we generated for an account that was never created would only mislead the next run.
        if (generated) await unlink(file).catch(() => undefined);
        throw error;
    }
}

async function profileIsReady(
    ctx: ReturnType<typeof createContext>,
    options: Options,
    controller: string,
    organizationId: string,
): Promise<"absent" | "ready" | "other"> {
    const config = await ctx.store.load();
    if (!Object.hasOwn(config.profiles, options.profile)) return "absent";
    const profile = config.profiles[options.profile]!;
    if (profile.controller !== controller) return "other";
    try {
        const me = await whoami(ctx, options.profile);
        return me.key.organizationId === organizationId ? "ready" : "other";
    } catch (error) {
        if (error instanceof ClientCoreError) return "other";
        // A revoked, expired or foreign key: the profile is not a working one for this controller.
        if (error instanceof LaunchpadApiError && (error.status === 401 || error.status === 403)) {
            return "other";
        }
        throw new SeedError(
            `Checking the saved profile "${options.profile}" failed; is the controller reachable?`,
        );
    }
}

export async function seed(deps: Deps, options: Options): Promise<Summary> {
    const secrets: string[] = [];
    try {
        return await seedWith(deps, options, secrets);
    } catch (error) {
        if (error instanceof SeedError) throw new SeedError(scrub(error.message, secrets));
        throw error;
    }
}

async function seedWith(deps: Deps, options: Options, secrets: string[]): Promise<Summary> {
    const controller = checkController(options.controller, options.allowRemote);
    const origin = checkOrigin(options.origin);
    const api: Api = { controller, origin, fetch: deps.fetch };
    const home = deps.env.HOME ?? homedir();
    const configured = options.out ?? configDirectory(deps.env);
    // The CLI reads these variables verbatim, so a relative or ~ value would point elsewhere for it.
    if (options.out === undefined && !path.isAbsolute(configured)) {
        throw new SeedError(
            "LAUNCHPAD_CONFIG_DIR or XDG_CONFIG_HOME is not an absolute path " +
                `(${configured}); the CLI does not expand it. Use an absolute path or pass --out.`,
        );
    }
    const out = resolvePath(configured, home);
    const operatorFile = options.operatorPasswordFile
        ? resolvePath(options.operatorPasswordFile, home)
        : path.join(out, "local-operator.password");
    const ownerFile = options.ownerPasswordFile
        ? resolvePath(options.ownerPasswordFile, home)
        : path.join(out, "local-owner.password");
    const pendingFile = path.join(out, `local-api-key.${options.profile}.pending`);
    const files: string[] = [];

    await ensureOutDirectory(out);
    for (const file of [operatorFile, ownerFile]) await ensureOutDirectory(path.dirname(file));
    await checkHealth(api);
    classifyAdmin("migrate", await deps.run(adminArgs("migrate", [])));
    deps.log("Database is migrated.");

    const operatorPassword = await ensureAccount(
        deps,
        "setup",
        "operator",
        options.operatorEmail,
        operatorFile,
        files,
    );
    const ownerPassword = await ensureAccount(
        deps,
        "create-user",
        "owner",
        options.ownerEmail,
        ownerFile,
        files,
    );
    if (ownerPassword === null) {
        throw new SeedError(
            `The owner ${options.ownerEmail} already exists, but no password file for it was found at ` +
                `${ownerFile}. Put its password there (mode 600), pass --owner-password-file, or ` +
                "choose another --owner-email.",
        );
    }
    const owner = { email: options.ownerEmail, password: ownerPassword };
    secrets.push(ownerPassword);
    if (operatorPassword !== null) secrets.push(operatorPassword);

    const workspace = await ensureWorkspace(api, {
        org: options.org,
        project: options.project,
        owner,
        ownerEmail: options.ownerEmail,
        operator: async () => {
            if (operatorPassword === null) {
                throw new SeedError(
                    `The operator already exists, but no password file for it was found at ` +
                        `${operatorFile}. Creating the organization needs it: put the password ` +
                        "there (mode 600) or pass --operator-password-file.",
                );
            }
            return { email: options.operatorEmail, password: operatorPassword };
        },
    });
    deps.log(
        `${workspace.organizationCreated ? "Created" : "Found"} the organization ${options.org}; ` +
            `${workspace.projectCreated ? "created" : "found"} the project ${options.project}.`,
    );

    const ctx = createContext({ ...deps.env, LAUNCHPAD_CONFIG_DIR: out }, { fetch: deps.fetch });
    const state = await profileIsReady(ctx, options, controller, workspace.organizationId);
    if (state === "other" && !options.force) {
        throw new SeedError(
            `The profile "${options.profile}" already exists and is not a working key for this ` +
                "controller and organization. Choose another --profile, or pass --force to replace it.",
        );
    }
    const keyIssued = state === "absent" || options.newKey || (options.force && state === "other");
    if (keyIssued) {
        if (await modeOf(pendingFile)) {
            throw new SeedError(
                `${pendingFile} holds a key from an interrupted run. Save it with ` +
                    `\`launchpad login --controller ${controller} --profile ${options.profile} ` +
                    `--key-file ${pendingFile}\`, then delete it, or just delete it, and run again.`,
            );
        }
        // Claim the file before a key exists, so a failure here costs nothing.
        try {
            await writeFile(pendingFile, "", { flag: "wx", mode: 0o600 });
        } catch {
            throw new SeedError(`Could not create ${pendingFile}; no key was issued.`);
        }
        let secret: string;
        try {
            secret = await issueKey(api, workspace.organizationId, owner);
        } catch (error) {
            await unlink(pendingFile).catch(() => undefined);
            throw error;
        }
        secrets.push(secret);
        // Stored before anything can fail: the secret is shown once.
        try {
            await writeFile(pendingFile, secret, { mode: 0o600 });
        } catch {
            throw new SeedError(
                `A key named "${KEY_NAME}" was issued but could not be stored in ${pendingFile}. ` +
                    "Revoke it in the dashboard (organization page, API keys) and run again.",
            );
        }
        try {
            await login(ctx, { controller, apiKey: secret, profile: options.profile });
        } catch (error) {
            const reason = error instanceof ClientCoreError ? ` (${error.message})` : "";
            throw new SeedError(
                `The key was issued but could not be saved as the profile "${options.profile}"` +
                    `${reason}. It is in ${pendingFile}; save it with \`launchpad login --key-file\`.`,
            );
        }
        await unlink(pendingFile);
    }
    const summary = {
        organization: options.org,
        project: options.project,
        profile: options.profile,
        keyIssued,
        passwordFiles: files,
    };
    deps.log(
        keyIssued
            ? `Saved a ${KEY_DAYS}-day API key as the CLI profile "${options.profile}" in ${out}.`
            : `The CLI profile "${options.profile}" already works; no new key issued.`,
    );
    for (const file of files) deps.log(`Wrote the generated password to ${file} (mode 600).`);
    return summary;
}

// Remove a known secret from a message, whatever produced it.
export function scrub(message: string, secrets: string[]): string {
    return secrets.reduce(
        (text, secret) => (secret ? text.split(secret).join("[redacted]") : text),
        message,
    );
}

export async function main(argv: string[]): Promise<number> {
    try {
        const options = parseArgs(argv);
        if (options.help) {
            console.log(HELP);
            return 0;
        }
        await seed(
            { fetch, run: spawnRun, env: process.env, log: (line) => console.log(line) },
            options,
        );
        return 0;
    } catch (error) {
        console.error(
            error instanceof SeedError || error instanceof ClientCoreError
                ? error.message
                : "The seed failed unexpectedly.",
        );
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
