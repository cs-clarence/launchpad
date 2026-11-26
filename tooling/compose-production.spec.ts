import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    ENV_EXAMPLE,
    assertDockerfiles,
    assertProduction,
    interpolate,
    loadRaw,
    parseEnvFile,
    portOf,
    readDockerfiles,
    requiredVariables,
    seconds,
} from "./compose-production";

const example = parseEnvFile(readFileSync(ENV_EXAMPLE, "utf8"));
const render = (env = example) => interpolate(loadRaw(), env);

describe("docker-compose.yaml", () => {
    it("matches the production design when rendered with the example settings", () => {
        expect(assertProduction(render(), example)).toEqual([]);
    });

    it("pins external images by digest and the Dokku plugin by commit", () => {
        expect(assertDockerfiles(readDockerfiles())).toEqual([]);
        const files = readDockerfiles();
        const worker = files["apps/worker/Dockerfile"]!;
        expect(
            assertDockerfiles({ w: worker.replace(/@\$\{BUN_DIGEST\}/, "") }).join("\n"),
        ).toContain("not pinned by digest");
        expect(
            assertDockerfiles({
                d: files["containers/dokku/Dockerfile"]!.replace(
                    /COMMIT=[0-9a-f]{40}/,
                    "COMMIT=master",
                ),
            }).join("\n"),
        ).toContain("40-hex commit");
    });

    it("requires every secret, identity, domain and host path", () => {
        expect(requiredVariables(loadRaw())).toEqual([
            "DOCKER_SOCKET_GID",
            "DOKKU_DATA_DIR",
            "LAUNCHPAD_ALIAS_INSTANCE_ID",
            "LAUNCHPAD_APPS_DOMAIN",
            "LAUNCHPAD_AUTH_SECRET",
            "LAUNCHPAD_BACKUP_DIR",
            "LAUNCHPAD_BASE_URL",
            "LAUNCHPAD_DOKKU_KNOWN_HOSTS_FILE",
            "LAUNCHPAD_DOKKU_SSH_KEY_FILE",
            "LAUNCHPAD_ROUTER_EPOCH_FILE",
            "LAUNCHPAD_ROUTER_TLS_CA_FILE",
            "LAUNCHPAD_ROUTER_TLS_CERT_FILE",
            "LAUNCHPAD_ROUTER_TLS_KEY_FILE",
            "LAUNCHPAD_ROUTER_TOKEN_FILE",
            "POSTGRES_PASSWORD",
        ]);
    });

    it("keeps the example free of real-looking secrets", () => {
        expect(example.POSTGRES_PASSWORD).toStartWith("CHANGE_ME");
        expect(example.LAUNCHPAD_AUTH_SECRET).toStartWith("CHANGE_ME");
    });

    it("excludes the local Compose secrets from each root Docker build context", () => {
        for (const app of ["controller", "worker", "router"]) {
            const ignore = new URL(`../apps/${app}/Dockerfile.dockerignore`, import.meta.url);
            expect(readFileSync(ignore, "utf8").split(/\r?\n/)).toContain("docker-compose.env");
            expect(readFileSync(ignore, "utf8").split(/\r?\n/)).toContain(".local-deploy");
        }
    });

    it("is safe with only the required settings: features off, loopback bindings", () => {
        const required = Object.fromEntries(
            requiredVariables(loadRaw()).map((name) => [name, example[name]!]),
        );
        const model = render(required);
        expect(assertProduction(model, { ...example, ...required })).toEqual([]);
        const env = model.services.controller.environment;
        expect([env.LAUNCHPAD_DEPLOYMENTS, env.LAUNCHPAD_ALIASES]).toEqual(["off", "off"]);
        expect(env.LAUNCHPAD_PUBLIC_SIGNUP).toBe("false");
        expect(model.services.worker.environment.LAUNCHPAD_DEPLOYMENTS).toBe("off");
    });

    it("rejects the departures it exists to catch", () => {
        const mutate = (change: (model: any) => void) => {
            const model = render();
            change(model);
            return assertProduction(model, example).join("\n");
        };
        expect(mutate((m) => (m.services.postgres.ports = ["5432:5432"]))).toContain(
            "postgres must not publish",
        );
        expect(mutate((m) => (m.services.controller.ports = ["0.0.0.0:32180:3000"]))).toContain(
            "not bound to 127.0.0.1",
        );
        expect(mutate((m) => m.services.router.ports.push("127.0.0.1:3081:3081"))).toContain(
            "control port",
        );
        expect(
            mutate(
                (m) =>
                    (m.services.worker.environment.LAUNCHPAD_ALIAS_CONTROL_URL =
                        "http://router:3081"),
            ),
        ).toContain("private HTTPS");
        expect(
            mutate(
                (m) => delete m.services.router.environment.LAUNCHPAD_ROUTER_CONTROL_TLS_KEY_FILE,
            ),
        ).toContain("TLS_KEY_FILE");
        expect(
            mutate((m) =>
                m.services.worker.volumes.push(
                    m.services.router.volumes.find((v: any) => v.target === "/tls/server.key"),
                ),
            ),
        ).toContain("must not mount the router server");
        expect(
            mutate(
                (m) =>
                    (m.services.admin.volumes = m.services.admin.volumes.filter(
                        (v: any) => v.target !== "/tls/control-ca.pem",
                    )),
            ),
        ).toContain("public router-control CA");
        expect(
            mutate(
                (m) => (m.services.worker.environment.LAUNCHPAD_BASE_IMAGE = "nginx:1.27-alpine"),
            ),
        ).toContain("app base image must be a tag pinned");
        expect(mutate((m) => delete m.services.controller.read_only)).toContain(
            "controller must have a read-only root filesystem",
        );
        expect(mutate((m) => (m.services.worker.tmpfs = []))).toContain(
            "worker must mount a bounded tmpfs",
        );
        expect(mutate((m) => (m.services.worker.tmpfs = ["/tmp"]))).toContain(
            "worker must mount a bounded tmpfs",
        );
        expect(
            mutate((m) => {
                m.services.worker.tmpfs = [];
                m.services.worker.volumes.push({ type: "tmpfs", target: "/tmp" });
            }),
        ).toContain("worker must mount a bounded tmpfs");
        // A sized long-form tmpfs under `volumes` is equivalent and must pass.
        expect(
            mutate((m) => {
                m.services.worker.tmpfs = [];
                m.services.worker.volumes.push({
                    type: "tmpfs",
                    target: "/tmp",
                    tmpfs: { size: 67108864 },
                });
            }),
        ).not.toContain("worker must mount a bounded tmpfs");
        expect(mutate((m) => (m.services.postgres.read_only = true))).toContain(
            "postgres was not verified",
        );
        expect(mutate((m) => (m.services.worker.stop_grace_period = "10m"))).toContain(
            "stop_grace_period",
        );
        expect(mutate((m) => delete m.services.worker.healthcheck)).toContain(
            "worker has no healthcheck",
        );
        expect(mutate((m) => delete m.services.router.mem_limit)).toContain(
            "router has no mem_limit",
        );
        expect(mutate((m) => m.services.dokku.networks.push("database"))).toContain(
            "dokku must not join the database",
        );
        expect(mutate((m) => (m.services.worker.restart = "no"))).toContain("worker needs restart");
        expect(mutate((m) => (m.services.admin.restart = "unless-stopped"))).toContain(
            "no restart policy",
        );
        expect(mutate((m) => delete m.services.admin.profiles)).toContain("admin profile");
        expect(mutate((m) => (m.services.worker.env_file = [".env"]))).toContain("env_file");
        expect(
            mutate((m) => (m.services.worker.environment.LAUNCHPAD_MAX_EXPANDED_BYTES = "1")),
        ).toContain("differs between controller and worker");
        expect(mutate((m) => (m.services.worker.volumes[2].read_only = false))).toContain(
            "read-only",
        );
        expect(mutate((m) => (m.services.controller.container_name = "x"))).toContain(
            "container_name",
        );
        expect(mutate((m) => (m.networks.database.internal = false))).toContain("internal");
        expect(
            mutate((m) => (m.services.dokku.environment.DOKKU_HOST_ROOT = "/elsewhere")),
        ).toContain("host-root");
    });

    it("parses compose ports and durations", () => {
        expect(portOf("127.0.0.1:32180:3000")).toEqual({
            ip: "127.0.0.1",
            published: "32180",
            target: 3000,
        });
        expect(portOf({ host_ip: "127.0.0.1", published: "1", target: 2 })).toEqual({
            ip: "127.0.0.1",
            published: "1",
            target: 2,
        });
        expect([seconds("25m"), seconds("25m0s"), seconds("1h")]).toEqual([1500, 1500, 3600]);
    });
});
