import { beforeEach, describe, expect, it } from "bun:test";
import { assertPrivateControlUrl } from "../packages/services/src/router-credentials";
import {
    parseAliasConfig,
    parseAppRoutingConfig,
    parseDeploymentConfig,
} from "../packages/services/src/app-routing-config";
import { createSmtpMailer, loadAuthConfig } from "../packages/auth/src/index";
import { DevHost } from "./dev-infra-fake";
import { PG_IMAGE } from "./local-deploy-fake";
import { DEV_COMPOSE_FILE } from "./compose-dev";
import {
    appEnv,
    composeEnv,
    COMMANDS,
    DEV_PROFILE,
    destroy,
    down,
    HELP,
    knownHostsLine,
    layoutFor,
    logsArgs,
    nginxBaseImage,
    OPTIONS,
    parseArgs,
    PORT_DEFAULTS,
    portsFrom,
    projectImages,
    projectNameFor,
    renderApp,
    seedController,
    seedScopes,
    status,
    up,
    type Deps,
    type Preset,
} from "./dev-infra";
import { appsNetwork, classifyDbQuery, DeployError, parseEnv } from "./local-docker";

let host: DevHost;
let project: string;
const deps = (extra: Partial<Deps> = {}): Deps => host.deps(extra) as Deps;
const fails = async (work: Promise<unknown>) => {
    try {
        await work;
    } catch (error) {
        expect(error).toBeInstanceOf(DeployError);
        return (error as Error).message;
    }
    throw new Error("did not fail");
};
const has = (needle: string) => host.events.filter((e) => e.includes(needle));
const ID1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const site = { id: ID1, app: "lp-abcdefghij", state: "succeeded" };

beforeEach(() => {
    host = new DevHost();
    project = projectNameFor(host.repo);
});

describe("arguments", () => {
    it("parses commands, the project, the preset and the aliases switch", () => {
        expect(parseArgs(["up"])).toMatchObject({ command: "up", help: false });
        expect(parseArgs(["up", "--preset", "deploy", "--aliases", "off"])).toMatchObject({
            preset: "deploy",
            aliases: false,
        });
        expect(parseArgs(["logs", "--service", "dokku"])).toMatchObject({ service: "dokku" });
        expect(parseArgs(["--help"]).help).toBe(true);
        expect(parseArgs(["up", "--project", "launchpad-dev-x1"]).project).toBe("launchpad-dev-x1");
        for (const command of COMMANDS) expect(HELP).toContain(command);
        for (const option of OPTIONS) expect(HELP).toContain(option.flag);
    });

    it("refuses what it cannot do", () => {
        expect(() => parseArgs([])).toThrow(DeployError);
        expect(() => parseArgs(["bogus"])).toThrow(/Unknown argument/);
        expect(() => parseArgs(["up", "--project", "launchpad-local-x"])).toThrow(/--project/);
        expect(() => parseArgs(["up", "--project", "mine"])).toThrow(/--project/);
        expect(() => parseArgs(["up", "--preset", "x"])).toThrow(/--preset/);
        expect(() => parseArgs(["up", "--aliases", "on"])).toThrow(/--preset deploy/);
        expect(() => parseArgs(["down", "--preset", "deploy"])).toThrow(/only apply to up/);
        expect(() => parseArgs(["up", "--service", "dokku"])).toThrow(/only applies to logs/);
        expect(() => parseArgs(["logs", "--service", "nope"])).toThrow(/--service/);
        expect(() => parseArgs(["up", "--new-key"])).toThrow(/only applies to seed/);
    });
});

describe("planning", () => {
    it("uses the documented port block, replaceable one by one", () => {
        expect(portsFrom({})).toEqual(PORT_DEFAULTS);
        expect(PORT_DEFAULTS).toEqual({
            postgres: 35432,
            adminer: 38080,
            smtp: 31025,
            mailpit: 38025,
            ssh: 33222,
            http: 33181,
            routerData: 33182,
            routerControl: 33183,
        });
        expect(portsFrom({ DEV_POSTGRES_PORT: "40000" }).postgres).toBe(40000);
        expect(() => portsFrom({ DEV_POSTGRES_PORT: "80" })).toThrow(/DEV_POSTGRES_PORT/);
        expect(() => portsFrom({ DEV_POSTGRES_PORT: "x" })).toThrow(/whole number/);
        expect(() => portsFrom({ DEV_POSTGRES_PORT: "33181" })).toThrow(
            /DEV_POSTGRES_PORT and DEV_DOKKU_HTTP_PORT/,
        );
        for (const reserved of ["3000", "5432", "55432", "32180", "32443"]) {
            expect(() => portsFrom({ DEV_POSTGRES_PORT: reserved })).toThrow(/reserved/);
        }
        expect(portsFrom({ DEV_POSTGRES_PORT: "32444" }).postgres).toBe(32444);
    });

    it("names the project and images by the checkout path, away from local:deploy", () => {
        expect(project).toMatch(/^launchpad-dev-[0-9a-f]{8}$/);
        expect(projectNameFor("/a")).not.toBe(projectNameFor("/b"));
        expect(projectImages(project)).toEqual({
            dokku: `${project}/dokku:local`,
            router: `${project}/router:local`,
        });
        expect(DEV_PROFILE.composeFiles(layoutFor(host.repo))).toEqual(["-f", DEV_COMPOSE_FILE]);
    });

    it("writes known_hosts the way the worker looks a non-default port up", () => {
        expect(knownHostsLine(33222, "ssh-ed25519 AAAA")).toBe(
            "[127.0.0.1]:33222 ssh-ed25519 AAAA\n",
        );
    });

    it("renders a compose.env that satisfies the Compose file", () => {
        const layout = layoutFor(host.repo);
        const env = composeEnv(
            layout,
            project,
            PORT_DEFAULTS,
            { postgresPassword: "p", authSecret: "a", instanceId: "i" },
            "1",
        );
        expect(env.DEV_PROJECT).toBe(project);
        expect(env.LAUNCHPAD_APPS_NETWORK).toBe(appsNetwork(project));
        expect(env.DOKKU_DATA_DIR).toBe(`${host.repo}/.dev-infra/dokku`);
        expect(env.DEV_ROUTER_CONTROL_PORT).toBe("33183");
    });
});

