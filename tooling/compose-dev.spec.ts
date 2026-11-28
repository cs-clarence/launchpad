import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { requiredVariables, interpolate } from "./compose-production";
import {
    DEV_EXAMPLE,
    assertDev,
    assertMatchesProduction,
    checkRaw,
    loadDevRaw,
} from "./compose-dev";
import { loadRaw } from "./compose-production";

const render = (env: Record<string, string> = DEV_EXAMPLE) => interpolate(loadDevRaw(), env);
const lines = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split(/\r?\n/);

describe("docker-compose.dev.yaml", () => {
    it("matches the development design and docker-compose.yaml when rendered with example settings", () => {
        expect(assertDev(render())).toEqual([]);
        expect(checkRaw()).toEqual([]);
    });

    it("requires exactly the settings the tool generates", () => {
        expect(requiredVariables(loadDevRaw())).toEqual([
            "DEV_PROJECT",
            "DOKKU_DATA_DIR",
            "LAUNCHPAD_ALIAS_INSTANCE_ID",
            "LAUNCHPAD_APPS_DOMAIN",
            "POSTGRES_PASSWORD",
        ]);
    });

    it("has exactly the five services and no controller or worker", () => {
        expect(Object.keys(render().services).sort()).toEqual([
            "adminer",
            "dokku",
            "mailpit",
            "postgres",
            "router",
        ]);
    });

    it("publishes only on loopback, with the default port block", () => {
        const model = render();
        const published = Object.values<any>(model.services).flatMap((s) => s.ports ?? []);
        expect(published.length).toBe(8);
        for (const port of published) expect(String(port)).toStartWith("127.0.0.1:");
        expect(published).toContain("127.0.0.1:33183:3081");
    });

    it("lets the ports be overridden and still binds loopback", () => {
        const model = render({
            ...DEV_EXAMPLE,
            DEV_POSTGRES_PORT: "40001",
            DEV_ADMINER_PORT: "41234",
            DEV_ROUTER_CONTROL_PORT: "40002",
        });
        expect(model.services.postgres.ports).toEqual(["127.0.0.1:40001:5432"]);
        expect(model.services.adminer.ports).toEqual(["127.0.0.1:41234:8080"]);
        expect(model.services.router.ports).toContain("127.0.0.1:40002:3081");
        expect(
            assertDev(model, {
                ...DEV_EXAMPLE,
                DEV_POSTGRES_PORT: "40001",
                DEV_ADMINER_PORT: "41234",
                DEV_ROUTER_CONTROL_PORT: "40002",
            }),
        ).toEqual([]);
    });

    it("tags the built images with the project and labels them", () => {
        const model = render();
        expect(model.services.dokku.image).toBe("launchpad-dev-example/dokku:local");
        expect(model.services.router.image).toBe("launchpad-dev-example/router:local");
        expect(model.services.router.build.labels["com.launchpad.dev-project"]).toBe(
            "launchpad-dev-example",
        );
    });

    it("keeps the Docker socket in Dokku only", () => {
        const model = render();
        const holders = Object.entries<any>(model.services)
            .filter(([, s]) => JSON.stringify(s.volumes ?? []).includes("docker.sock"))
            .map(([name]) => name);
        expect(holders).toEqual(["dokku"]);
        const mutated = structuredClone(model);
        mutated.services.router.volumes = [
            { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
        ];
        expect(assertDev(mutated).join("\n")).toContain("router mounts the Docker socket");
    });

    it("has plain-HTTP router control on loopback and no TLS settings", () => {
        const router = render().services.router;
        expect(router.environment.LAUNCHPAD_ROUTER_CONTROL_PRIVATE_NETWORK).toBe("1");
        expect(Object.keys(router.environment).some((k) => k.includes("TLS"))).toBe(false);
        const mutated = structuredClone(render());
        mutated.services.router.environment.LAUNCHPAD_ROUTER_CONTROL_TLS_CERT_FILE = "/x";
        expect(assertDev(mutated).join("\n")).toContain("plain HTTP");
    });

    it("rejects a port on all interfaces, an unpinned image and an extra service", () => {
        const open = structuredClone(render());
        open.services.postgres.ports = ["5432:5432"];
        expect(assertDev(open).join("\n")).toContain("all interfaces");
        const unpinned = structuredClone(render());
        unpinned.services.mailpit.image = "axllent/mailpit:v1.29";
        expect(assertDev(unpinned).join("\n")).toContain("not pinned by digest");
        const extra = structuredClone(render());
        extra.services.controller = { image: "x" };
        expect(assertDev(extra).join("\n")).toContain("exactly");
        const adminer = structuredClone(render());
        adminer.services.adminer.healthcheck = undefined;
        adminer.services.adminer.mem_limit = undefined;
        adminer.services.adminer.volumes = [{ adminer: "/data" }];
        const problems = assertDev(adminer).join("\n");
        expect(problems).toContain("adminer needs a healthcheck");
        expect(problems).toContain("adminer needs a memory limit");
        expect(problems).toContain("adminer keeps no data");
        const noDepends = structuredClone(render());
        delete noDepends.services.adminer.depends_on;
        expect(assertDev(noDepends).join("\n")).toContain("after postgres");
        const shallow = structuredClone(render());
        shallow.services.adminer.healthcheck.test = ["CMD", "true"];
        expect(assertDev(shallow).join("\n")).toContain("probe port 8080");
        const small = structuredClone(render());
        small.services.adminer.mem_limit = "256m";
        expect(assertDev(small).join("\n")).toContain("above 1 GiB");
        const alias = structuredClone(render());
        alias.services.adminer.mem_limit = "256mb";
        expect(assertDev(alias).join("\n")).toContain("above 1 GiB");
        const nonsense = structuredClone(render());
        nonsense.services.adminer.mem_limit = "lots";
        expect(assertDev(nonsense).join("\n")).toContain("not a byte size");
    });

    it("keeps the PostgreSQL, Dokku and router parts equal to docker-compose.yaml", () => {
        const dev = render();
        const production = interpolate(loadRaw(), {
            ...Object.fromEntries(requiredVariables(loadRaw()).map((n) => [n, "x"])),
            LAUNCHPAD_APPS_DOMAIN: DEV_EXAMPLE.LAUNCHPAD_APPS_DOMAIN!,
            DOKKU_DATA_DIR: DEV_EXAMPLE.DOKKU_DATA_DIR!,
            POSTGRES_PASSWORD: DEV_EXAMPLE.POSTGRES_PASSWORD!,
        });
        expect(assertMatchesProduction(dev, production)).toEqual([]);
        const drifted = structuredClone(dev);
        drifted.services.dokku.healthcheck.start_period = "1m";
        drifted.services.postgres.image = "postgres:17-alpine";
        const found = assertMatchesProduction(drifted, production).join("\n");
        expect(found).toContain("Dokku healthcheck");
        expect(found).toContain("PostgreSQL image");
    });

    it("keeps Mailpit's pin in the file, with no data volume", () => {
        const text = readFileSync(new URL("../docker-compose.dev.yaml", import.meta.url), "utf8");
        expect(text).toMatch(/image: axllent\/mailpit:v[0-9.]+@sha256:[0-9a-f]{64}/);
        expect(render().services.mailpit.volumes).toBeUndefined();
    });

    it("excludes .dev-infra from git and from each root Docker build context", () => {
        expect(lines(".gitignore")).toContain(".dev-infra/");
        for (const app of ["controller", "worker", "router"]) {
            expect(lines(`apps/${app}/Dockerfile.dockerignore`)).toContain(".dev-infra");
        }
    });
});
