import { describe, expect, it } from "bun:test";
import path from "node:path";
import { opaqueId } from "../packages/services/src/ids";
import { parseAliasConfig } from "../packages/services/src/app-routing-config";
import { imageTagFor as workerImageTagFor } from "../apps/worker/src/template";
import { assertProduction, interpolate, loadRaw } from "./compose-production";
import {
    appsNetwork,
    APPS_DOMAIN,
    BASE_URL,
    checkPortBase,
    checkProject,
    composeEnv,
    credentialCommands,
    DeployError,
    generateSecrets,
    hostnamePattern,
    imageTagFor,
    layoutFor,
    mergeSites,
    missingVariables,
    NAME,
    OWNED_BY_SERVICE,
    overrideFor,
    parseArgs,
    HELP,
    SWITCH_FLAGS,
    VALUE_FLAGS,
    COMMANDS,
    parseDatabaseRows,
    parseEnv,
    parseInventory,
    parseSocketGid,
    parseState,
    portsFor,
    projectImages,
    projectNameFor,
    renderEnv,
    renderInventory,
    requiredNames,
    summarizeDockerProblems,
} from "./local-deploy";

const REPO = "/home/dev/launchpad";
const layout = layoutFor(REPO);
const project = projectNameFor(REPO);
const env = () => composeEnv(layout, project, portsFor(32180), generateSecrets(), 988, "1.2.3");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("names", () => {
    it("derives a different project per checkout and keeps the pattern", () => {
        expect(projectNameFor("/a/b")).not.toBe(projectNameFor("/a/c"));
        expect(projectNameFor("/a/b")).toMatch(/^launchpad-local-[0-9a-f]{8}$/);
        expect(projectNameFor("/a/b")).toBe(projectNameFor("/a/b"));
    });

    it("accepts only launchpad-local-* project names", () => {
        expect(checkProject("launchpad-local-abc")).toBe("launchpad-local-abc");
        for (const bad of [
            "launchpad",
            "launchpad-local-",
            "launchpad-local-A",
            "x-launchpad-local-a",
            `launchpad-local-${"a".repeat(41)}`,
            "launchpad-local-a/b",
        ]) {
            expect(() => checkProject(bad), bad).toThrow(DeployError);
        }
    });

    it("builds five image tags under the project and a project apps network", () => {
        expect(Object.values(projectImages(project)).sort()).toEqual(
            ["controller", "worker", "dokku", "router", "admin"]
                .map((s) => `${project}/${s}:local`)
                .sort(),
        );
        expect(appsNetwork(project)).toBe(`${project}-apps`);
        expect(Object.keys(overrideFor(project).services)).toHaveLength(5);
    });

    it("ties the copied name patterns to the real generators", () => {
        for (let i = 0; i < 50; i++) {
            expect(`lp-${opaqueId(10)}`).toMatch(NAME.app);
            const id = crypto.randomUUID();
            expect(workerImageTagFor(id)).toBe(imageTagFor(id));
            expect(workerImageTagFor(id)).toMatch(NAME.tag);
        }
    });
});

describe("ports", () => {
    it("reproduces the compose defaults at the default base", () => {
        expect(portsFor(32180)).toEqual({
            controller: 32180,
            http: 32181,
            router: 32182,
            ssh: 32222,
            https: 32443,
        });
    });

    it("maps offsets from another base and refuses a bad range", () => {
        expect(portsFor(40000)).toEqual({
            controller: 40000,
            http: 40001,
            router: 40002,
            ssh: 40042,
            https: 40263,
        });
        expect(checkPortBase(1024)).toBe(1024);
        expect(checkPortBase(65535 - 263)).toBe(65272);
        for (const bad of [1023, 65273, 70000, 1.5, Number.NaN]) {
            expect(() => checkPortBase(bad), String(bad)).toThrow(DeployError);
        }
    });
});

