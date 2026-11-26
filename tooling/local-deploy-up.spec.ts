import { beforeEach, describe, expect, it } from "bun:test";
import { FakeHost } from "./local-deploy-fake";
import {
    appsNetwork,
    BASE_URL,
    DeployError,
    parseEnv,
    projectImages,
    projectNameFor,
    status,
    up,
    type Summary,
} from "./local-deploy";
import { DEPLOY_KEY_SCOPES, type Deps as SeedDeps, type Options } from "./local-seed";

let host: FakeHost;
let project: string;
let seeded: { deps: SeedDeps; options: Options }[];
let order: string[];
let stateBeforeFirstBuild: string | null;

const stubSeed = async (deps: SeedDeps, options: Options) => {
    seeded.push({ deps, options });
    order.push("seed");
    return {
        organization: options.org,
        project: options.project,
        profile: options.profile,
        keyIssued: true,
        passwordFiles: [],
    };
};
const deps = (extra = {}) => host.deps({ seed: stubSeed as never, ...extra });
const fails = async (work: Promise<unknown>) => {
    try {
        await work;
    } catch (error) {
        expect(error).toBeInstanceOf(DeployError);
        return (error as Error).message;
    }
    throw new Error("did not fail");
};

beforeEach(() => {
    host = new FakeHost();
    project = projectNameFor(host.repo);
    seeded = [];
    order = [];
    stateBeforeFirstBuild = null;
    host.failures.push((args) => {
        if (stateBeforeFirstBuild === null && args.includes("build")) {
            stateBeforeFirstBuild = host.text(`${host.dir}/state.json`) ?? "";
        }
        return undefined;
    });
});

