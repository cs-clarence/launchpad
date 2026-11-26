import { beforeEach, describe, expect, it } from "bun:test";
import { FakeHost, PG_IMAGE } from "./local-deploy-fake";
import {
    appsNetwork,
    DeployError,
    down,
    imageTagFor,
    projectImages,
    projectNameFor,
    renderInventory,
    status,
    up,
    type Deps,
} from "./local-deploy";

let host: FakeHost;
let project: string;
const stubSeed = (async (_d: unknown, o: { org: string; project: string; profile: string }) => ({
    organization: o.org,
    project: o.project,
    profile: o.profile,
    keyIssued: true,
    passwordFiles: [],
})) as never;
const deps = (extra: Partial<Deps> = {}) =>
    host.deps({
        seed: stubSeed,
        fetch: (async () => {
            throw new Error("down must not call the API");
        }) as never,
        ...extra,
    });
const fails = async (work: Promise<unknown>) => {
    try {
        await work;
    } catch (error) {
        expect(error).toBeInstanceOf(DeployError);
        return (error as Error).message;
    }
    throw new Error("did not fail");
};
const ID1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "1a2b3c4d-d9cb-469f-a165-70867728950f";
const site = (n: 1 | 2, state = "succeeded") => ({
    id: n === 1 ? ID1 : ID2,
    app: n === 1 ? "lp-abcdefghij" : "lp-klmnopqrst",
    state,
});
const baseline = () =>
    ({ containers: [], volumes: [], networks: [], images: [] }) as ReturnType<FakeHost["snapshot"]>;
const gone = () => {
    expect(host.snapshot()).toEqual(baseline());
    expect(host.nodes.has(host.dir)).toBe(false);
};
const at = (needle: string, from = 0) =>
    host.events.findIndex((e, i) => i >= from && e.includes(needle));

beforeEach(async () => {
    host = new FakeHost();
    project = projectNameFor(host.repo);
});
const ready = async () => {
    await up(deps());
    host.events.length = 0;
    host.calls.length = 0;
};