describe("the generated settings", () => {
    it("renders every required variable of docker-compose.yaml", () => {
        const names = requiredNames();
        expect(names.length).toBeGreaterThan(10);
        const values = env();
        for (const name of names) expect(values[name], name).toBeTruthy();
        expect(missingVariables(values)).toEqual([]);
        expect(missingVariables({})).toEqual(names);
    });

    it("keeps the production shape: loopback ports only, read-only credentials", () => {
        const values = env();
        expect(assertProduction(interpolate(loadRaw(), values), values)).toEqual([]);
    });

    it("sets only loopback bindings and the unique network", () => {
        const values = env();
        expect(Object.keys(values).filter((k) => k.endsWith("_BIND_IP"))).toEqual([]);
        expect(values.LAUNCHPAD_APPS_NETWORK).toBe(`${project}-apps`);
        expect(values.LAUNCHPAD_ALIASES).toBe("off");
        expect(values.LAUNCHPAD_DEPLOYMENTS).toBe("on");
    });

    it("puts every bind source inside the state directory", () => {
        const values = env();
        for (const key of [
            "DOKKU_DATA_DIR",
            "LAUNCHPAD_BACKUP_DIR",
            "LAUNCHPAD_DOKKU_SSH_KEY_FILE",
            "LAUNCHPAD_ROUTER_TLS_KEY_FILE",
        ]) {
            expect(values[key]!.startsWith(`${REPO}/.local-deploy/`), key).toBe(true);
        }
    });

    it("round-trips through the env file format", () => {
        const values = env();
        expect(parseEnv(renderEnv(values))).toEqual(values);
    });

    it("refuses a repository path Compose could misread", () => {
        for (const bad of ["relative/x", "/a b", "/a$b", "/a'b"]) {
            expect(() => layoutFor(bad), bad).toThrow(DeployError);
        }
    });

    it("generates distinct hex secrets and a UUID instance id", () => {
        const a = generateSecrets();
        expect(a.postgresPassword).toMatch(/^[0-9a-f]{48}$/);
        expect(a.authSecret).toMatch(/^[0-9a-f]{64}$/);
        expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
        expect(generateSecrets().postgresPassword).not.toBe(a.postgresPassword);
    });
});

describe("hostnames and TLS settings", () => {
    const aliasEnv = (base: string, domain: string) => ({
        LAUNCHPAD_BASE_URL: base,
        LAUNCHPAD_APPS_DOMAIN: domain,
        LAUNCHPAD_ALIASES: "off",
    });
    it("passes the real validator", () => {
        expect(() => parseAliasConfig(aliasEnv(BASE_URL, APPS_DOMAIN))).not.toThrow();
    });
    it("fails the bad pairs the plan rules out", () => {
        expect(() =>
            parseAliasConfig(aliasEnv("https://localhost:8443", "apps.localhost")),
        ).toThrow();
        expect(() =>
            parseAliasConfig(aliasEnv("https://control.apps.localhost", "apps.localhost")),
        ).toThrow();
        expect(() =>
            parseAliasConfig(aliasEnv("http://control.localhost:8443", "apps.localhost")),
        ).toThrow();
    });
    it("matches deployment hostnames", () => {
        expect(hostnamePattern().test("hello-abcdefghij-preview.apps.localhost")).toBe(true);
        expect(hostnamePattern().test("evil.example.com")).toBe(false);
    });
});

describe("credential commands", () => {
    it("are argument arrays with no secret and paths inside the state directory", () => {
        const c = credentialCommands(layout);
        for (const args of [c.sshKeygen, c.caKey, c.serverCsr, c.serverCert]) {
            expect(args[0]).toMatch(/^(ssh-keygen|openssl)$/);
            for (const arg of args.filter((a) => a.startsWith("/home"))) {
                expect(arg.startsWith(layout.dir + "/")).toBe(true);
            }
        }
        expect(c.sshKeygen).toContain("");
        expect(c.extensions).toContain("DNS:router");
        expect(OWNED_BY_SERVICE).toContain("backups");
    });
});

describe("socket group", () => {
    it("reads a numeric gid only", () => {
        expect(parseSocketGid("988\n")).toBe(988);
        expect(() => parseSocketGid("docker")).toThrow(DeployError);
        expect(() => parseSocketGid("-1")).toThrow(DeployError);
    });
});

