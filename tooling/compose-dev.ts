// Checks of docker-compose.dev.yaml, the development infrastructure (PostgreSQL, the Adminer SQL
// client, Mailpit, Dokku and the alias router). Like compose-production.ts, the same assertions run on the raw YAML
// interpolated here (a unit test, no Docker) and on `docker compose config` output
// (`bun tooling/compose-dev.ts`, part of the check:compose task). Nothing is started.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    COMPOSE_FILE as PRODUCTION_FILE,
    interpolate,
    mountOf,
    parseEnvFile,
    portOf,
    ENV_EXAMPLE,
    type Env,
} from "./compose-production";

type Json = any;

const root = path.resolve(import.meta.dirname, "..");
export const DEV_COMPOSE_FILE = path.join(root, "docker-compose.dev.yaml");

// What dev:infra:up generates, with example values.
export const DEV_EXAMPLE: Env = {
    POSTGRES_PASSWORD: "example-password",
    LAUNCHPAD_ALIAS_INSTANCE_ID: "11111111-2222-4333-8444-555555555555",
    LAUNCHPAD_APPS_DOMAIN: "apps.localhost",
    LAUNCHPAD_APPS_NETWORK: "launchpad-dev-example-apps",
    DOKKU_DATA_DIR: "/example/checkout/.dev-infra/dokku",
    DEV_PROJECT: "launchpad-dev-example",
};

export const DEV_SERVICES = ["adminer", "dokku", "mailpit", "postgres", "router"];
// Compose accepts `b`, `k`/`kb`, `m`/`mb`, `g`/`gb` (and the `ib` spellings); the rendered model
// gives plain bytes. Anything else is unknown, not zero, so a wrong unit cannot pass as small.
const COMPOSE_UNITS: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
};
const bytesOfMemory = (value: unknown): number | undefined => {
    const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)\s*$/i.exec(String(value ?? ""));
    if (!m) return undefined;
    const unit = COMPOSE_UNITS[(m[2] || "b").toLowerCase()];
    if (unit === undefined) return undefined;
    const bytes = Number(m[1]) * unit;
    return Number.isFinite(bytes) ? bytes : undefined;
};
const LOOPBACK = "127.0.0.1";
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const BUILT = ["dokku", "router"];

export function loadDevRaw(): Json {
    return Bun.YAML.parse(readFileSync(DEV_COMPOSE_FILE, "utf8"));
}

const environmentOf = (service: Json): Record<string, string> =>
    Object.fromEntries(
        Object.entries(service.environment ?? {}).map(([key, value]) => [key, String(value)]),
    );

const publishedOf = (service: Json) => (service.ports ?? []).map(portOf);