describe("down on a finished stack", () => {
    it("removes everything in the planned order", async () => {
        await ready();
        host.deploySite(project, site(1));
        await down(deps());
        gone();
        const order = [
            "stop --time 30",
            "stop --time 30",
            "top ",
            "compose exec -T postgres psql",
            "apps:list",
            "apps:destroy lp-abcdefghij --force",
            "compose exec -T postgres psql",
            "compose down --volumes --remove-orphans",
            "--entrypoint rm",
            `image rm ${project}/controller:local`,
            "unlink compose.env",
            "unlink override.json",
            "unlink inventory.json",
            "unlink state.json",
            "rmdir",
        ];
        let last = -1;
        for (const step of order) {
            const found = at(step, last + 1);
            expect(found, step).toBeGreaterThan(last);
            last = found;
        }
        expect(host.removedProfiles).toEqual(["http://127.0.0.1:32180"]);
    });

    it("writes the discovered union to inventory.json before the first destroy", async () => {
        await ready();
        host.deploySite(project, site(1));
        let seen: string | null = null;
        host.failures.push((args) => {
            if (args.includes("apps:destroy") && seen === null)
                seen = host.text(`${host.dir}/inventory.json`);
            return undefined;
        });
        await down(deps());
        expect(JSON.parse(seen!).sites).toEqual([{ id: ID1, app: "lp-abcdefghij" }]);
    });

    it("takes the writers' ids from their labels at down time and inspects each first", async () => {
        await ready();
        const old = host.containers.find(
            (c) => c.labels["com.docker.compose.service"] === "worker",
        )!;
        host.removeContainer(old.id);
        const fresh = host.add(`${project}-worker-1`, project, "worker");
        await down(deps());
        const stopAt = host.calls.findIndex((a) => a.includes("stop") && a.includes(fresh.id));
        expect(stopAt).toBeGreaterThan(-1);
        const inspectAt = host.calls.findIndex(
            (a) => a.includes("inspect") && a.includes(fresh.id),
        );
        expect(inspectAt).toBeGreaterThan(-1);
        expect(inspectAt).toBeLessThan(stopAt);
        expect(host.calls.some((a) => a.includes(old.id))).toBe(false);
    });

    it("refuses a container whose project label does not confirm", async () => {
        await ready();
        host.failures.push((args) =>
            args.includes("inspect") && args.some((a) => a.includes("compose.project"))
                ? { code: 0, output: "other\n", stdout: "other\n" }
                : undefined,
        );
        expect(await fails(down(deps()))).toContain("does not carry the project label");
        expect(host.projectContainers(project).length).toBeGreaterThan(0);
        expect(host.calls.some((a) => a.includes("stop"))).toBe(false);
    });

    it("leaves other images and networks alone, and removes only the five project tags", async () => {
        await ready();
        for (const own of [
            "postgres:17-alpine",
            "nginx:1.27-alpine",
            "launchpad/controller:local",
            "oven/bun:1.4.4",
        ]) {
            host.images.set(own, "aaaaaaaaaaaa");
        }
        host.networks.set("launchpad-apps", { project: "", members: [] });
        host.deploySite(project, site(1));
        await down(deps());
        expect(host.snapshot().images).toEqual([
            "launchpad/controller:local",
            "nginx:1.27-alpine",
            "oven/bun:1.4.4",
            "postgres:17-alpine",
        ]);
        expect(host.snapshot().networks).toEqual(["launchpad-apps"]);
        const removed = host.calls
            .filter((a) => a.includes("image") && a.includes("rm"))
            .map((a) => a[a.indexOf("rm") + 1]!);
        for (const ref of removed) {
            expect(
                ref === imageTagFor(ID1) ||
                    ref.startsWith("dokku/lp-") ||
                    Object.values(projectImages(project)).includes(ref),
                ref,
            ).toBe(true);
        }
        expect(removed.filter((r) => r.startsWith(`${project}/`))).toHaveLength(5);
    });

    it("builds every removal argument from validated records, with no wildcard, prefix or prune", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.deploySite(project, site(2));
        const known = new Set([
            ...host.containers.map((c) => c.id),
            ...Object.values(projectImages(project)),
            imageTagFor(ID1),
            imageTagFor(ID2),
            "dokku/lp-abcdefghij:latest",
            "dokku/lp-klmnopqrst:latest",
            appsNetwork(project),
        ]);
        await down(deps());
        for (const args of host.calls) {
            const text = args.join(" ");
            expect(text).not.toMatch(/prune|\*|system/);
            if (args.includes("rm") && args[3] !== "run" && args[3] !== "compose") {
                const target = args[args.length - 1]!;
                expect(known.has(target), text).toBe(true);
            }
        }
    });
});

describe("every deployment state is destroyed directly", () => {
    for (const state of [
        "running",
        "reconciliation-needed",
        "deleting",
        "active",
        "succeeded",
        "deleted",
    ]) {
        it(`${state}`, async () => {
            await ready();
            host.deploySite(project, site(1, state), { dokku: state !== "deleted" });
            await down(deps());
            gone();
            expect(host.calls.some((a) => a.join(" ").includes("/api/"))).toBe(false);
        });
    }

    it("removes every tag of the exact repositories, not only latest", async () => {
        await ready();
        host.deploySite(project, site(1), { tags: ["latest", "v1", "<none>"] });
        host.images.set("dokku/lp-abcdefghijx:latest", "bbbbbbbbbbbb");
        await down(deps());
        expect(host.snapshot().images).toEqual(["dokku/lp-abcdefghijx:latest"]);
    });
});

describe("the current CLI profile on down", () => {
    it("is reset only when up set it", async () => {
        await ready();
        await down(deps());
        expect(host.resets).toEqual([false]);
        host = new FakeHost();
        await up(
            deps({
                seed: (async () => {
                    host.current = "local-deploy";
                    return {
                        organization: "local",
                        project: "demo",
                        profile: "local-deploy",
                        keyIssued: true,
                        passwordFiles: [],
                    };
                }) as never,
            }),
        );
        await down(deps());
        expect(host.resets).toEqual([true]);
    });
});

