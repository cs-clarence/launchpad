// Checks of docker-compose.yaml. The same assertions run on two views of the file: the raw YAML
// interpolated here with the example settings (a unit test, no Docker), and `docker compose config`
// output (`bun tooling/compose-production.ts`, the check:compose task). Neither starts
// anything. Passing proves the configuration has the intended shape, not that the stack works.
import { readFileSync } from "node:fs";
import path from "node:path";

type Json = any;
export type Env = Record<string, string>;

const root = path.resolve(import.meta.dirname, "..");
export const COMPOSE_FILE = path.join(root, "docker-compose.yaml");
export const ENV_EXAMPLE = path.join(root, "docker-compose.env.example");

export function parseEnvFile(text: string): Env {
    const env: Env = {};
    for (const line of text.split("\n")) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (match) env[match[1]!] = match[2]!;
    }
    return env;
}

const REFERENCE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\})/g;

// Compose interpolation for the forms this file uses: ${V}, ${V:-d}, ${V-d}, ${V:?m}, ${V?m}, $$.
export function interpolate(value: Json, env: Env, missing = new Set<string>()): Json {
    if (typeof value === "string") {
        return value.replace(REFERENCE, (_all, token, name, operator, argument) => {
            if (token === "$") return "$";
            const raw = env[name];
            const unset = raw === undefined || (operator?.startsWith(":") && raw === "");
            if (!operator) return raw ?? "";
            if (operator.endsWith("?")) {
                if (unset) missing.add(name);
                return raw ?? "";
            }
            return unset ? argument : raw!;
        });
    }
    if (Array.isArray(value)) return value.map((item) => interpolate(item, env, missing));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, interpolate(item, env, missing)]),
        );
    }
    return value;
}

export function loadRaw(): Json {
    return Bun.YAML.parse(readFileSync(COMPOSE_FILE, "utf8"));
}

export function seconds(duration: string): number {
    const parts = [...duration.matchAll(/(\d+)(h|m|s)/g)];
    if (parts.length === 0 || parts.map((part) => part[0]).join("") !== duration) {
        throw new Error(`Unreadable duration "${duration}".`);
    }
    const unit = { h: 3600, m: 60, s: 1 } as const;
    return parts.reduce((sum, part) => sum + Number(part[1]) * unit[part[2] as "h" | "m" | "s"], 0);
}

export interface Port {
    ip: string;
    published: string;
    target: number;
}

export function portOf(port: Json): Port {
    if (typeof port === "object") {
        return {
            ip: String(port.host_ip ?? ""),
            published: String(port.published ?? ""),
            target: Number(port.target),
        };
    }
    const parts = String(port)
        .replace(/\/(tcp|udp)$/, "")
        .split(":");
    if (parts.length === 3)
        return { ip: parts[0]!, published: parts[1]!, target: Number(parts[2]) };
    return { ip: "", published: parts.length === 2 ? parts[0]! : "", target: Number(parts.at(-1)) };
}

export interface Mount {
    type: "bind" | "volume" | "other";
    source: string;
    target: string;
    readOnly: boolean;
    createHostPath: boolean;
}

export function mountOf(volume: Json): Mount {
    if (typeof volume === "object") {
        return {
            type: volume.type === "bind" || volume.type === "volume" ? volume.type : "other",
            source: String(volume.source ?? ""),
            target: String(volume.target),
            readOnly: volume.read_only === true,
            // Docker creates a missing bind source unless this is false.
            createHostPath: volume.bind?.create_host_path !== false,
        };
    }
    const [source = "", target = "", mode = ""] = String(volume).split(":");
    return {
        type: source.startsWith("/") ? "bind" : "volume",
        source,
        target,
        readOnly: mode === "ro",
        createHostPath: true,
    };
}

const environmentOf = (service: Json): Record<string, string> =>
    Object.fromEntries(
        Object.entries(service.environment ?? {}).map(([key, value]) => [key, String(value)]),
    );

