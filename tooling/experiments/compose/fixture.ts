import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { COMPOSE_FILE, mountOf, portOf } from "../../compose-production";

const imageServices = ["controller", "worker", "router", "admin", "dokku"] as const;
const volumeKeys = ["launchpad-data", "postgres-data", "router-state"] as const;
const networkKeys = ["apps", "backend", "database"] as const;
const bindings = [
    ["controller", "CONTROLLER_HOST_PORT", 3000],
    ["dokku", "DOKKU_SSH_HOST_PORT", 22],
    ["dokku", "PREVIEW_HTTP_HOST_PORT", 80],
    ["dokku", "PREVIEW_HTTPS_HOST_PORT", 443],
    ["router", "ROUTER_DATA_HOST_PORT", 3080],
] as const;
const bindSources = {
    DOCKER_SOCKET_PATH: "/var/run/docker.sock",
    DOKKU_DATA_DIR: "dokku",
    LAUNCHPAD_BACKUP_DIR: "backups",
    LAUNCHPAD_DOKKU_SSH_KEY_FILE: "credentials/id_ed25519",
    LAUNCHPAD_DOKKU_KNOWN_HOSTS_FILE: "credentials/known_hosts",
    LAUNCHPAD_ROUTER_TOKEN_FILE: "credentials/token",
    LAUNCHPAD_ROUTER_EPOCH_FILE: "credentials/epoch",
    LAUNCHPAD_ROUTER_TLS_CERT_FILE: "tls/server.pem",
    LAUNCHPAD_ROUTER_TLS_KEY_FILE: "tls/server.key",
    LAUNCHPAD_ROUTER_TLS_CA_FILE: "tls/ca.pem",
} as const;

export function planFixture(id: string, ports: readonly number[], socketGid: number) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid fixture identifier.");
    if (
        ports.length !== bindings.length ||
        new Set(ports).size !== ports.length ||
        ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535)
    )
        throw new Error("Supply five distinct unprivileged fixture ports.");
    if (!Number.isSafeInteger(socketGid) || socketGid < 0) throw new Error("Invalid socket GID.");

    const project = `lp-compose-${id}`;
    // Derive the only allowable bind root instead of accepting a user-supplied path.
    const directory = `/tmp/opencode/${project}`;
    const images = Object.fromEntries(imageServices.map((s) => [s, `${project}/${s}:test`]));
    const networks = Object.fromEntries(networkKeys.map((key) => [key, `${project}_${key}`]));
    const volumes = Object.fromEntries(volumeKeys.map((key) => [key, `${project}_${key}`]));
    const env: Record<string, string> = {
        ...Object.fromEntries(
            Object.entries(bindSources).map(([key, file]) => [
                key,
                file.startsWith("/") ? file : join(directory, file),
            ]),
        ),
        ...Object.fromEntries(bindings.map(([, key], index) => [key, String(ports[index])])),
        LAUNCHPAD_APPS_NETWORK: networks.apps!,
        LAUNCHPAD_BASE_URL: "https://control.example.net",
        LAUNCHPAD_APPS_DOMAIN: "sites.example.com",
        LAUNCHPAD_DEPLOYMENTS: "on",
        LAUNCHPAD_ALIASES: "on",
        LAUNCHPAD_ALIAS_INSTANCE_ID: randomUUID(),
        LAUNCHPAD_AUTH_SECRET: randomBytes(32).toString("hex"),
        POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
        DOCKER_SOCKET_GID: String(socketGid),
    };
    const override = {
        services: Object.fromEntries(
            Object.entries(images).map(([key, image]) => [key, { image }]),
        ),
    };
    return { project, directory, images, networks, volumes, env, override };
}

type Plan = ReturnType<typeof planFixture>;
const mountPlan = {
    postgres: { "/var/lib/postgresql/data": "postgres-data" },
    controller: { "/data": "launchpad-data" },
    dokku: { "/mnt/dokku": "DOKKU_DATA_DIR", "/var/run/docker.sock": "DOCKER_SOCKET_PATH" },
    router: {
        "/state": "router-state",
        "/tls/server.pem": "LAUNCHPAD_ROUTER_TLS_CERT_FILE",
        "/tls/server.key": "LAUNCHPAD_ROUTER_TLS_KEY_FILE",
        "/tls/control-ca.pem": "LAUNCHPAD_ROUTER_TLS_CA_FILE",
    },
} as const;
const controlMounts = {
    "/data": "launchpad-data",
    "/credentials/dokku/id_ed25519": "LAUNCHPAD_DOKKU_SSH_KEY_FILE",
    "/credentials/dokku/known_hosts": "LAUNCHPAD_DOKKU_KNOWN_HOSTS_FILE",
    "/credentials/router/control-token": "LAUNCHPAD_ROUTER_TOKEN_FILE",
    "/credentials/router/epoch": "LAUNCHPAD_ROUTER_EPOCH_FILE",
    "/tls/control-ca.pem": "LAUNCHPAD_ROUTER_TLS_CA_FILE",
};