// The generated app settings must be accepted by the real parsers, so the docs and the code cannot drift.
describe("generated app settings against the real parsers", () => {
    const compose = () =>
        parseEnv(
            Object.entries(
                composeEnv(
                    layoutFor(host.repo),
                    project,
                    PORT_DEFAULTS,
                    {
                        postgresPassword: "pw",
                        authSecret: "s".repeat(64),
                        instanceId: "11111111-2222-4333-8444-555555555555",
                    },
                    "1",
                ),
            )
                .map(([k, v]) => `${k}=${v}`)
                .join("\n"),
        );
    const render = (preset: Preset, aliases: boolean) =>
        appEnv(layoutFor(host.repo), compose(), preset, aliases);
    const ROUTING = [
        "LAUNCHPAD_BASE_URL",
        "LAUNCHPAD_ALIAS_INSTANCE_ID",
        "LAUNCHPAD_ALIAS_CONTROL_URL",
        "LAUNCHPAD_APPS_PROXY_URL",
        "LAUNCHPAD_ALIAS_PROBE_URL",
        "LAUNCHPAD_ALIAS_CONTROL_TOKEN_FILE",
        "LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE",
    ];

    for (const aliases of [true, false]) {
        it(`deploy mode, aliases ${aliases ? "on" : "off"}: controller and worker are accepted`, () => {
            const { controller, worker } = render("deploy", aliases);
            expect(worker).not.toBeNull();
            for (const env of [controller, worker!]) {
                expect(parseDeploymentConfig(env).enabled).toBe(true);
                expect(parseAliasConfig(env).enabled).toBe(aliases);
                expect(parseAppRoutingConfig(env).enabled).toBe(true);
                expect(() =>
                    assertPrivateControlUrl(
                        new URL(env.LAUNCHPAD_ALIAS_CONTROL_URL!),
                        "LAUNCHPAD_ALIAS_CONTROL_URL",
                    ),
                ).not.toThrow();
                expect(env.LAUNCHPAD_ALIAS_CONTROL_CA_FILE).toBeUndefined();
            }
            const routing = parseAppRoutingConfig(controller);
            expect(routing.enabled && routing.aliasControlUrl.origin).toBe(
                "http://127.0.0.1:33183",
            );
            expect(controller.LAUNCHPAD_ALIASES).toBe(aliases ? "on" : "off");
            expect(worker!.LAUNCHPAD_ALIASES).toBe(aliases ? "on" : "off");
            expect(loadAuthConfig(controller).baseUrl).toBe("https://control.localhost:8443");
        });
    }

    it("deploy mode: removing any routing setting makes parseAppRoutingConfig throw", () => {
        for (const owner of ["controller", "worker"] as const) {
            for (const name of ROUTING) {
                const env = { ...render("deploy", true)[owner]! };
                if (!(name in env)) continue;
                delete env[name];
                expect(() => parseAppRoutingConfig(env)).toThrow();
            }
        }
        for (const name of ROUTING) {
            expect(name in render("deploy", true).controller).toBe(true);
        }
    });

    it("app mode: the controller is accepted and Mailpit's URL builds a mailer", () => {
        const { controller, worker } = render("app", true);
        expect(worker).toBeNull();
        const auth = loadAuthConfig(controller);
        expect(auth.enrollment).toBe("invitation");
        expect(auth.smtp).toEqual({
            url: "smtp://127.0.0.1:31025",
            from: "Launchpad <launchpad@localhost>",
        });
        expect(() => createSmtpMailer(auth.smtp!)).not.toThrow();
        expect(parseDeploymentConfig(controller).enabled).toBe(false);
        expect(parseAliasConfig(controller).enabled).toBe(false);
        expect(parseAppRoutingConfig(controller).enabled).toBe(false);
        expect(controller.LAUNCHPAD_BASE_URL).toBe("http://127.0.0.1:3000");
    });

    it("quotes the values a dotenv file would split", () => {
        const text = renderApp(render("app", true).controller);
        expect(text).toContain('LAUNCHPAD_EMAIL_FROM="Launchpad <launchpad@localhost>"');
        expect(text).not.toContain("pw@127.0.0.1:35432/launchpad\n\n");
    });

    it("uses absolute paths and the pinned base image", () => {
        const { worker } = render("deploy", true);
        expect(worker!.DOKKU_SSH_KEY_PATH).toBe(`${host.repo}/.dev-infra/credentials/id_ed25519`);
        expect(worker!.LAUNCHPAD_DATA_DIR).toBe(`${host.repo}/.dev-infra/data`);
        expect(worker!.LAUNCHPAD_BASE_IMAGE).toBe(nginxBaseImage());
        expect(worker!.DOKKU_SSH_PORT).toBe("33222");
    });

    it("chooses the key scopes from the controller settings", () => {
        expect(seedScopes(render("app", true).controller)).toHaveLength(4);
        expect(seedScopes(render("deploy", false).controller)).toHaveLength(6);
        expect(seedScopes(render("deploy", true).controller)).toHaveLength(8);
    });
});