/** The dev file's own rules; `model` is the rendered (or interpolated) file. */
export function assertDev(model: Json, env: Env = DEV_EXAMPLE): string[] {
    const problems: string[] = [];
    const fail = (message: string) => problems.push(message);
    const services: Record<string, Json> = model.services ?? {};

    if (JSON.stringify(Object.keys(services).sort()) !== JSON.stringify(DEV_SERVICES)) {
        fail(`The services must be exactly ${DEV_SERVICES.join(", ")}.`);
    }
    for (const [name, service] of Object.entries(services)) {
        if (service.env_file) fail(`${name} uses env_file; list its environment explicitly.`);
        if (service.profiles) fail(`${name} is in a profile; dev starts every service.`);
        if (service.privileged) fail(`${name} is privileged.`);
        for (const port of publishedOf(service)) {
            if (port.ip !== LOOPBACK) {
                fail(`${name} publishes ${port.target} on ${port.ip || "all interfaces"}.`);
            }
        }
        if (name !== "dokku") {
            const socket = (service.volumes ?? [])
                .map(mountOf)
                .some((m: { source: string }) => m.source.includes("docker.sock"));
            if (socket) fail(`${name} mounts the Docker socket; only dokku may.`);
        }
        if (!BUILT.includes(name)) {
            const image = String(service.image ?? "");
            if (!DIGEST.test(image)) fail(`${name}: ${image} is not pinned by digest.`);
        } else {
            const expected = `${env.DEV_PROJECT}/${name}:local`;
            if (service.image !== expected) {
                fail(`${name}: image must be ${expected}, not ${service.image}.`);
            }
            if (service.build?.labels?.["com.launchpad.dev-project"] !== env.DEV_PROJECT) {
                fail(`${name}: the build must label the image com.launchpad.dev-project.`);
            }
        }
    }

    const ports = (name: string) =>
        publishedOf(services[name] ?? {}).map((p: { published: string; target: number }) => [
            p.published,
            p.target,
        ]);
    const expectPorts = (name: string, expected: [string, number][]) => {
        if (JSON.stringify(ports(name)) !== JSON.stringify(expected)) {
            fail(
                `${name} must publish ${JSON.stringify(expected)}, not ${JSON.stringify(ports(name))}.`,
            );
        }
    };
    const at = (key: string, fallback: string) => env[key] ?? fallback;
    expectPorts("postgres", [[at("DEV_POSTGRES_PORT", "35432"), 5432]]);
    expectPorts("adminer", [[at("DEV_ADMINER_PORT", "38080"), 8080]]);
    expectPorts("mailpit", [
        [at("DEV_SMTP_PORT", "31025"), 1025],
        [at("DEV_MAILPIT_UI_PORT", "38025"), 8025],
    ]);
    expectPorts("dokku", [
        [at("DEV_DOKKU_SSH_PORT", "33222"), 22],
        [at("DEV_DOKKU_HTTP_PORT", "33181"), 80],
    ]);
    expectPorts("router", [
        [at("DEV_ROUTER_DATA_PORT", "33182"), 3080],
        [at("DEV_ROUTER_CONTROL_PORT", "33183"), 3081],
    ]);

    const router = environmentOf(services.router ?? {});
    if (router.LAUNCHPAD_ROUTER_CONTROL_LISTEN !== "0.0.0.0:3081") {
        fail("The router control plane must listen on 0.0.0.0:3081 inside its container.");
    }
    if (router.LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK !== "1") {
        fail(
            "The router control plane on 0.0.0.0 needs LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK=1.",
        );
    }
    for (const name of Object.keys(router)) {
        if (name.startsWith("LAUNCHPAD_ROUTER_CONTROL_TLS")) {
            fail(`${name} is set: dev control is plain HTTP on loopback, with no certificates.`);
        }
    }
    if (router.LAUNCHPAD_APPS_PROXY_URL !== "http://dokku:80") {
        fail("The router must reach Dokku at http://dokku:80.");
    }
    if ((services.dokku?.volumes ?? []).map(mountOf).length !== 2) {
        fail("dokku must mount exactly its state directory and the Docker socket.");
    }
    if (services.dokku?.restart || services.postgres?.restart) {
        fail("Dev services have no restart policy.");
    }
    if (!services.mailpit?.healthcheck) fail("mailpit needs a healthcheck.");
    if ((services.mailpit?.volumes ?? []).length > 0) fail("mailpit keeps no data.");
    if (!services.adminer?.healthcheck) fail("adminer needs a healthcheck.");
    if ((services.adminer?.volumes ?? []).length > 0) fail("adminer keeps no data.");
    for (const name of ["dokku", "postgres", "adminer"]) {
        if (!services[name]?.mem_limit) fail(`${name} needs a memory limit.`);
    }
    // Above PHP's own memory_limit = 1G, so a dump import hits PHP's guard rather than the cgroup.
    // The raw file says `1536m`; `docker compose config` renders bytes, so compare sizes.
    const adminerMemory = bytesOfMemory(services.adminer?.mem_limit);
    if (services.adminer?.mem_limit !== undefined && adminerMemory === undefined)
        fail(`adminer: mem_limit ${services.adminer.mem_limit} is not a byte size Compose knows.`);
    if (adminerMemory !== undefined && adminerMemory <= 1024 ** 3)
        fail(
            `adminer: mem_limit must be above 1 GiB (PHP's own memory_limit), not ${services.adminer?.mem_limit}.`,
        );
    for (const name of Object.keys(model.networks ?? {})) {
        if (model.networks[name]?.internal) fail(`${name} is internal: the host must reach it.`);
    }
    if (model.networks?.apps?.name !== env.LAUNCHPAD_APPS_NETWORK) {
        fail("The apps network must have the fixed name from LAUNCHPAD_APPS_NETWORK.");
    }
    return problems;
}