const LOOPBACK = "127.0.0.1";
const SERVICES = ["postgres", "controller", "worker", "dokku", "router", "admin"];
const RESTARTED = ["postgres", "controller", "worker", "dokku", "router"];
// Settings the controller, the worker and the admin must agree on: switches, limits and quotas.
const SHARED = [
    "LAUNCHPAD_DATA_DIR",
    "LAUNCHPAD_BASE_URL",
    "LAUNCHPAD_APPS_DOMAIN",
    "LAUNCHPAD_DEPLOYMENTS",
    "LAUNCHPAD_ALIASES",
    "LAUNCHPAD_MAX_UPLOAD_BYTES",
    "LAUNCHPAD_MAX_EXPANDED_BYTES",
    "LAUNCHPAD_MAX_ARCHIVE_ENTRIES",
    "LAUNCHPAD_MAX_ARCHIVE_DEPTH",
    "LAUNCHPAD_UPLOAD_TIMEOUT_SECONDS",
    "LAUNCHPAD_MAX_ARTIFACTS",
    "LAUNCHPAD_MAX_CONCURRENT_UPLOADS",
    "LAUNCHPAD_MAX_APPS",
    "LAUNCHPAD_MAX_DEPLOYMENTS_PER_APP",
    "LAUNCHPAD_MAX_DEPLOYMENTS",
    "LAUNCHPAD_DEFAULT_TTL",
    "LAUNCHPAD_MAX_TTL",
    "LAUNCHPAD_DEPLOYMENT_HOSTNAME_TEMPLATE",
    "LAUNCHPAD_MAX_ALIASES_PER_APP",
    "LAUNCHPAD_MAX_ALIASES",
    "LAUNCHPAD_ALIAS_HOSTNAME_TEMPLATE",
    "LAUNCHPAD_ROLLBACK_RETENTION",
];

/**
 * Returns every way the (interpolated) model departs from the production design. `env` is the
 * settings the model was interpolated with; it supplies the expected host paths.
 */