describe("up", () => {
    it("builds, starts, bootstraps once and writes the app settings", async () => {
        const summary = await up(deps());
        expect(summary.preset).toBe("app");
        const order = [
            "compose build --builder default dokku router",
            "compose up -d --no-build postgres mailpit dokku",
            "network:set --global initial-network",
            "ssh-keys:add launchpad-worker",
            "compose run --rm --no-deps --pull never -T router init --token-stdin",
            "compose up -d --no-build",
        ];
        let from = 0;
        for (const needle of order) {
            const at = host.events.findIndex((e, i) => i >= from && e.includes(needle));
            expect(at).toBeGreaterThanOrEqual(from);
            from = at + 1;
        }
        expect(host.text(`${host.dir}/credentials/known_hosts`)).toBe(
            "[127.0.0.1]:33222 ssh-ed25519 AAAADOKKUHOSTKEY\n",
        );
        expect(host.text(`${host.dir}/credentials/epoch`)).toBe(
            "d9a4ff5b-d607-41ac-84aa-b0d64c4c4cba\n",
        );
        expect(host.text(`${host.dir}/env/controller.env`)).toContain("LAUNCHPAD_DEPLOYMENTS=off");
        expect(host.text(`${host.dir}/env/worker.env`)).toBeNull();
        expect(host.children(host.dir)).toEqual(
            ["compose.env", "credentials", "data", "dokku", "env", "state.json"].sort(),
        );
        expect(host.nodes.get(`${host.dir}/env/controller.env`)).toMatchObject({ mode: 0o600 });
        expect(host.nodes.get(`${host.dir}/dokku`)).toMatchObject({ mode: 0o755 });
        expect(host.nodes.get(host.dir)).toMatchObject({ mode: 0o700 });
        // The app's own settings are never written.
        expect(host.files(host.repo).some((f) => f.includes(".env.local"))).toBe(false);
    });

    it("needs neither openssl nor a chown, and never prunes", async () => {
        await up(deps({}));
        await destroy(deps());
        const all = host.calls.map((a) => a.join(" "));
        expect(all.some((c) => c.startsWith("openssl"))).toBe(false);
        expect(all.some((c) => /\bchown\b/.test(c))).toBe(false);
        expect(all.some((c) => /\bprune\b/.test(c))).toBe(false);
        expect(host.calls.some((a) => a.includes("--privileged"))).toBe(false);
    });

    it("writes the deploy preset with a worker file and prints no secret", async () => {
        const summary = await up(deps(), { preset: "deploy", aliases: false });
        expect(summary.workerEnv).toBe(`${host.dir}/env/worker.env`);
        const worker = host.text(`${host.dir}/env/worker.env`)!;
        expect(worker).toContain("LAUNCHPAD_ALIASES=off");
        expect(worker).toContain("DOKKU_SSH_PORT=33222");
        const compose = parseEnv(host.text(`${host.dir}/compose.env`)!);
        const secrets = [
            compose.POSTGRES_PASSWORD!,
            compose.DEV_AUTH_SECRET!,
            host.text(`${host.dir}/credentials/token`)!.trim(),
        ];
        const output = host.logs.join("\n");
        for (const secret of secrets) {
            expect(secret.length).toBeGreaterThan(20);
            expect(output).not.toContain(secret);
        }
        expect(output).toContain(
            `install -m 600 ${host.dir}/env/controller.env apps/controller/.env.local`,
        );
        // Switching back to the app preset removes the worker file.
        await up(deps(), { preset: "app" });
        expect(host.text(`${host.dir}/env/worker.env`)).toBeNull();
    });

    it("is idempotent: a second run keeps the secrets and does not bootstrap again", async () => {
        await up(deps());
        const before = host.text(`${host.dir}/compose.env`);
        const token = host.text(`${host.dir}/credentials/token`);
        host.calls.length = 0;
        host.events.length = 0;
        await up(deps());
        expect(host.text(`${host.dir}/compose.env`)).toBe(before);
        expect(host.text(`${host.dir}/credentials/token`)).toBe(token);
        expect(has("router init")).toEqual([]);
        expect(has("network:set")).toEqual([]);
    });

    const stripPorts = (...keys: string[]) => {
        const recorded = parseEnv(host.text(`${host.dir}/compose.env`)!);
        for (const key of keys) delete recorded[key];
        const text = Object.entries(recorded)
            .map(([key, value]) => `${key}=${value}\n`)
            .join("");
        host.addFile(`${host.dir}/compose.env`, text, 0o600);
        return recorded;
    };

    it("upgrades a record written before a port existed, without destroying it", async () => {
        await up(deps());
        // A `compose.env` from before Adminer: drop its port key, as an older tool would have written it.
        const recorded = stripPorts("DEV_ADMINER_PORT");
        const token = host.text(`${host.dir}/credentials/token`);

        // `status` works against the un-upgraded record and does not rewrite it.
        await status(deps());
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_ADMINER_PORT).toBeUndefined();

        host.events.length = 0;
        await up(deps());

        const after = parseEnv(host.text(`${host.dir}/compose.env`)!);
        expect(after.DEV_ADMINER_PORT).toBe("38080");
        expect(after.POSTGRES_PASSWORD).toBe(recorded.POSTGRES_PASSWORD!);
        expect(after.DEV_AUTH_SECRET).toBe(recorded.DEV_AUTH_SECRET!);
        expect(host.text(`${host.dir}/credentials/token`)).toBe(token);
        // Atomic: the record is replaced by a rename of this run's own temporary file, never in place.
        expect(host.events.filter((e) => e === "write compose.env")).toEqual([]);
        const written = host.events.filter((e) => /^write compose\.env\..+\.next$/.test(e));
        expect(written).toHaveLength(1);
        expect(host.events).toContain(
            `${written[0]!.replace(/^write /, "rename ")} -> compose.env`,
        );
    });

    it("retries an upgrade after a kill left an older temporary file behind", async () => {
        await up(deps());
        stripPorts("DEV_ADMINER_PORT");
        host.addFile(`${host.dir}/compose.env.next`, "POSTGRES_PASS", 0o600);
        await up(deps());
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_ADMINER_PORT).toBe("38080");
        // The leftover of the older naming is tolerated, not renamed into the record.
        expect(host.text(`${host.dir}/compose.env.next`)).toBe("POSTGRES_PASS");
        expect(host.children(host.dir).filter((n) => /^compose\.env\..+\.next$/.test(n))).toEqual(
            [],
        );
    });

    it("upgrades a record missing more than one port key", async () => {
        await up(deps());
        const recorded = stripPorts("DEV_ADMINER_PORT", "DEV_DOKKU_SSH_PORT");
        await up(deps());
        const after = parseEnv(host.text(`${host.dir}/compose.env`)!);
        expect(after.DEV_ADMINER_PORT).toBe("38080");
        expect(after.DEV_DOKKU_SSH_PORT).toBe("33222");
        expect(after.POSTGRES_PASSWORD).toBe(recorded.POSTGRES_PASSWORD!);
    });

    it("lets the environment choose a missing port, and keeps it in the record", async () => {
        await up(deps());
        stripPorts("DEV_ADMINER_PORT");
        await up(deps({ env: { HOME: "/home/dev", DEV_ADMINER_PORT: "39090" } }));
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_ADMINER_PORT).toBe("39090");
    });

    it("does not point at down for an impossible recorded port", async () => {
        await up(deps());
        const recorded = parseEnv(host.text(`${host.dir}/compose.env`)!);
        recorded.DEV_ADMINER_PORT = "not-a-port";
        host.addFile(
            `${host.dir}/compose.env`,
            Object.entries(recorded)
                .map(([key, value]) => `${key}=${value}\n`)
                .join(""),
            0o600,
        );
        const message = await fails(up(deps()));
        expect(message).toContain("DEV_ADMINER_PORT");
        expect(message).not.toMatch(/run down|run destroy|run destroy first/i);
    });

    it("leaves the record alone when the upgrade's port is busy or clashes", async () => {
        await up(deps());
        stripPorts("DEV_ADMINER_PORT");
        const before = host.text(`${host.dir}/compose.env`);
        host.busyPorts.add(38080);
        expect(await fails(up(deps()))).toContain("adminer port 38080");
        expect(host.text(`${host.dir}/compose.env`)).toBe(before);

        host.busyPorts.delete(38080);
        const clashing = parseEnv(before!);
        clashing.DEV_ROUTER_DATA_PORT = "38080";
        host.addFile(
            `${host.dir}/compose.env`,
            Object.entries(clashing)
                .map(([key, value]) => `${key}=${value}\n`)
                .join(""),
            0o600,
        );
        expect(await fails(up(deps()))).toContain("DEV_ADMINER_PORT and DEV_ROUTER_DATA_PORT");
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_ADMINER_PORT).toBeUndefined();
    });

    it("adopts the record another concurrent upgrade installed, instead of failing", async () => {
        await up(deps());
        stripPorts("DEV_ADMINER_PORT");
        // Simulate the loser of the race: the rename finds the temporary file already gone.
        const base = deps();
        const fs = base.fs;
        let renamed = false;
        const compose = `${host.dir}/compose.env`;
        const racy = {
            ...fs,
            rename: async (from: string, to: string) => {
                if (!renamed && to.endsWith("compose.env")) {
                    renamed = true;
                    // The competing run's rename lands first: its complete record is now in place.
                    const winner = { ...parseEnv(host.text(compose)!), DEV_ADMINER_PORT: "38080" };
                    host.addFile(
                        compose,
                        Object.entries(winner)
                            .map(([key, value]) => `${key}=${value}\n`)
                            .join(""),
                        0o600,
                    );
                    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
                }
                return fs.rename(from, to);
            },
        };
        await up({ ...base, fs: racy } as Deps);
        // The record keeps the earlier upgrade's values and is complete either way.
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_ADMINER_PORT).toBe("38080");
        expect(host.text(`${host.dir}/compose.env.next`)).toBeNull();
    });

    it("refuses a truncated record instead of writing a ports-only one", async () => {
        await up(deps());
        host.addFile(`${host.dir}/compose.env`, "", 0o600);
        const message = await fails(up(deps()));
        expect(message).toContain("looks truncated");
        expect(message).not.toMatch(/run down|run destroy/i);
        expect(host.text(`${host.dir}/compose.env`)).toBe("");
    });

    it("refuses a record that lost a secret even when every port is present", async () => {
        await up(deps());
        stripPorts("DEV_AUTH_SECRET");
        const recorded = host.text(`${host.dir}/compose.env`);
        const env = host.text(`${host.dir}/env/controller.env`);
        expect(await fails(up(deps()))).toContain("DEV_AUTH_SECRET");
        expect(host.text(`${host.dir}/compose.env`)).toBe(recorded);
        // Nothing was rendered with an undefined secret.
        expect(host.text(`${host.dir}/env/controller.env`)).toBe(env);
        expect(env).not.toContain("undefined");
    });

    it("keeps the rewritten record at mode 600", async () => {
        await up(deps());
        stripPorts("DEV_ADMINER_PORT");
        host.addFile(`${host.dir}/compose.env.next`, "stale", 0o644);
        await up(deps());
        expect(host.nodes.get(`${host.dir}/compose.env`)?.mode).toBe(0o600);
        // The unique temporary file is created fresh, so a stale one cannot lend it a wider mode.
        expect(host.children(host.dir).filter((n) => /^compose\.env\..+\.next$/.test(n))).toEqual(
            [],
        );
    });

    it("refuses a busy port before writing secrets", async () => {
        host.busyPorts.add(35432);
        expect(await fails(up(deps()))).toContain("postgres port 35432");
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(false);
    });

    it("refuses a state directory that git would not ignore or that it tracks", async () => {
        host.ignored = false;
        expect(await fails(up(deps()))).toContain("not ignored by git");
        expect(host.nodes.has(host.dir)).toBe(false);
        host.ignored = true;
        host.trackedFiles = [".dev-infra/state.json"];
        expect(await fails(up(deps()))).toContain("tracked by git");
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("refuses a directory it did not create, with advice that works", async () => {
        host.addDir(host.dir, 0o700);
        host.addFile(`${host.dir}/mine.txt`);
        const message = await fails(up(deps()));
        expect(message).toContain("without a state.json");
        // `destroy` refuses this directory, so the message may not send the user there.
        expect(message).toMatch(/remove it by hand/i);
        expect(message).not.toMatch(/run destroy first/i);
    });

    it("honours a port override from the environment on the first run only", async () => {
        await up(deps({ env: { HOME: "/home/dev", DEV_POSTGRES_PORT: "40000" } }));
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_POSTGRES_PORT).toBe("40000");
        await up(deps());
        expect(parseEnv(host.text(`${host.dir}/compose.env`)!).DEV_POSTGRES_PORT).toBe("40000");
    });

    it("removes a killed upgrade's temporary file, then the directory", async () => {
        await up(deps());
        // A kill between the per-run write and its rename leaves this behind.
        host.addFile(`${host.dir}/compose.env.4242-deadbeef.next`, "DEV_PROJECT=x\n", 0o600);
        await destroy(deps());
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("refuses another checkout's record", async () => {
        await up(deps());
        host.addFile(
            `${host.dir}/state.json`,
            JSON.stringify({ project, repo: "/home/dev/other", version: "1" }),
        );
        expect(await fails(up(deps()))).toContain("belongs to project");
    });
});

describe("down", () => {
    it("stops the services and the site containers and keeps everything else", async () => {
        await up(deps());
        host.deploySite(project, site);
        host.calls.length = 0;
        host.events.length = 0;
        const before = host.snapshot();
        await down(deps());
        expect(has("stop --time 30 lp-abcdefghij.web.1")).toHaveLength(1);
        expect(has("compose stop")).toHaveLength(1);
        expect(host.snapshot()).toEqual(before);
        expect(host.containers.every((c) => c.state === "exited")).toBe(true);
        expect(host.nodes.has(`${host.dir}/credentials/token`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(true);
        expect(host.logs.join("\n")).toContain("Stopped 1 site container");
        // up starts it all again without bootstrapping.
        host.calls.length = 0;
        host.events.length = 0;
        await up(deps());
        expect(has("router init")).toEqual([]);
        expect(host.projectContainers(project).every((c) => c.state === "running")).toBe(true);
    });

    it("does not stop a container that only looks like a site", async () => {
        await up(deps());
        host.deploySite(project, site);
        const impostor = host.add("lp-zzzzzzzzzz.web.1", "", "web", {
            labels: { "com.dokku.app-name": "something-else" },
        });
        host.networks.get(appsNetwork(project))!.members.push(impostor.name);
        await down(deps());
        expect(impostor.state).toBe("running");
    });

    it("says so when there is nothing here", async () => {
        await down(deps());
        expect(host.logs.join("\n")).toContain("nothing to stop");
    });
});

describe("destroy", () => {
    const protectedThings = () => {
        host.add("cloudflare-connector", "", "", { labels: {} });
        host.add("launchpad-test-db", "", "", { labels: {} });
        host.images.set("cloudflare/cloudflared:latest", "aaaaaaaaaaaa");
        host.images.set("launchpad/dokku:0.38.34", "bbbbbbbbbbbb");
        host.volumes.set("their-volume", "someone-else");
        host.networks.set("their-network", { project: "someone-else", members: [] });
        return host.snapshot();
    };

    it("removes everything it created and nothing else, after a down", async () => {
        const mine = protectedThings();
        await up(deps());
        host.deploySite(project, site);
        await down(deps());
        await destroy(deps());
        expect(host.snapshot()).toEqual(mine);
        expect(host.nodes.has(host.dir)).toBe(false);
        // Dokku was started again to destroy the site, then everything was removed.
        expect(has("apps:destroy lp-abcdefghij --force")).toHaveLength(1);
        expect(has("image rm launchpad/site:")).toHaveLength(1);
    });

    it("removes a running stack with a site, in the planned order", async () => {
        const mine = protectedThings();
        await up(deps());
        host.deploySite(project, site);
        host.events.length = 0;
        await destroy(deps());
        expect(host.snapshot()).toEqual(mine);
        expect(host.nodes.has(host.dir)).toBe(false);
        const at = (needle: string) => host.events.findIndex((e) => e.includes(needle));
        expect(at("apps:destroy")).toBeGreaterThan(-1);
        expect(at("apps:destroy")).toBeLessThan(at("compose down --volumes"));
        expect(at("compose down --volumes")).toBeLessThan(at("--entrypoint rm"));
        expect(at("--entrypoint rm")).toBeLessThan(at(`image rm ${project}/dokku:local`));
    });

    it("removes the root-owned children by exact name with the pinned helper", async () => {
        await up(deps());
        await destroy(deps());
        const helper = host.calls.find((a) => a.includes("--entrypoint"))!;
        expect(helper.slice(helper.indexOf("--entrypoint") + 1)).toEqual([
            "rm",
            PG_IMAGE,
            "-rf",
            "/state/dokku",
            "/state/credentials",
            "/state/data",
            "/state/env",
        ]);
        expect(helper).toContain("--network");
        expect(helper[helper.indexOf("--network") + 1]).toBe("none");
        expect(helper[helper.indexOf("--user") + 1]).toBe("0");
    });

    it("refuses to remove an image that lacks the project label", async () => {
        await up(deps());
        host.imageLabels.set(`${project}/router:local`, "launchpad-dev-someoneelse");
        expect(await fails(destroy(deps()))).toContain("does not carry the label");
        expect(host.images.has(`${project}/router:local`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
    });

    it("refuses a project that has resources but no record, and a foreign directory", async () => {
        host.add("x", project, "dokku");
        expect(await fails(destroy(deps()))).toContain("does not exist");
        host.containers = [];
        host.addDir(host.dir, 0o700);
        host.addFile(`${host.dir}/mine.txt`);
        expect(await fails(destroy(deps()))).toContain("refusing to remove anything");
    });

    it("refuses a symlinked or foreign-owned state directory", async () => {
        await up(deps());
        host.nodes.set(host.dir, { kind: "dir", uid: 0, mode: 0o700 });
        expect(await fails(destroy(deps()))).toContain("owned by another user");
        host.nodes.set(host.dir, { kind: "link", uid: host.uid, mode: 0o777, target: "/etc" });
        expect(await fails(destroy(deps()))).toContain("real directory");
    });

    it("says nothing was removed when the helper fails and keeps the directory", async () => {
        await up(deps());
        host.helperFails = true;
        const message = await fails(destroy(deps()));
        expect(message).toContain("is kept");
        expect(message).toContain("then run destroy again");
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
    });
});

describe("refusals remove nothing", () => {
    const corrupt = async () => {
        await up(deps());
        host.addFile(`${host.dir}/state.json`, "{not json");
        return host.snapshot();
    };

    it("refuses a corrupt state.json in down and destroy", async () => {
        const before = await corrupt();
        expect(await fails(down(deps()))).toBeTruthy();
        const message = await fails(destroy(deps()));
        expect(message).toContain("unreadable");
        expect(message).toContain("docker rm -f");
        expect(message).toContain("sudo rm -rf");
        expect(host.snapshot()).toEqual(before);
        expect(host.nodes.has(`${host.dir}/credentials/token`)).toBe(true);
        expect(has("compose stop")).toEqual([]);
    });

    it("starts a stopped Dokku through the hook before destroying", async () => {
        await up(deps());
        host.deploySite(project, site);
        await down(deps());
        host.events.length = 0;
        await destroy(deps());
        const start = host.events.findIndex((e) => e.includes("up -d --no-build postgres dokku"));
        expect(start).toBeGreaterThan(-1);
        expect(start).toBeLessThan(host.events.findIndex((e) => e.includes("apps:destroy")));
        expect(start).toBeLessThan(host.events.findIndex((e) => e.includes("compose down")));
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("refuses down with a missing compose.env and removes nothing", async () => {
        await up(deps());
        host.nodes.delete(`${host.dir}/compose.env`);
        const before = host.snapshot();
        const message = await fails(down(deps()));
        expect(message).toContain("compose.env is missing");
        expect(message).not.toContain("run destroy");
        expect(message).toContain("destroy refuses too");
        expect(message).toContain("docker rm -f");
        expect(host.snapshot()).toEqual(before);
        expect(has("compose stop")).toEqual([]);
        expect(host.nodes.has(`${host.dir}/credentials/token`)).toBe(true);
    });
});

describe("review findings", () => {
    const failing = (match: (a: string[]) => boolean) =>
        host.failures.push((args) =>
            match(args) ? { code: 1, output: "boom", stdout: "" } : undefined,
        );

    it("reuses the recorded project on a plain up", async () => {
        await up(deps(), { project: "launchpad-dev-custom" });
        await up(deps());
        expect(host.projectContainers("launchpad-dev-custom").length).toBeGreaterThan(0);
        expect(await fails(up(deps(), { project: "launchpad-dev-other" }))).toContain(
            "belongs to project",
        );
    });

    it("regenerates a key pair whose public half is missing, before the router exists", async () => {
        await up(deps());
        host.nodes.delete(`${host.dir}/credentials/id_ed25519.pub`);
        host.addFile(`${host.dir}/credentials/epoch`, "", 0o600);
        await up(deps());
        expect(host.nodes.has(`${host.dir}/credentials/id_ed25519.pub`)).toBe(true);
    });

    it("stops nothing when the network members cannot be listed", async () => {
        await up(deps());
        host.deploySite(project, site);
        failing(
            (a) =>
                a.includes("network") &&
                a.includes("inspect") &&
                a.some((x) => x.includes("Containers")),
        );
        expect(await fails(down(deps()))).toContain("Listing the members");
        expect(has("compose stop")).toEqual([]);
        expect(host.containers.every((c) => c.state === "running")).toBe(true);
    });

    it("does not stop when the Dokku container cannot be looked up", async () => {
        await up(deps());
        failing((a) => a.includes("ps") && a.includes("{{.ID}}"));
        expect(await fails(down(deps()))).toContain("Looking for the Dokku container");
        expect(has("compose stop")).toEqual([]);
    });

    it("removes no site container whose project label cannot be read", async () => {
        await up(deps());
        host.deploySite(project, site);
        failing(
            (a) =>
                a.includes("inspect") &&
                a.some((x) => x.includes("com.docker.compose.project")) &&
                a.at(-1)!.length === 64,
        );
        expect(await fails(destroy(deps()))).toContain("project label");
        expect(has("rm -f")).toEqual([]);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
    });

    it("refuses a record-less directory when the project image exists", async () => {
        host.addDir(host.dir, 0o700);
        host.images.set(`${project}/router:local`, "aaaaaaaaaaaa");
        host.imageLabels.set(`${project}/router:local`, project);
        expect(await fails(destroy(deps()))).toContain("has images");
        expect(host.images.has(`${project}/router:local`)).toBe(true);
    });

    it("checks compose.env before removing anything in destroy", async () => {
        await up(deps());
        host.deploySite(project, site);
        host.nodes.delete(`${host.dir}/compose.env`);
        const before = host.snapshot();
        const message = await fails(destroy(deps()));
        expect(message).toContain("compose.env is missing");
        expect(message).toContain("docker rm -f");
        expect(message).toContain("sudo rm -rf");
        expect(host.snapshot()).toEqual(before);
        expect(has("apps:destroy")).toEqual([]);
    });

    it("removes the site image found only by the second discovery", async () => {
        await up(deps());
        host.deploySite(project, site, { inDb: false });
        let psqlCalls = 0;
        host.failures.push((args) => {
            if (args.includes("psql") && ++psqlCalls === 1)
                return { code: 1, output: "down", stdout: "" };
            if (args.includes("psql") && psqlCalls >= 2) {
                host.deployments = [site];
            }
            return undefined;
        });
        host.deployments = [];
        await destroy(deps());
        expect([...host.images.keys()].some((k) => k.startsWith("launchpad/site:"))).toBe(false);
        expect(host.nodes.has(host.dir)).toBe(false);
    });
});

describe("status and logs", () => {
    it("names Adminer in the summary, the status ports and the help", async () => {
        await up(deps());
        const text = host.logs.join("\n");
        expect(text).toMatch(/Adminer\s+http:\/\/127\.0\.0\.1:/);
        expect(text).toContain(`http://127.0.0.1:${PORT_DEFAULTS.adminer}`);
        expect(HELP).toContain("Adminer");
    });

    it("reports health, ports and the recorded sites", async () => {
        await up(deps());
        host.deploySite(project, site);
        host.logs.length = 0;
        await status(deps());
        const text = host.logs.join("\n");
        for (const service of ["postgres", "adminer", "mailpit", "dokku", "router"]) {
            expect(text).toContain(service);
        }
        expect(text).toContain("running healthy");
        expect(text).toContain("Recorded 1 deployment");
        expect(
            await fails(down(deps()).then(() => status(deps({ repo: "/nowhere" })))),
        ).toBeTruthy();
    });

    describe("when the database cannot be read", () => {
        const kept = async () => {
            await up(deps());
            host.deploySite(project, site);
            await status(deps());
            const before = host.text(`${host.dir}/inventory.json`);
            host.logs.length = 0;
            return before;
        };

        it("says the schema is not migrated and keeps the inventory", async () => {
            const before = await kept();
            host.dbSchema = false;
            host.deployments = [];
            await status(deps());
            expect(host.text(`${host.dir}/inventory.json`)).toBe(before);
            expect(host.logs.join("\n")).toContain("schema has not been migrated yet");
            expect(host.logs.join("\n")).not.toContain("not reachable");
        });

        it("says the database is not reachable after a connection failure", async () => {
            const before = await kept();
            host.dbUp = false;
            await status(deps());
            expect(host.text(`${host.dir}/inventory.json`)).toBe(before);
            expect(host.logs.join("\n")).toContain("The database is not reachable");
        });

        it("says the database is not reachable when postgres is not running", async () => {
            const before = await kept();
            for (const c of host.containers) {
                if (c.labels["com.docker.compose.service"] === "postgres") c.state = "exited";
            }
            await status(deps());
            expect(host.text(`${host.dir}/inventory.json`)).toBe(before);
            expect(host.logs.join("\n")).toContain("The database is not reachable");
        });
    });

    it("classifies a database query result", () => {
        const r = (code: number, output: string) => ({ code, output, stdout: "" });
        const verbose = (relation: string) =>
            `ERROR:  42P01: relation "${relation}" does not exist\nLOCATION:  parserOpenTable, parse_relation.c:1449`;
        expect(classifyDbQuery(r(0, ""))).toBe("ok");
        expect(classifyDbQuery(r(1, verbose("deployment")))).toBe("no-schema");
        expect(classifyDbQuery(r(1, 'ERROR: relation "deployment" does not exist'))).toBe(
            "no-schema",
        );
        expect(classifyDbQuery(r(1, verbose("other")))).toBe("unreachable");
        expect(classifyDbQuery(r(2, "could not connect to server"))).toBe("unreachable");
        expect(classifyDbQuery(r(1, "ERROR: 42501 permission denied"))).toBe("unreachable");
        expect(classifyDbQuery(r(1, "service not running"))).toBe("unreachable");
    });

    it("builds the logs command from the same project and env file", () => {
        const layout = layoutFor(host.repo);
        const args = logsArgs(layout, project, "dokku");
        expect(args).toContain("-p");
        expect(args[args.indexOf("--env-file") + 1]).toBe(layout.file("compose.env"));
        expect(args[args.indexOf("-f") + 1]).toBe(DEV_COMPOSE_FILE);
        expect(args.at(-1)).toBe("dokku");
    });
});

describe("seed", () => {
    it("seeds the controller with the scopes of its settings and a distinct profile", async () => {
        await up(deps(), { preset: "deploy" });
        const seen: any[] = [];
        await seedController(
            deps({
                seed: (async (seedDeps: unknown, options: unknown) => {
                    seen.push({ seedDeps, options });
                }) as never,
            }),
        );
        expect(seen).toHaveLength(1);
        expect(seen[0].seedDeps.scopes).toHaveLength(8);
        expect(seen[0].options.profile).toBe("dev-infra");
        expect(seen[0].options.origin).toBe("https://control.localhost:8443");
        expect(seen[0].options.controller).toBe("http://127.0.0.1:3000");
    });

    it("asks for up first", async () => {
        expect(await fails(seedController(deps()))).toContain("run up first");
    });
});

describe("up refusals before any write", () => {
    it("leaves no state for a reserved port on a fresh up", async () => {
        const before = host.snapshot();
        const message = await fails(
            up(deps({ env: { HOME: "/home/dev", DEV_POSTGRES_PORT: "5432" } })),
        );
        expect(message).toContain("reserved");
        expect(host.snapshot()).toEqual(before);
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("tells the losing concurrent up apart when mkdir finds the directory", async () => {
        const realMkdir = host.fs.mkdir;
        host.fs.mkdir = async (p, mode) => {
            host.addDir(p, 0o700);
            return realMkdir(p, mode);
        };
        expect(await fails(up(deps()))).toContain("is another up running? Nothing was changed.");
    });

    it("tells the losing concurrent up apart when state.json appears first", async () => {
        const realWrite = host.fs.writeFile;
        host.fs.writeFile = async (p, data, mode, exclusive) => {
            if (p.endsWith("/state.json")) host.addFile(p, "{}", 0o600);
            return realWrite(p, data, mode, exclusive);
        };
        expect(await fails(up(deps()))).toContain("is another up running? Nothing was changed.");
    });

    it("does not call a non-EEXIST write failure a race", async () => {
        const realWrite = host.fs.writeFile;
        host.fs.writeFile = async (p, data, mode, exclusive) => {
            if (p.endsWith("/state.json"))
                throw Object.assign(new Error("EACCES"), { code: "EACCES" });
            return realWrite(p, data, mode, exclusive);
        };
        await expect(up(deps())).rejects.toThrow("EACCES");
    });

    it("recovery text for a corrupt record uses --project, or does not guess a name", async () => {
        await up(deps());
        host.addFile(`${host.dir}/state.json`, "{not json");
        const named = await fails(up(deps(), { project: "launchpad-dev-abcd1234" }));
        expect(named).toContain("label=com.docker.compose.project=launchpad-dev-abcd1234");
        const unnamed = await fails(up(deps()));
        expect(unnamed).toContain("<project>");
        expect(unnamed).not.toContain(project);
    });
});