/**
 * The parts of the dev file that must stay equal to docker-compose.yaml: the PostgreSQL image and
 * healthcheck, the Dokku build, environment, mounts and healthcheck, and the router build and
 * healthcheck. Both models are interpolated with the same values for the shared variables.
 */
export function assertMatchesProduction(dev: Json, production: Json): string[] {
    const problems: string[] = [];
    const same = (what: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            problems.push(`${what} differs from docker-compose.yaml.`);
        }
    };
    const d = dev.services ?? {};
    const p = production.services ?? {};
    same("The PostgreSQL image", d.postgres?.image, p.postgres?.image);
    same("The PostgreSQL environment", d.postgres?.environment, p.postgres?.environment);
    same("The PostgreSQL healthcheck", d.postgres?.healthcheck, p.postgres?.healthcheck);
    same("The Dokku build context", d.dokku?.build?.context, p.dokku?.build?.context);
    same("The Dokku Dockerfile", d.dokku?.build?.dockerfile, p.dokku?.build?.dockerfile);
    same("The Dokku build arguments", d.dokku?.build?.args, p.dokku?.build?.args);
    same("The Dokku environment", d.dokku?.environment, p.dokku?.environment);
    same("The Dokku healthcheck", d.dokku?.healthcheck, p.dokku?.healthcheck);
    same("The Dokku mounts", d.dokku?.volumes?.map(mountOf), p.dokku?.volumes?.map(mountOf));
    same("The router build context", d.router?.build?.context, p.router?.build?.context);
    same("The router Dockerfile", d.router?.build?.dockerfile, p.router?.build?.dockerfile);
    same("The router healthcheck", d.router?.healthcheck, p.router?.healthcheck);
    return problems;
}

/** The production file, interpolated with the example settings but the dev values where they are shared. */
function productionModel(env: Env): Json {
    const example = parseEnvFile(readFileSync(ENV_EXAMPLE, "utf8"));
    const shared = {
        ...example,
        LAUNCHPAD_APPS_DOMAIN: env.LAUNCHPAD_APPS_DOMAIN!,
        DOKKU_DATA_DIR: env.DOKKU_DATA_DIR!,
        POSTGRES_PASSWORD: env.POSTGRES_PASSWORD!,
    };
    return interpolate(Bun.YAML.parse(readFileSync(PRODUCTION_FILE, "utf8")), shared);
}

export function checkRaw(env: Env = DEV_EXAMPLE): string[] {
    const dev = interpolate(loadDevRaw(), env);
    return [...assertDev(dev, env), ...assertMatchesProduction(dev, productionModel(env))];
}

async function run(command: string[], env: Record<string, string>) {
    const process = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    return { out, err, code };
}

// `docker compose config` renders only; it starts nothing. The environment is minimal on purpose.
export async function checkRendered(): Promise<string[]> {
    const clean = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const directory = mkdtempSync(path.join(tmpdir(), "compose-dev-"));
    try {
        const envFile = path.join(directory, "compose.env");
        writeFileSync(
            envFile,
            Object.entries(DEV_EXAMPLE)
                .map(([key, value]) => `${key}=${value}\n`)
                .join(""),
            { mode: 0o600 },
        );
        const base = ["docker", "compose", "-f", DEV_COMPOSE_FILE];
        const rendered = await run(
            [...base, "--env-file", envFile, "config", "--format", "json"],
            clean,
        );
        if (rendered.code !== 0) return [`docker compose config failed: ${rendered.err.trim()}`];
        const dev = JSON.parse(rendered.out);
        // The equality with docker-compose.yaml is compared on the raw files: the rendered forms
        // normalise durations and paths differently for each file.
        const problems = [...assertDev(dev), ...checkRaw()];
        const bare = await run([...base, "--env-file", "/dev/null", "config", "--quiet"], clean);
        if (bare.code === 0) problems.push("The file rendered without any settings.");
        return problems;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const problems = await checkRendered();
    if (problems.length > 0) {
        console.error(problems.map((problem) => `- ${problem}`).join("\n"));
        process.exit(1);
    }
    console.log("docker-compose.dev.yaml: rendered and checked (nothing was started).");
}