describe("up on a fresh machine", () => {
    it("builds, bootstraps and seeds in the plan's order", async () => {
        const summary: Summary = await up(deps());
        expect(summary.project).toBe(project);
        expect(summary.ports).toEqual({
            controller: 32180,
            http: 32181,
            router: 32182,
            ssh: 32222,
            https: 32443,
        });
        const steps = [
            "compose build",
            "compose up -d --no-build postgres dokku",
            "compose exec -T dokku dokku network:set",
            "compose exec -T dokku dokku ssh-keys:add",
            "compose run --rm --no-deps --pull never -T router init --token-stdin",
            "run --rm --pull never --network none --user 0 --mount",
            "compose run --rm --no-deps --pull never -T admin migrate",
            "compose up -d --no-build",
        ];
        let last = -1;
        for (const step of steps) {
            const at = host.commands.findIndex((c, i) => i > last && c.includes(step));
            expect(at, step).toBeGreaterThan(last);
            last = at;
        }
        // The worker only exists after the router was initialised, the controller after migrate.
        expect(
            host
                .projectContainers(project)
                .map((c) => c.labels["com.docker.compose.service"])
                .sort(),
        ).toEqual(["controller", "dokku", "postgres", "router", "worker"]);
        expect(order).toEqual(["seed"]);
    });

    it("writes state.json before any Docker resource exists", async () => {
        await up(deps());
        expect(JSON.parse(stateBeforeFirstBuild!)).toEqual({
            project,
            repo: host.repo,
            version: "1",
        });
        const first = host.calls.findIndex((a) => a.includes("build"));
        expect(host.calls.slice(0, first).some((a) => a.includes("up"))).toBe(false);
    });

    it("keeps secrets in mode-600 files inside a mode-700 directory", async () => {
        await up(deps());
        expect(host.nodes.get(host.dir)).toMatchObject({ kind: "dir", mode: 0o700, uid: 1000 });
        for (const name of [
            "compose.env",
            "override.json",
            "state.json",
            "credentials/token",
            "credentials/id_ed25519",
        ]) {
            expect((host.nodes.get(`${host.dir}/${name}`) as { mode: number }).mode, name).toBe(
                0o600,
            );
        }
        for (const gone of ["tls/ca.key", "tls/server.csr", "tls/extensions", "tls/ca.srl"]) {
            expect(host.nodes.has(`${host.dir}/${gone}`), gone).toBe(false);
        }
        // The service user owns what it reads; the host user never needs it again.
        expect((host.nodes.get(`${host.dir}/credentials/token`) as { uid: number }).uid).toBe(
            10001,
        );
        expect(host.text(`${host.dir}/credentials/known_hosts`)).toContain(
            "dokku ssh-ed25519 AAAADOKKUHOSTKEY",
        );
        expect(host.text(`${host.dir}/credentials/epoch`)).toContain("d9a4ff5b");
    });

    it("puts no password, key or token in an argument or the output", async () => {
        await up(deps());
        const env = parseEnv(host.text(`${host.dir}/compose.env`)!);
        const secrets = [
            env.POSTGRES_PASSWORD!,
            env.LAUNCHPAD_AUTH_SECRET!,
            host.text(`${host.dir}/credentials/token`)!.trim(),
        ];
        const text = [...host.calls.flat(), ...host.logs].join("\n");
        for (const secret of secrets) {
            expect(secret.length).toBeGreaterThan(30);
            expect(text).not.toContain(secret);
        }
        // The token reaches the router on stdin only.
        const initAt = host.calls.findIndex((a) => a.includes("init"));
        expect(host.inputs[initAt]!.trim()).toBe(secrets[2]!);
    });

    it("runs docker only against the local socket and Compose with an explicit project", async () => {
        await up(deps());
        for (const args of host.calls.filter((a) => a[0] === "docker")) {
            expect(args.slice(0, 3)).toEqual(["docker", "--host", "unix:///var/run/docker.sock"]);
            if (args[3] === "compose" && args[4] !== "version") {
                expect(args[args.indexOf("-p") + 1]).toBe(project);
                expect(args).toContain("--env-file");
            }
        }
    });

    it("seeds the loopback controller as the deploy profile with six scopes", async () => {
        await up(deps());
        const { deps: seedDeps, options } = seeded[0]!;
        expect(options.controller).toBe("http://127.0.0.1:32180");
        expect(options.origin).toBe(BASE_URL);
        expect(options.profile).toBe("local-deploy");
        expect(seedDeps.scopes).toEqual(DEPLOY_KEY_SCOPES);
        expect(seedDeps.admin?.kind).toBe("compose");
        expect(options.ownerPasswordFile).toContain("local-deploy-owner.password");
    });

    it("binds only loopback and sets a unique apps network", async () => {
        await up(deps());
        const env = parseEnv(host.text(`${host.dir}/compose.env`)!);
        expect(env.LAUNCHPAD_APPS_NETWORK).toBe(appsNetwork(project));
        expect(Object.keys(env).filter((k) => /BIND_IP/.test(k))).toEqual([]);
        const override = JSON.parse(host.text(`${host.dir}/override.json`)!);
        expect(override.services.worker.image).toBe(projectImages(project).worker);
    });
});

describe("the admin profile", () => {
    it("is enabled only for the build, so up never starts the admin service", async () => {
        await up(deps());
        for (const args of host.calls.filter((a) => a[3] === "compose")) {
            const profiled = args.includes("--profile");
            expect(profiled, args.join(" ")).toBe(args.includes("build"));
        }
    });
});

describe("re-running up", () => {
    it("fixes ownership when an earlier run stopped before it", async () => {
        host.killAt = { match: (a) => a.includes("chown"), remaining: 0 };
        await expect(up(deps())).rejects.toThrow("killed");
        expect((host.nodes.get(`${host.dir}/credentials/epoch`) as { uid: number }).uid).toBe(1000);
        host.calls.length = 0;
        await up(deps());
        expect((host.nodes.get(`${host.dir}/credentials/epoch`) as { uid: number }).uid).toBe(
            10001,
        );
        expect(host.calls.some((a) => a.includes("init"))).toBe(false);
    });

    it("keeps files and bootstrap, and re-checks the stack", async () => {
        await up(deps());
        const env = host.text(`${host.dir}/compose.env`);
        const key = host.text(`${host.dir}/credentials/id_ed25519`);
        const before = host.calls.length;
        await up(deps());
        const again = host.calls.slice(before).map((a) => host.describe(a));
        expect(host.text(`${host.dir}/compose.env`)).toBe(env);
        expect(host.text(`${host.dir}/credentials/id_ed25519`)).toBe(key);
        expect(again.some((c) => /^(ssh-keygen|openssl)/.test(c))).toBe(false);
        expect(
            again.some((c) => c.includes("init --token-stdin") || c.includes("ssh-keys:add")),
        ).toBe(false);
        expect(host.projectContainers(project)).toHaveLength(5);
        expect(seeded).toHaveLength(2);
    });

    it("accepts a persisted port that its own container publishes, and refuses another owner", async () => {
        await up(deps());
        host.busyPorts.add(32180);
        host.busyPorts.add(32181);
        await up(deps());
        host.busyPorts.add(32222);
        const message = await fails(up(deps()));
        expect(message).toContain("ssh port 32222");
        expect(message).toContain("--port-base");
    });

    it("never moves the ports on a re-run", async () => {
        await up(deps());
        expect(await fails(up(deps(), { portBase: 40000 }))).toContain("Ports are fixed");
    });
});