describe("inventory", () => {
    it("derives the image tag from the id and never reads it", () => {
        const [site] = parseDatabaseRows(`${ID} lp-abcdefghij succeeded`);
        expect(site).toEqual({
            id: ID,
            app: "lp-abcdefghij",
            tag: `launchpad/site:${ID.replaceAll("-", "")}`,
        });
        const read = parseInventory(
            JSON.stringify({ sites: [{ id: ID, app: "lp-abcdefghij", tag: "evil:latest" }] }),
        );
        expect(read[0]!.tag).toBe(imageTagFor(ID));
    });

    it("rejects malformed rows", () => {
        for (const bad of [
            `${ID} lp-ABCDEFGHIJ x`,
            `nope lp-abcdefghij x`,
            `${ID} lp-abcdefghij x extra`,
            `${ID} ../etc x`,
        ]) {
            expect(() => parseDatabaseRows(bad), bad).toThrow();
        }
        for (const bad of [
            "not json",
            "{}",
            JSON.stringify({ sites: [{ id: ID, app: "x" }] }),
            JSON.stringify({ sites: [{ id: "1", app: "lp-abcdefghij" }] }),
        ]) {
            expect(() => parseInventory(bad), bad).toThrow();
        }
    });

    it("round-trips and merges by app, keeping a known id", () => {
        const a = parseDatabaseRows(`${ID} lp-abcdefghij x`);
        const text = renderInventory(project, a);
        expect(parseInventory(text)).toEqual(a);
        const bare = [
            { id: null, app: "lp-abcdefghij", tag: null },
            { id: null, app: "lp-zzzzzzzzzz", tag: null },
        ];
        const merged = mergeSites(bare, a);
        expect(merged.map((s) => s.app)).toEqual(["lp-abcdefghij", "lp-zzzzzzzzzz"]);
        expect(merged[0]!.id).toBe(ID);
        expect(parseInventory(renderInventory(project, merged))).toEqual(merged);
    });
});

describe("state record", () => {
    it("reads a complete record and treats anything else as none", () => {
        expect(parseState(JSON.stringify({ project, repo: REPO, version: "1" }))?.project).toBe(
            project,
        );
        expect(parseState("{")).toBeNull();
        expect(parseState(JSON.stringify({ project }))).toBeNull();
    });
});

describe("docker preflight", () => {
    const ok = { code: 0, output: "" };
    const good = {
        version: ok,
        compose: ok,
        buildx: { code: 0, output: "Driver: docker\nStatus: running\n" },
        info: { code: 0, output: "OSType: linux\n" },
        env: {},
    };
    it("accepts a native local engine", () => {
        expect(summarizeDockerProblems(good)).toBeNull();
    });
    it("names each problem", () => {
        expect(summarizeDockerProblems({ ...good, env: { DOCKER_HOST: "tcp://x" } })).toContain(
            "DOCKER_HOST",
        );
        expect(summarizeDockerProblems({ ...good, env: { DOCKER_CONTEXT: "x" } })).toContain(
            "DOCKER_CONTEXT",
        );
        expect(summarizeDockerProblems({ ...good, version: { code: 1, output: "" } })).toContain(
            "daemon",
        );
        expect(summarizeDockerProblems({ ...good, compose: { code: 1, output: "" } })).toContain(
            "Compose",
        );
        expect(
            summarizeDockerProblems({
                ...good,
                buildx: { code: 0, output: "Driver: docker-container\nStatus: running" },
            }),
        ).toContain("builder");
        expect(
            summarizeDockerProblems({
                ...good,
                info: { code: 0, output: "rootless\nOSType: linux" },
            }),
        ).toContain("Rootless");
    });
});

void path;

describe("command line", () => {
    it("takes a command and the two flags", () => {
        expect(parseArgs(["up"])).toEqual({ command: "up", help: false });
        expect(
            parseArgs(["up", "--port-base", "40000", "--project", "launchpad-local-x"]),
        ).toMatchObject({
            command: "up",
            portBase: 40000,
            project: "launchpad-local-x",
        });
        expect(parseArgs(["--help"]).help).toBe(true);
    });

    it("refuses what it does not know", () => {
        for (const bad of [
            [],
            ["wipe"],
            ["up", "--force"],
            ["up", "--port-base"],
            ["up", "--port-base", "x"],
            ["up", "--port-base", "80"],
            ["down", "--port-base", "40000"],
            ["up", "--project", "mine"],
        ]) {
            expect(() => parseArgs(bad), bad.join(" ")).toThrow(DeployError);
        }
    });

    it("lists every command and flag in --help", () => {
        for (const word of [...COMMANDS, ...VALUE_FLAGS, ...SWITCH_FLAGS])
            expect(HELP).toContain(word);
    });
});
