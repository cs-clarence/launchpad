import { describe, expect, it } from "bun:test";
import { interpolate, loadRaw } from "../../compose-production";
import { fixtureProblems, planFixture } from "./fixture";

const id = "1234567890abcdef12345678";
const ports = [42180, 42222, 42181, 42443, 42182];
const plan = planFixture(id, ports, 100);

function model() {
    const base = interpolate(loadRaw(), plan.env);
    base.name = plan.project;
    for (const [name, image] of Object.entries(plan.images)) base.services[name].image = image;
    for (const [key, name] of Object.entries(plan.networks))
        base.networks[key] = { ...base.networks[key], name };
    for (const [key, name] of Object.entries(plan.volumes)) base.volumes[key] = { name };
    return base;
}

describe("disposable Compose fixture preflight", () => {
    it("renders an isolated fixture with aliases and deployments enabled", () => {
        const fixture = model();
        expect(fixtureProblems(fixture, plan)).toEqual([]);
        expect(fixture.services.worker.environment.LAUNCHPAD_ALIASES).toBe("on");
        expect(fixture.services.worker.environment.LAUNCHPAD_DEPLOYMENTS).toBe("on");
        expect(plan.directory).toBe(`/tmp/opencode/${plan.project}`);
    });

    it("rejects non-fixture names and ambiguous ports", () => {
        expect(() => planFixture("launchpad-production", ports, 100)).toThrow();
        expect(() =>
            planFixture(
                id,
                ports.map(() => 42180),
                100,
            ),
        ).toThrow();
        expect(() => planFixture(id, [0, ...ports.slice(1)], 100)).toThrow();
    });

    it("allocates different resource names and credentials for different fixtures", () => {
        const other = planFixture("2234567890abcdef12345678", ports, 100);
        expect(other.directory).not.toBe(plan.directory);
        expect(other.images.router).not.toBe(plan.images.router);
        expect(other.volumes["router-state"]).not.toBe(plan.volumes["router-state"]);
        expect(other.networks.apps).not.toBe(plan.networks.apps);
        expect(other.env.POSTGRES_PASSWORD).not.toBe(plan.env.POSTGRES_PASSWORD);
    });

    it("rejects wildcard publishing and a published control port", () => {
        const fixture = model();
        fixture.services.controller.ports[0] = `${ports[0]}:3000`;
        fixture.services.router.ports.push("127.0.0.1:43081:3081");
        expect(fixtureProblems(fixture, plan)).toEqual([
            "Unsafe fixture ports: controller.",
            "Unsafe fixture ports: router.",
        ]);
    });

    it("rejects shared state and an unexpected writable host bind", () => {
        const fixture = model();
        fixture.volumes["router-state"].external = true;
        fixture.networks.apps.name = "launchpad-apps";
        const mount = fixture.services.router.volumes.find(
            (volume: { target?: string }) => volume.target === "/tls/server.key",
        );
        // Mutate a copy: YAML anchors may share references across mounts.
        const index = fixture.services.router.volumes.indexOf(mount);
        fixture.services.router.volumes[index] = {
            ...mount,
            source: "/srv/launchpad/router.key",
            read_only: false,
        };
        expect(fixtureProblems(fixture, plan)).toEqual([
            "Unsafe fixture networks definition: apps.",
            "Unsafe fixture volumes definition: router-state.",
            "Unsafe fixture mount: router:/tls/server.key.",
        ]);
    });

    it("rejects a shared build tag or external DB, SSH or router endpoints without echoing values", () => {
        const fixture = model();
        fixture.services.dokku.build.tags = ["launchpad/dokku:existing"];
        fixture.services.admin.environment.DATABASE_URL = "postgresql://prod:secret@example.com/db";
        fixture.services.admin.environment.DOKKU_SSH_HOST = "dokku.example.com";
        fixture.services.worker.environment.LAUNCHPAD_ALIAS_CONTROL_URL =
            "https://router.example.com";
        expect(fixtureProblems(fixture, plan)).toEqual([
            "Unsafe fixture build outputs or attachments: dokku.",
            "Unsafe fixture endpoint or credential setting: worker:LAUNCHPAD_ALIAS_CONTROL_URL.",
            "Unsafe fixture endpoint or credential setting: admin:DATABASE_URL.",
            "Unsafe fixture endpoint or credential setting: admin:DOKKU_SSH_HOST.",
        ]);
    });
});