describe("foreign containers and helper arguments", () => {
    it("never removes a container of another Compose project that carries the app label", async () => {
        await ready();
        host.deploySite(project, site(1));
        const foreign = host.add("other-web-1", "other-project", "web", {
            labels: {
                "com.docker.compose.project": "other-project",
                "com.dokku.app-name": "lp-abcdefghij",
            },
        });
        await down(deps());
        expect(host.containers.map((c) => c.id)).toContain(foreign.id);
        expect(host.calls.some((a) => a.includes("rm") && a.includes(foreign.id))).toBe(false);
    });

    it("chowns without following symlinks", async () => {
        await up(deps());
        const chown = host.calls.find((a) => a.includes("chown"))!;
        expect(chown.slice(chown.indexOf("chown") + 2, chown.indexOf("chown") + 4)).toEqual([
            "-h",
            "10001:10001",
        ]);
    });
});

describe("discovery", () => {
    it("aborts before any removal on a bad database row", async () => {
        await ready();
        host.deployments.push({ id: ID1, app: "lp-ABCDEFGHIJ", state: "x" });
        host.deploySite(project, site(2));
        expect(await fails(down(deps()))).toContain("Nothing was removed");
        expect(host.calls.some((a) => a.includes("apps:destroy") || a.includes("rm"))).toBe(false);
        expect(host.projectContainers(project).length).toBeGreaterThan(0);
    });

    it("aborts on a tampered or malformed inventory.json", async () => {
        await ready();
        for (const text of [
            JSON.stringify({ project, sites: [{ id: ID1, app: "../../etc" }] }),
            JSON.stringify({ project, sites: [{ id: "x", app: "lp-abcdefghij" }] }),
            "not json",
        ]) {
            host.addFile(`${host.dir}/inventory.json`, text);
            expect(await fails(down(deps()))).toContain("Nothing was removed");
        }
        expect(host.calls.some((a) => a.includes("apps:destroy"))).toBe(false);
    });

    it("derives the image tag from the id even when the file names another", async () => {
        await ready();
        host.addFile(
            `${host.dir}/inventory.json`,
            JSON.stringify({
                project,
                sites: [{ id: ID1, app: "lp-abcdefghij", tag: "postgres:17-alpine" }],
            }),
        );
        host.images.set("postgres:17-alpine", "aaaaaaaaaaaa");
        host.deploySite(project, site(1), { inDb: false });
        await down(deps());
        expect(host.snapshot().images).toEqual(["postgres:17-alpine"]);
    });

    it("ignores, reports and never destroys names that do not match", async () => {
        await ready();
        host.strangeApps = ["myblog"];
        host.networks.get(appsNetwork(project))!.members.push("redis.web.1", "my-other-container");
        await down(deps());
        expect(host.logs.join("\n")).toContain("Ignoring myblog");
        expect(host.logs.join("\n")).toContain("Ignoring my-other-container");
        expect(host.calls.some((a) => a.includes("myblog"))).toBe(false);
    });

    it("finds a deploy made after the last status when the database is down", async () => {
        await ready();
        host.deploySite(project, site(1));
        await status(deps());
        host.deploySite(project, site(2), { inDb: false });
        host.dbUp = false;
        await down(deps());
        expect(host.logs.join("\n")).toContain("database could not be read");
        // The app is found and destroyed; its image tag cannot be derived without an id.
        expect(host.logs.join("\n")).toContain("could not be derived");
        expect(host.snapshot().containers).toEqual([]);
        expect(host.snapshot().images).toEqual([imageTagFor(ID2)]);
    });

    it("scans the apps network only when it carries the project label", async () => {
        await ready();
        host.deploySite(project, site(1), { inDb: false });
        host.dokkuApps.delete("lp-abcdefghij");
        host.networks.get(appsNetwork(project))!.project = "someone-else";
        host.dbUp = false;
        // The foreign network is neither scanned, removed nor counted as ours: down finishes.
        await down(deps());
        expect(host.containers.some((c) => c.name === "lp-abcdefghij.web.1")).toBe(true);
        expect(host.networks.has(appsNetwork(project))).toBe(true);
        expect(host.nodes.has(host.dir)).toBe(false);
    });

    it("rejects an inventory that belongs to another project, before any removal", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.images.set(imageTagFor(ID2), "eeeeeeeeeeee");
        for (const body of [
            { project: "launchpad-local-00000000", sites: [{ id: ID2, app: "lp-klmnopqrst" }] },
            { sites: [{ id: ID2, app: "lp-klmnopqrst" }] },
        ]) {
            host.addFile(`${host.dir}/inventory.json`, JSON.stringify(body));
            expect(await fails(down(deps()))).toContain("belongs to another project");
        }
        expect(host.images.has(imageTagFor(ID2))).toBe(true);
        expect(host.calls.some((a) => a.includes("apps:destroy") || a.includes("rm"))).toBe(false);
    });

    it("says how to recover from a foreign inventory, and deleting it is safe", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.addFile(
            `${host.dir}/inventory.json`,
            JSON.stringify({ project: "launchpad-local-00000000", sites: [] }),
        );
        const message = await fails(down(deps()));
        expect(message).toContain(
            "Run status to rewrite it, or delete .local-deploy/inventory.json",
        );
        host.nodes.delete(`${host.dir}/inventory.json`);
        await down(deps());
        gone();
    });

    it("still accepts a matching inventory when the database is down", async () => {
        await ready();
        host.deploySite(project, site(1));
        await status(deps());
        host.dbUp = false;
        await down(deps());
        gone();
    });
});