export function assertProduction(model: Json, env: Env): string[] {
    const problems: string[] = [];
    const fail = (message: string) => problems.push(message);
    const services: Record<string, Json> = model.services ?? {};

    if (model.name !== "launchpad-production")
        fail("The project name must be launchpad-production.");
    for (const name of SERVICES) if (!services[name]) fail(`Service ${name} is missing.`);
    for (const name of Object.keys(services)) {
        if (!SERVICES.includes(name)) fail(`Unexpected service ${name}.`);
    }

    for (const [name, service] of Object.entries(services)) {
        if ("env_file" in service) fail(`${name} uses env_file; use an allowlisted environment.`);
        if ("container_name" in service) fail(`${name} has a fixed container_name.`);
        if (service.privileged) fail(`${name} is privileged.`);
        if (service.network_mode) fail(`${name} sets network_mode; use named networks.`);
        if (service.logging?.options?.["max-size"] === undefined)
            fail(`${name} has no log rotation.`);
        if (/:latest$|^[^:]+$/.test(String(service.image ?? "")) && name !== "admin") {
            fail(`${name} image "${service.image}" is not pinned to a tag.`);
        }
    }

    // Measured resource limits (docs/production-compose.md, "Resource limits").
    for (const [name, service] of Object.entries(services)) {
        if (!service.mem_limit) fail(`${name} has no mem_limit.`);
        if (!(Number(service.cpus) > 0)) fail(`${name} has no cpus limit.`);
        if (!(Number(service.pids_limit) > 0)) fail(`${name} has no pids_limit.`);
    }
    if (!/@sha256:[0-9a-f]{64}$/.test(String(services.postgres?.image ?? "")))
        fail("postgres image is not pinned by digest.");

    // Published ports.
    const published = (name: string): Port[] => (services[name]?.ports ?? []).map(portOf);
    for (const name of ["postgres", "worker", "admin"]) {
        if (published(name).length > 0) fail(`${name} must not publish a port.`);
    }
    const expectedPorts: Record<string, Array<[number, string]>> = {
        controller: [[3000, "32180"]],
        dokku: [
            [22, "32222"],
            [80, "32181"],
            [443, "32443"],
        ],
        router: [[3080, "32182"]],
    };
    for (const [name, expected] of Object.entries(expectedPorts)) {
        const ports = published(name);
        for (const port of ports) {
            if (port.ip !== LOOPBACK)
                fail(`${name} port ${port.target} is not bound to ${LOOPBACK} by default.`);
        }
        const got = ports.map((port) => `${port.target}:${port.published}`).sort();
        const want = expected.map(([target, host]) => `${target}:${host}`).sort();
        if (got.join() !== want.join())
            fail(`${name} ports are ${got.join()}, expected ${want.join()}.`);
    }
    if (published("router").some((port) => port.target === 3081)) {
        fail("The router control port must not be published.");
    }

    // Networks: the database is private and only its users are attached.
    if (model.networks?.database?.internal !== true) fail("The database network must be internal.");
    const attached = (name: string) => {
        const networks = services[name]?.networks ?? {};
        return (Array.isArray(networks) ? networks : Object.keys(networks)).sort();
    };
    if (attached("postgres").join() !== "database")
        fail("postgres must be on the database network only.");
    for (const name of ["controller", "worker", "admin"]) {
        if (!attached(name).includes("database")) fail(`${name} needs the database network.`);
    }
    for (const name of ["dokku", "router"]) {
        if (attached(name).includes("database"))
            fail(`${name} must not join the database network.`);
    }
    // Compose cannot attach a service to the engine's default bridge (the engine rejects the
    // aliases it sends), so Dokku's app containers go on a dedicated `apps` network.
    if (attached("dokku").join() !== "apps,backend") fail("dokku must be on backend and apps.");
    if ("engine-bridge" in (model.networks ?? {})) fail("Do not attach to the default bridge.");
    if (model.networks?.apps?.internal === true)
        fail(
            "The apps network must not be internal: app containers pull nothing but need a route.",
        );
    if (!/\bss -ltn\b.*:80\b/.test(JSON.stringify(services.dokku?.healthcheck?.test ?? "")))
        fail("The dokku healthcheck must require the HTTP proxy to listen.");

    // Restart, profile and stop behavior.
    for (const name of RESTARTED) {
        if (services[name]?.restart !== "unless-stopped")
            fail(`${name} needs restart: unless-stopped.`);
        if (!services[name]?.healthcheck?.test) fail(`${name} has no healthcheck.`);
        if (services[name]?.profiles) fail(`${name} must not be in a profile.`);
    }
    const admin = services.admin ?? {};
    if (JSON.stringify(admin.profiles) !== JSON.stringify(["admin"]))
        fail("admin must be only in the admin profile.");
    if ("restart" in admin) fail("admin must have no restart policy.");
    if (admin.build?.target !== "admin")
        fail("admin must build the controller Dockerfile's admin target.");
    if (admin.build?.dockerfile !== services.controller?.build?.dockerfile) {
        fail("admin must use the controller's Dockerfile.");
    }
    const grace = services.worker?.stop_grace_period;
    if (typeof grace !== "string" || seconds(grace) < 25 * 60)
        fail("worker stop_grace_period must be at least 25m.");
    if (!(services.worker?.group_add ?? []).length)
        fail("worker needs the Docker socket's group (group_add).");

    // Environment: allowlisted, matching and safe by default.
    const environment = Object.fromEntries(
        SERVICES.map((name) => [name, environmentOf(services[name] ?? {})]),
    );
    for (const key of SHARED) {
        for (const name of ["controller", "worker", "admin"]) {
            if (!(key in environment[name]!)) fail(`${name} is missing ${key}.`);
        }
        if (environment.controller![key] !== environment.worker![key])
            fail(`${key} differs between controller and worker.`);
        if (environment.controller![key] !== environment.admin![key])
            fail(`${key} differs between controller and admin.`);
    }
    for (const name of ["controller", "worker", "admin"]) {
        if (environment[name]!.DATABASE_URL !== environment.controller!.DATABASE_URL)
            fail(`${name} DATABASE_URL differs.`);
        if (environment[name]!.LAUNCHPAD_DATA_DIR !== "/data") fail(`${name} must use /data.`);
    }
    if (environment.controller!.LAUNCHPAD_PUBLIC_SIGNUP !== "false")
        fail("Public signup must be off.");
    if (environment.controller!.LAUNCHPAD_ENROLLMENT !== "operator")
        fail("Enrollment must be operator-managed.");
    const secretKeys = (name: string) =>
        Object.keys(environment[name]!).filter((key) =>
            /DOKKU_SSH|ALIAS_CONTROL|ALIAS_ROUTER|DOCKER_HOST|PROXY_URL|PROBE_URL/.test(key),
        );
    if (secretKeys("controller").length)
        fail("controller must not receive Dokku, router or Docker settings.");
    if (
        Object.keys(environment.postgres!).sort().join() !==
        "POSTGRES_DB,POSTGRES_PASSWORD,POSTGRES_USER"
    ) {
        fail("postgres has unexpected environment settings.");
    }
    if (
        Object.keys(environment.router!).some((key) =>
            /DATABASE|POSTGRES|AUTH_SECRET|DOKKU_SSH/.test(key),
        )
    ) {
        fail("router must not receive database, auth or Dokku credentials.");
    }
    if (
        environment.router!.LAUNCHPAD_APPS_PROXY_URL !==
        environment.worker!.LAUNCHPAD_APPS_PROXY_URL
    ) {
        fail("router and worker must agree on the Dokku proxy origin.");
    }
    if (
        environment.router!.LAUNCHPAD_ROUTER_INSTANCE_ID !==
        environment.worker!.LAUNCHPAD_ALIAS_INSTANCE_ID
    ) {
        fail("router and worker must agree on the instance id.");
    }
    if (environment.worker!.LAUNCHPAD_ALIAS_CONTROL_URL !== "http://router:3081")
        fail("worker must reach the router control plane privately.");
    if (environment.worker!.LAUNCHPAD_ALIAS_PROBE_URL !== "http://router:3080")
        fail("worker must probe the router data plane privately.");

    // Mounts.
    const mounts = (name: string): Mount[] => (services[name]?.volumes ?? []).map(mountOf);
    for (const name of SERVICES) {
        for (const mount of mounts(name)) {
            if (mount.type === "bind" && mount.createHostPath)
                fail(`${name} bind ${mount.target} may be auto-created by Docker.`);
            if (mount.source.endsWith("docker.sock") !== (mount.target === "/var/run/docker.sock"))
                fail(`${name} mounts a Docker socket oddly.`);
        }
    }
    for (const name of ["controller", "worker", "admin"]) {
        const data = mounts(name).find((mount) => mount.target === "/data");
        if (data?.type !== "volume" || data.source !== "launchpad-data" || data.readOnly) {
            fail(`${name} must mount the shared launchpad-data volume at /data, writable.`);
        }
    }
    for (const name of ["postgres", "controller", "router", "admin"]) {
        if (mounts(name).some((mount) => mount.target === "/var/run/docker.sock"))
            fail(`${name} must not hold the Docker socket.`);
    }
    for (const name of ["worker", "dokku"]) {
        if (!mounts(name).some((mount) => mount.target === "/var/run/docker.sock"))
            fail(`${name} needs the Docker socket.`);
    }
    for (const name of ["worker", "admin"]) {
        for (const target of [
            "/credentials/dokku/id_ed25519",
            "/credentials/dokku/known_hosts",
            "/credentials/router/control-token",
            "/credentials/router/epoch",
        ]) {
            const mount = mounts(name).find((item) => item.target === target);
            if (mount?.type !== "bind" || !mount.readOnly)
                fail(`${name} must mount ${target} read-only.`);
        }
    }
    for (const name of ["controller", "postgres", "router"]) {
        if (mounts(name).some((mount) => mount.target.startsWith("/credentials")))
            fail(`${name} must not mount credentials.`);
    }
    const backup = mounts("admin").find((mount) => mount.target === "/backups");
    if (backup?.source !== env.LAUNCHPAD_BACKUP_DIR)
        fail("admin must bind the backup directory at /backups.");

    // Dokku's host-path settings must name the bind source the host engine sees.
    const dokkuData = mounts("dokku").find((mount) => mount.target === "/mnt/dokku");
    const dir = env.DOKKU_DATA_DIR ?? "";
    if (!dir.startsWith("/") || dokkuData?.source !== dir)
        fail("Dokku state must be bound from the absolute DOKKU_DATA_DIR.");
    if (
        environment.dokku!.DOKKU_HOST_ROOT !== `${dir}/home/dokku` ||
        environment.dokku!.DOKKU_LIB_HOST_ROOT !== `${dir}/var/lib/dokku`
    ) {
        fail("Dokku host-root settings do not match the bind source.");
    }
    return problems;
}