/** Validate the normalized `docker compose config --format json` output, not raw YAML. */
export function fixtureProblems(model: any, plan: Plan): string[] {
    const problems: string[] = [];
    if (model.name !== plan.project) problems.push("Wrong fixture project name.");
    for (const [kind, names] of [
        ["networks", plan.networks],
        ["volumes", plan.volumes],
    ] as const) {
        const actual = model[kind] ?? {};
        if (Object.keys(actual).length !== Object.keys(names).length)
            problems.push(`Unexpected fixture ${kind}.`);
        for (const [key, name] of Object.entries(names)) {
            const item = actual[key];
            const driver = kind === "volumes" ? "local" : "bridge";
            if (
                item?.name !== name ||
                item.external ||
                item.driver_opts ||
                (item.driver && item.driver !== driver)
            )
                problems.push(`Unsafe fixture ${kind} definition: ${key}.`);
        }
    }
    const expectedMounts: Record<string, Record<string, string>> = {
        ...mountPlan,
        worker: { ...controlMounts, "/var/run/docker.sock": "DOCKER_SOCKET_PATH" },
        admin: { ...controlMounts, "/backups": "LAUNCHPAD_BACKUP_DIR" },
    };
    const services = model.services ?? {};
    if (Object.keys(services).length !== Object.keys(expectedMounts).length)
        problems.push("Unexpected fixture service count.");
    for (const [name, mounts] of Object.entries(expectedMounts)) {
        const service = services[name];
        const settings = service?.environment;
        const localTargets: Record<string, string> = {};
        if (["controller", "worker", "admin"].includes(name))
            localTargets.DATABASE_URL = `postgresql://launchpad:${plan.env.POSTGRES_PASSWORD}@postgres:5432/launchpad`;
        if (["worker", "admin"].includes(name))
            Object.assign(localTargets, {
                DOKKU_SSH_HOST: "dokku",
                DOKKU_SSH_PORT: "22",
                DOKKU_SSH_USER: "dokku",
                DOKKU_SSH_KEY_PATH: "/credentials/dokku/id_ed25519",
                DOKKU_SSH_KNOWN_HOSTS_PATH: "/credentials/dokku/known_hosts",
                LAUNCHPAD_ALIAS_CONTROL_URL: "https://router:3081",
                LAUNCHPAD_ALIAS_PROBE_URL: "http://router:3080",
                LAUNCHPAD_ALIAS_CONTROL_CA_FILE: "/tls/control-ca.pem",
                LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE: "/credentials/router/control-token",
                LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE: "/credentials/router/epoch",
            });
        if (["worker", "admin", "router"].includes(name))
            localTargets.LAUNCHPAD_APPS_PROXY_URL = "http://dokku:80";
        for (const [setting, expected] of Object.entries(localTargets))
            if (settings?.[setting] !== expected)
                problems.push(`Unsafe fixture endpoint or credential setting: ${name}:${setting}.`);
        if (
            !service ||
            service.container_name ||
            service.network_mode ||
            service.volumes_from ||
            service.privileged ||
            service.devices?.length ||
            service.configs?.length ||
            service.secrets?.length ||
            service.env_file?.length ||
            service.post_start?.length ||
            service.pre_stop?.length
        )
            problems.push(`Unsafe fixture service identity: ${name}.`);
        if (plan.images[name] && service?.image !== plan.images[name])
            problems.push(`Wrong fixture image: ${name}.`);
        const build = service?.build;
        if (
            (plan.images[name] && !build) ||
            (build &&
                (!plan.images[name] ||
                    build.tags?.length ||
                    build.output?.length ||
                    build.outputs?.length ||
                    build.additional_contexts ||
                    build.ssh?.length ||
                    build.secrets?.length ||
                    build.cache_to?.length ||
                    build.privileged))
        )
            problems.push(`Unsafe fixture build outputs or attachments: ${name}.`);
        if (build && plan.images[name]) {
            const root = dirname(COMPOSE_FILE);
            const expectedContext = name === "dokku" ? join(root, "containers/dokku") : root;
            const expectedDockerfile =
                name === "dokku"
                    ? "Dockerfile"
                    : `apps/${name === "admin" ? "controller" : name}/Dockerfile`;
            if (
                typeof build.context !== "string" ||
                resolve(root, build.context) !== expectedContext ||
                build.dockerfile !== expectedDockerfile ||
                build.dockerfile_inline ||
                (build.target ?? "") !== (name === "admin" ? "admin" : "")
            )
                problems.push(`Wrong fixture build input: ${name}.`);
        }
        if (
            name === "postgres" &&
            !/^postgres:17-alpine@sha256:[a-f0-9]{64}$/.test(service?.image ?? "")
        )
            problems.push("Fixture PostgreSQL image must be pinned.");
        if (
            ["controller", "worker", "admin"].includes(name) &&
            (service?.environment?.LAUNCHPAD_ALIASES !== "on" ||
                service?.environment?.LAUNCHPAD_DEPLOYMENTS !== "on")
        )
            problems.push(`Fixture switches are not enabled: ${name}.`);
        const expectedPorts = bindings
            .filter(([s]) => s === name)
            .map(([, key, target]) => `127.0.0.1:${plan.env[key]}:${target}`)
            .sort();
        const actualPorts = (service?.ports ?? [])
            .map(portOf)
            .map(
                ({ ip, published, target }: ReturnType<typeof portOf>) =>
                    `${ip}:${published}:${target}`,
            )
            .sort();
        if (JSON.stringify(actualPorts) !== JSON.stringify(expectedPorts))
            problems.push(`Unsafe fixture ports: ${name}.`);
        const actual = (service?.volumes ?? []).map(mountOf) as ReturnType<typeof mountOf>[];
        if (actual.length !== Object.keys(mounts).length)
            problems.push(`Unexpected fixture mount count: ${name}.`);
        for (const [target, key] of Object.entries(mounts)) {
            const mount = actual.find((item) => item.target === target);
            const bind = key in bindSources;
            const readOnly = target.startsWith("/tls/") || target.startsWith("/credentials/");
            if (
                !mount ||
                mount.source !== (bind ? plan.env[key] : key) ||
                mount.type !== (bind ? "bind" : "volume") ||
                (bind && (mount.createHostPath || mount.readOnly !== readOnly))
            )
                problems.push(`Unsafe fixture mount: ${name}:${target}.`);
        }
    }
    return problems;
}