describe("ports", () => {
    it("names a busy default and the option to move it, before writing anything", async () => {
        host.busyPorts.add(32181);
        const message = await fails(up(deps()));
        expect(message).toContain("http port 32181");
        expect(message).toContain("--port-base");
        expect(host.calls.some((a) => a.includes("build"))).toBe(false);
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(false);
    });

    it("uses another base from offsets 0, 1, 2, 42 and 263", async () => {
        host.busyPorts.add(32180);
        const summary = await up(deps(), { portBase: 40000 });
        expect(summary.ports).toEqual({
            controller: 40000,
            http: 40001,
            router: 40002,
            ssh: 40042,
            https: 40263,
        });
        const env = parseEnv(host.text(`${host.dir}/compose.env`)!);
        expect(env.DOKKU_SSH_HOST_PORT).toBe("40042");
    });

    it("refuses a base outside 1024..65272 without touching anything", async () => {
        for (const portBase of [1023, 65273]) {
            expect(await fails(up(deps(), { portBase }))).toContain("--port-base");
        }
        expect(host.calls).toHaveLength(0);
    });
});

describe("refusals", () => {
    it("refuses a project that is not launchpad-local-*", async () => {
        expect(await fails(up(deps(), { project: "launchpad" }))).toContain("--project");
        expect(host.calls).toHaveLength(0);
    });

    it("refuses labeled containers, volumes or networks without a matching record", async () => {
        const cases: [string, () => void][] = [
            ["container", () => void host.add(`${project}-postgres-1`, project, "postgres")],
            ["volume", () => void host.volumes.set(`${project}_postgres-data`, project)],
            [
                "network",
                () => void host.networks.set(`${project}_backend`, { project, members: [] }),
            ],
        ];
        for (const [kind, arrange] of cases) {
            host = new FakeHost();
            arrange();
            expect(await fails(up(deps())), kind).toContain("no matching .local-deploy/state.json");
            expect(host.nodes.has(host.dir), kind).toBe(false);
            expect(host.calls.some((a) => a.includes("build"))).toBe(false);
        }
    });

    it("refuses an existing project tag or apps network without a record", async () => {
        host.images.set(projectImages(project).worker, "abcdef012345");
        expect(await fails(up(deps()))).toContain("already has resources");
        host = new FakeHost();
        host.networks.set(appsNetwork(project), { project: "other", members: [] });
        expect(await fails(up(deps()))).toContain("already has resources");
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("refuses a state record for another project, path or version", async () => {
        host.addDir(host.dir, 0o700);
        for (const state of [
            { project: "launchpad-local-00000000", repo: host.repo, version: "1" },
            { project, repo: "/elsewhere", version: "1" },
            { project, repo: host.repo, version: "0" },
        ]) {
            host.addFile(`${host.dir}/state.json`, JSON.stringify(state));
            expect(await fails(up(deps()))).toContain("belongs to project");
        }
        host.addFile(`${host.dir}/state.json`, "{");
        expect(await fails(up(deps()))).toContain("unreadable");
    });

    it("refuses a state directory without a record, and an unsafe one", async () => {
        host.addDir(host.dir, 0o700);
        host.addFile(`${host.dir}/stray`, "x");
        expect(await fails(up(deps()))).toContain("without a state.json");
        host = new FakeHost();
        host.addDir(host.dir, 0o755);
        expect(await fails(up(deps()))).toContain("mode 700");
        host = new FakeHost();
        host.nodes.set(host.dir, { kind: "link", uid: 1000, mode: 0o777, target: "/etc" });
        expect(await fails(up(deps()))).toContain("real directory");
        host = new FakeHost();
        host.addDir(host.dir, 0o700, 0);
        expect(await fails(up(deps()))).toContain("another user");
    });

    it("refuses to write secrets where git does not ignore them", async () => {
        host.ignored = false;
        expect(await fails(up(deps()))).toContain("not ignored by git");
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("names Docker problems before touching anything", async () => {
        host.dockerUp = false;
        expect(await fails(up(deps()))).toContain("daemon");
        host.dockerUp = true;
        host.dockerEnv = { DOCKER_HOST: "tcp://elsewhere:2375" };
        expect(await fails(up(deps()))).toContain("DOCKER_HOST");
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("names a missing host tool", async () => {
        host.failures.push((args) =>
            args[0] === "openssl" ? { code: 127, output: "not found" } : undefined,
        );
        expect(await fails(up(deps()))).toContain("openssl");
    });
});

describe("waiting", () => {
    it("gives up on a Dokku that never becomes healthy and keeps everything", async () => {
        host.unhealthy.add("dokku");
        const message = await fails(up(deps()));
        expect(message).toContain("Timed out waiting for dokku");
        expect(message).toContain(`docker compose -p ${project} logs --tail 50 dokku`);
        expect(host.clock).toBeGreaterThanOrEqual(11 * 60_000);
        expect(host.projectContainers(project).length).toBeGreaterThan(0);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
        expect(host.logs.some((l) => l.includes("Still waiting for dokku"))).toBe(true);
    });

    it("stops waiting on an interrupt and leaves what exists", async () => {
        host.unhealthy.add("dokku");
        const abort = new AbortController();
        const base = host.deps({ seed: stubSeed as never, signal: abort.signal });
        base.sleep = async (ms) => {
            host.clock += ms;
            if (host.clock > 5000) abort.abort();
        };
        expect(await fails(up(base))).toContain("Interrupted");
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
    });

    it("says when a service exits", async () => {
        host.failures.push((args) => {
            if (host.describe(args).startsWith("compose up -d --no-build postgres dokku")) {
                queueMicrotask(() => undefined);
            }
            return undefined;
        });
        host.unhealthy.add("postgres");
        const original = host.run;
        host.run = async (args, input) => {
            const result = await original(args, input);
            if (host.describe(args).startsWith("compose up -d --no-build postgres dokku")) {
                for (const c of host.containers)
                    if (c.labels["com.docker.compose.service"] === "postgres") c.state = "exited";
            }
            return result;
        };
        expect(await fails(up(deps()))).toContain("postgres exited");
    });
});

describe("status", () => {
    it("shows health and ports and refreshes the inventory", async () => {
        await up(deps());
        host.deploySite(project, {
            id: "0f8fad5b-d9cb-469f-a165-70867728950e",
            app: "lp-abcdefghij",
            state: "running",
        });
        host.logs.length = 0;
        await status(deps());
        expect(host.logs.join("\n")).toContain("controller");
        expect(host.logs.join("\n")).toContain("32180");
        const inventory = JSON.parse(host.text(`${host.dir}/inventory.json`)!);
        expect(inventory.sites).toEqual([
            { id: "0f8fad5b-d9cb-469f-a165-70867728950e", app: "lp-abcdefghij" },
        ]);
    });

    it("keeps the inventory when the database is down", async () => {
        await up(deps());
        host.deploySite(project, {
            id: "0f8fad5b-d9cb-469f-a165-70867728950e",
            app: "lp-abcdefghij",
            state: "running",
        });
        await status(deps());
        const before = host.text(`${host.dir}/inventory.json`);
        host.dbUp = false;
        host.deployments = [];
        await status(deps());
        expect(host.text(`${host.dir}/inventory.json`)).toBe(before);
        expect(host.logs.join("\n")).toContain("not reachable");
    });

    it("needs a record", async () => {
        expect(await fails(status(deps()))).toContain("run up first");
    });
});