const DIGEST = /@sha256:[0-9a-f]{64}\b/;

/** Every external base image in our Dockerfiles is pinned by digest; the Dokku plugin by commit. */
export function assertDockerfiles(files: Record<string, string>): string[] {
    const problems: string[] = [];
    for (const [file, text] of Object.entries(files)) {
        const stages = new Set<string>();
        for (const line of text.split("\n")) {
            const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
            if (from) {
                const [, image, stage] = from;
                if (!stages.has(image!) && !DIGEST.test(image!) && !/@\$\{\w+\}$/.test(image!))
                    problems.push(`${file}: ${image} is not pinned by digest.`);
                if (stage) stages.add(stage);
            }
            const arg = /^ARG\s+(\w*DIGEST)=(\S*)/.exec(line);
            if (arg && !/^sha256:[0-9a-f]{64}$/.test(arg[2]!))
                problems.push(`${file}: ${arg[1]} is not a sha256 digest.`);
        }
        if (/plugin:install/.test(text) && !/ARG DOKKU_HTTP_AUTH_COMMIT=[0-9a-f]{40}\n/.test(text))
            problems.push(`${file}: the Dokku plugin is not pinned to a 40-hex commit.`);
    }
    return problems;
}

export function readDockerfiles(): Record<string, string> {
    return Object.fromEntries(
        [
            "apps/controller/Dockerfile",
            "apps/worker/Dockerfile",
            "apps/router/Dockerfile",
            "containers/dokku/Dockerfile",
        ].map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
    );
}