describe("a project whose containers are already gone", () => {
    it("removes a leftover site container before the apps network", async () => {
        await ready();
        host.deploySite(project, site(1));
        await status(deps());
        for (const container of host.projectContainers(project)) host.removeContainer(container.id);
        expect(host.containers.map((c) => c.name)).toEqual(["lp-abcdefghij.web.1"]);
        host.calls.length = 0;
        host.events.length = 0;
        await down(deps());
        gone();
        expect(at("rm -f")).toBeGreaterThan(-1);
        expect(at("rm -f")).toBeLessThan(at("compose down"));
    });
});

describe("interruption between removals", () => {
    it("stops before clearing the root-owned state once the project is removed, then resumes", async () => {
        await ready();
        host.deploySite(project, site(1));
        const abort = new AbortController();
        host.failures.push((args) => {
            if (args.includes("down") && args.includes("--volumes")) abort.abort();
            return undefined;
        });
        expect(await fails(down(deps({ signal: abort.signal })))).toContain("Interrupted");
        expect(host.projectContainers(project)).toHaveLength(0);
        expect(host.calls.some((a) => a.includes("--entrypoint") && a.includes("rm"))).toBe(false);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/inventory.json`)).toBe(true);
        host.failures.length = 0;
        await down(deps());
        gone();
    });

    it("stops before the next site and keeps the state and the inventory, then resumes", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.deploySite(project, site(2));
        const abort = new AbortController();
        host.failures.push((args) => {
            if (args.includes("apps:destroy")) abort.abort();
            return undefined;
        });
        const message = await fails(down(deps({ signal: abort.signal })));
        expect(message).toContain("Interrupted");
        expect(host.calls.filter((a) => a.includes("apps:destroy"))).toHaveLength(1);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
        expect(JSON.parse(host.text(`${host.dir}/inventory.json`)!).sites).toHaveLength(2);
        host.failures.length = 0;
        await down(deps());
        gone();
    });
});

describe("preflight", () => {
    it("fails by name when Docker is down, removing nothing", async () => {
        await ready();
        host.dockerUp = false;
        expect(await fails(down(deps()))).toContain("Docker daemon");
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
    });

    it("fails when Dokku exists but is not running", async () => {
        await ready();
        host.containers.find((c) => c.labels["com.docker.compose.service"] === "dokku")!.state =
            "exited";
        const message = await fails(down(deps()));
        expect(message).toContain(`docker compose -p ${project} --env-file`);
        expect(message).toContain("start dokku postgres");
        expect(host.calls.some((a) => a.includes("stop"))).toBe(false);
        expect(host.nodes.has(host.dir)).toBe(true);
    });

    it("says nothing to remove when nothing exists, and refuses resources without a directory", async () => {
        await down(deps());
        expect(host.logs.join("\n")).toContain("Nothing to remove");
        host.add(`${project}-postgres-1`, project, "postgres");
        expect(await fails(down(deps()))).toContain("does not exist");
    });

    it("refuses a mismatching record, and a missing or corrupt one with resources or strangers", async () => {
        await ready();
        host.addFile(
            `${host.dir}/state.json`,
            JSON.stringify({ project, repo: "/elsewhere", version: "1" }),
        );
        expect(await fails(down(deps()))).toContain("belongs to project");
        host.addFile(`${host.dir}/state.json`, "{");
        expect(await fails(down(deps()))).toContain("unreadable");
        host.nodes.delete(`${host.dir}/state.json`);
        expect(await fails(down(deps()))).toContain("no state.json");
        expect(host.projectContainers(project).length).toBeGreaterThan(0);
    });

    it("refuses a directory with extra children when state.json is missing", async () => {
        host.addDir(host.dir, 0o700);
        host.addDir(`${host.dir}/dokku`, 0o755);
        host.addFile(`${host.dir}/notes.txt`, "mine");
        expect(await fails(down(deps()))).toContain("notes.txt");
        expect(host.nodes.has(`${host.dir}/notes.txt`)).toBe(true);
    });
});

describe("stragglers", () => {
    it("fails by name when a build keeps running, and a rerun succeeds", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.settleAfter = 1000;
        const message = await fails(down(deps()));
        expect(message).toContain("still running");
        expect(host.calls.some((a) => a.includes("apps:destroy"))).toBe(false);
        expect(host.nodes.has(host.dir)).toBe(true);
        host.settleAfter = 0;
        await down(deps());
        gone();
    });

    it("catches an app that appears after the destroy, and the rerun removes it", async () => {
        await ready();
        host.deploySite(project, site(1));
        let added = false;
        host.failures.push((args) => {
            if (args.includes("apps:destroy") && !added) {
                added = true;
                host.deploySite(project, site(2));
            }
            return undefined;
        });
        const message = await fails(down(deps()));
        expect(message).toContain("lp-klmnopqrst");
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(true);
        await down(deps());
        gone();
    });
});

describe("the root helper", () => {
    it("uses the pinned postgres image and removes only the four fixed names", async () => {
        await ready();
        await down(deps());
        const helper = host.calls.find((a) => a.includes("--entrypoint") && a.includes("rm"))!;
        expect(helper).toContain(PG_IMAGE);
        expect(helper.slice(helper.indexOf("-rf"))).toEqual([
            "-rf",
            ...["dokku", "backups", "credentials", "tls"].map((n) => `/state/${n}`),
        ]);
        expect(helper).toContain("--network");
        expect(helper[helper.indexOf("--network") + 1]).toBe("none");
        expect(helper.some((a) => a.includes("compose.env") || a === "/state")).toBe(false);
        expect(helper.some((a) => a.includes(projectImages(project).worker))).toBe(false);
    });

    it("works when the worker image was never built, pulling postgres if needed", async () => {
        host.killAt = { match: (a) => a.includes("build"), remaining: 0 };
        await expect(up(deps())).rejects.toThrow("killed");
        host.pulled.delete(PG_IMAGE);
        host.calls.length = 0;
        await down(deps());
        gone();
        expect(host.calls.some((a) => a.includes("pull"))).toBe(true);
    });

    it("refuses an unsafe state directory before running it", async () => {
        const cases: [string, () => void][] = [
            [
                "symlink",
                () =>
                    host.nodes.set(host.dir, {
                        kind: "link",
                        uid: 1000,
                        mode: 0o777,
                        target: "/etc",
                    }),
            ],
            ["owner", () => ((host.nodes.get(host.dir) as { uid: number }).uid = 0)],
            ["mode", () => ((host.nodes.get(host.dir) as { mode: number }).mode = 0o755)],
            ["realpath", () => host.realpaths.set(host.dir, "/somewhere/else")],
        ];
        for (const [name, tamper] of cases) {
            host = new FakeHost();
            await up(deps());
            host.calls.length = 0;
            tamper();
            await fails(down(deps()));
            expect(
                host.calls.some((a) => a.includes("--entrypoint")),
                name,
            ).toBe(false);
        }
    });

    it("keeps the directory and prints the manual commands when the helper cannot run", async () => {
        await ready();
        for (const k of host.files(`${host.dir}/dokku`))
            (host.nodes.get(k) as { uid: number }).uid = 0;
        host.nodes.set(`${host.dir}/dokku/home`, { kind: "dir", uid: 0, mode: 0o755 });
        host.helperFails = true;
        const message = await fails(down(deps()));
        expect(message).toContain(`sudo rm -rf ${host.dir}/dokku`);
        expect(message).toContain(`sudo rm -rf ${host.dir}/credentials`);
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/override.json`)).toBe(true);
        host.helperFails = false;
        await down(deps());
        gone();
    });
});

