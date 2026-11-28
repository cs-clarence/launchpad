// The in-memory machine of local-deploy-fake.ts with the Compose project of
// docker-compose.dev.yaml: five services, no override file, no admin service, and images that
// carry the com.launchpad.dev-project label.
import { DEV_COMPOSE_FILE } from "./compose-dev";
import { FakeHost } from "./local-deploy-fake";
import { LABEL_ONEOFF, LABEL_PROJECT, LABEL_SERVICE } from "./local-docker";
import type { RunResult } from "./local-seed";

const ok = (stdout = ""): RunResult => ({ code: 0, output: stdout, stdout });
const fail = (output = "error", code = 1): RunResult => ({ code, output, stdout: "" });

export class DevHost extends FakeHost {
    imageLabels = new Map<string, string>();

    constructor(repo = "/home/dev/launchpad") {
        super(repo);
        this.stateDirName = ".dev-infra";
    }

    describe(args: string[]): string {
        if (args[0] !== "docker") return args.join(" ");
        const rest = args.slice(args[1] === "--host" ? 3 : 1);
        if (rest[0] === "compose") {
            const start = rest.indexOf("-f") + 2;
            return `compose ${rest.slice(start).join(" ")}`;
        }
        return rest.join(" ");
    }

    protected composeCmd(all: string[], input?: string): RunResult {
        // -p P --env-file E -f F <sub...>
        const project = all[all.indexOf("-p") + 1]!;
        const envFile = all[all.indexOf("--env-file") + 1]!;
        if (all[all.indexOf("-f") + 1] !== DEV_COMPOSE_FILE) return fail("wrong compose file", 125);
        if (all.includes("--profile")) return fail("the dev file has no profiles", 125);
        const sub = all.slice(all.indexOf("-f") + 2);
        if (!this.nodes.get(envFile)) return fail("env file missing");
        const svc = (name: string) =>
            this.containers.find(
                (c) =>
                    c.labels[LABEL_PROJECT] === project &&
                    c.labels[LABEL_SERVICE] === name &&
                    c.labels[LABEL_ONEOFF] === "False",
            );
        switch (sub[0]) {
            case "build":
                for (const s of ["dokku", "router"]) {
                    const tag = `${project}/${s}:local`;
                    this.images.set(tag, this.id().slice(0, 12));
                    this.imageLabels.set(tag, project);
                }
                return ok();
            case "up": {
                const wanted = sub.filter((x) => !x.startsWith("-")).slice(1);
                const services =
                    wanted.length > 0
                        ? wanted
                        : ["postgres", "adminer", "mailpit", "dokku", "router"];
                for (const name of services) {
                    const existing = svc(name);
                    if (existing) {
                        if (existing.state !== "running") existing.state = "running";
                        continue;
                    }
                    const c = this.add(`${project}-${name}-1`, project, name, {
                        health: this.unhealthy.has(name) ? "starting" : "healthy",
                    });
                    c.networks = [`${project}_backend`];
                }
                for (const n of [`${project}_backend`, `${project}-apps`]) {
                    if (!this.networks.has(n)) this.networks.set(n, { project, members: [] });
                }
                for (const v of ["postgres-data", "router-state"]) {
                    this.volumes.set(`${project}_${v}`, project);
                }
                return ok();
            }
            case "stop":
                for (const c of this.containers) {
                    if (c.labels[LABEL_PROJECT] === project) c.state = "exited";
                }
                return ok();
            case "exec":
                return this.composeExec(project, sub.slice(1));
            case "run": {
                const at = sub.findIndex((x) => x === "router");
                if (at < 0) return fail("only the router runs one-off here", 125);
                const rest = sub.slice(at + 1);
                return rest[0] === "init" && input?.trim()
                    ? ok("compose noise\nd9a4ff5b-d607-41ac-84aa-b0d64c4c4cba\n")
                    : fail("init");
            }
            case "down": {
                if (!sub.includes("--volumes") || !sub.includes("--remove-orphans")) {
                    return fail("flags", 125);
                }
                for (const n of this.networks.values()) {
                    if (
                        n.project === project &&
                        n.members.some((m) => this.containers.some((c) => c.name === m))
                    ) {
                        return fail("network has active endpoints");
                    }
                }
                this.containers = this.containers.filter(
                    (c) => c.labels[LABEL_PROJECT] !== project,
                );
                for (const [n, v] of Array.from(this.volumes)) {
                    if (v === project) this.volumes.delete(n);
                }
                for (const [n, v] of Array.from(this.networks)) {
                    if (v.project === project) this.networks.delete(n);
                }
                return ok();
            }
            case "logs":
                return ok("log\n");
        }
        void svc;
        return fail(`unexpected compose ${sub.join(" ")}`, 125);
    }

    protected image(args: string[]): RunResult {
        if (args[0] === "inspect" && args.includes("-f")) {
            const template = args[args.indexOf("-f") + 1]!;
            const label = /index \.Config\.Labels "([^"]+)"/.exec(template)?.[1];
            const ref = args[args.length - 1]!;
            if (label) {
                if (!this.images.has(ref)) return fail("No such image");
                return ok(
                    `${label === "com.launchpad.dev-project" ? (this.imageLabels.get(ref) ?? "") : ""}\n`,
                );
            }
        }
        return super.image(args);
    }
}