/** Variables that must be supplied (the `${VAR:?...}` ones) when only the defaults are used. */
export function requiredVariables(raw: Json): string[] {
    const missing = new Set<string>();
    interpolate(raw, {}, missing);
    return [...missing].sort();
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

// `docker compose config` renders only; it starts nothing. The environment is minimal on purpose:
// neither the shell nor a local .env.local may leak into the rendering.
export async function checkRendered(): Promise<string[]> {
    const clean = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const base = ["docker", "compose", "-f", COMPOSE_FILE, "--profile", "admin"];
    const rendered = await run(
        [...base, "--env-file", ENV_EXAMPLE, "config", "--format", "json"],
        clean,
    );
    if (rendered.code !== 0) return [`docker compose config failed: ${rendered.err.trim()}`];
    const problems = [
        ...assertProduction(
            JSON.parse(rendered.out),
            parseEnvFile(readFileSync(ENV_EXAMPLE, "utf8")),
        ),
        ...assertDockerfiles(readDockerfiles()),
    ];
    // Required settings must fail closed when unset.
    const bare = await run([...base, "--env-file", "/dev/null", "config", "--quiet"], clean);
    if (bare.code === 0)
        problems.push("The file rendered without any settings: secrets are not required.");
    return problems;
}

if (import.meta.main) {
    const problems = await checkRendered();
    if (problems.length > 0) {
        console.error(problems.map((problem) => `- ${problem}`).join("\n"));
        process.exit(1);
    }
    console.log("docker-compose.yaml: rendered and checked (nothing was started).");
}