describe("interruption and rerun", () => {
    it("resumes after the Compose project is gone, using inventory.json for the tags", async () => {
        await ready();
        host.deploySite(project, site(1));
        host.killAt = {
            match: (a) => a.includes("--entrypoint") && a.includes("rm"),
            remaining: 0,
        };
        await expect(down(deps())).rejects.toThrow("killed");
        expect(host.projectContainers(project)).toHaveLength(0);
        host.images.set(imageTagFor(ID1), "cccccccccccc");
        host.images.set("dokku/lp-abcdefghij:latest", "dddddddddddd");
        host.calls.length = 0;
        await down(deps());
        gone();
        expect(host.calls.some((a) => a.includes("stop"))).toBe(false);
    });

    it("resumes after the first and after the last tag removal", async () => {
        for (const tag of ["controller", "admin"]) {
            host = new FakeHost();
            await up(deps());
            host.deploySite(project, site(1));
            host.killAt = {
                match: (a) => a.includes("rm") && a.includes(`${project}/${tag}:local`),
                remaining: 0,
            };
            await expect(down(deps())).rejects.toThrow("killed");
            await down(deps());
            gone();
        }
    });

    it("resumes after step 7 when interrupted before the record is removed", async () => {
        await ready();
        let first = true;
        const original = host.fs.unlink;
        host.fs.unlink = async (p) => {
            if (first) {
                first = false;
                throw new Error("killed");
            }
            return original(p);
        };
        await expect(down(deps())).rejects.toThrow("killed");
        expect(host.snapshot()).toEqual(baseline());
        await down(deps());
        gone();
    });

    it("treats a directory holding only state.json as clean, and finishes", async () => {
        host.addDir(host.dir, 0o700);
        host.addFile(
            `${host.dir}/state.json`,
            JSON.stringify({ project, repo: host.repo, version: "1" }),
        );
        await down(deps());
        gone();
    });

    it("refuses a missing state.json while the project still has resources", async () => {
        await ready();
        host.nodes.delete(`${host.dir}/state.json`);
        expect(await fails(down(deps()))).toContain("has resources");
        expect(host.projectContainers(project).length).toBeGreaterThan(0);
    });

    it("finishes a down interrupted in step 9 after state.json was the only file left", async () => {
        host.addDir(host.dir, 0o700);
        await down(deps());
        gone();
    });

    it("a failed verification keeps the files, exits nonzero, and a second down succeeds", async () => {
        await ready();
        host.deploySite(project, site(1));
        let once = true;
        host.failures.push((args) => {
            if (once && args.includes("rm") && args.includes(`${project}/router:local`)) {
                once = false;
                return { code: 1, output: "busy", stdout: "" };
            }
            return undefined;
        });
        expect(await fails(down(deps()))).toContain("Removing an image failed");
        expect(host.nodes.has(`${host.dir}/compose.env`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/override.json`)).toBe(true);
        expect(host.nodes.has(`${host.dir}/state.json`)).toBe(true);
        await down(deps());
        gone();
    });
});

describe("an interrupted up leaves a state down can clean", () => {
    const groups: [string, (a: string[]) => boolean][] = [
        ["after state.json, before images", (a) => a[0] === "stat"],
        ["before the images are built", (a) => a.includes("build")],
        [
            "before Dokku starts",
            (a) => a.includes("postgres") && a.includes("dokku") && a.includes("up"),
        ],
        ["during the bootstrap", (a) => a.includes("network:set")],
        ["before the router is initialised", (a) => a.includes("init")],
        ["before the migration", (a) => a.includes("migrate")],
        ["before the services start", (a) => a.includes("up") && !a.includes("postgres")],
    ];
    for (const [name, match] of groups) {
        it(name, async () => {
            host.killAt = { match, remaining: 0 };
            await expect(up(deps())).rejects.toThrow("killed");
            await down(deps());
            gone();
        });
    }

    it("after the services start", async () => {
        const failing = host.deps({
            seed: (async () => {
                throw new Error("killed");
            }) as never,
        });
        await expect(up(failing)).rejects.toThrow("killed");
        await down(deps());
        gone();
    });
});

void renderInventory;
