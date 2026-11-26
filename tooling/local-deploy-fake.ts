// An in-memory machine for the local deployment tests: a file system, a Docker engine with
// Compose and a Dokku, and the host commands the tool runs. Nothing here starts a process.
import { COMPOSE_FILE } from "./compose-production";
import {
    DOCKER_HOST,
    IMAGE_FORMAT,
    imageTagFor,
    LABEL_APP,
    LABEL_ONEOFF,
    LABEL_PROJECT,
    LABEL_SERVICE,
    NETWORK_LABEL_TEMPLATE,
    NETWORK_MEMBERS_TEMPLATE,
    PS_FORMAT,
    STATE_FORMAT,
    type Deps,
    type Fs,
    type FsStat,
} from "./local-deploy";
import type { RunResult } from "./local-seed";

type Node =
    | { kind: "dir"; uid: number; mode: number }
    | { kind: "file"; uid: number; mode: number; data: string }
    | { kind: "link"; uid: number; mode: number; target: string };

export const PG_IMAGE =
    "postgres:17-alpine@sha256:526f86d93c6ea08fd3f1fe5605650cacc781b2c6013169a0ad8f42c7d3d84f32";

interface Container {
    id: string;
    name: string;
    labels: Record<string, string>;
    state: string;
    health: string;
    ports: string;
    networks: string[];
}

export interface Deployment {
    id: string;
    app: string;
    state: string;
}

const ok = (stdout = ""): RunResult => ({ code: 0, output: stdout, stdout });
const fail = (output = "error", code = 1): RunResult => ({ code, output, stdout: "" });

export class FakeHost {
    nodes = new Map<string, Node>();
    calls: string[][] = [];
    inputs: (string | undefined)[] = [];
    logs: string[] = [];
    clock = 0;
    uid = 1000;
    ignored = true;
    trackedFiles: string[] = [];
    dockerUp = true;
    dockerEnv: Record<string, string | undefined> = {};
    busyPorts = new Set<number>();
    containers: Container[] = [];
    volumes = new Map<string, string>();
    networks = new Map<string, { project: string; members: string[] }>();
    images = new Map<string, string>(); // ref -> id
    pulled = new Set<string>([PG_IMAGE]);
    dokkuApps = new Set<string>();
    dokkuContainers = new Map<string, string[]>(); // app -> container ids
    deployments: Deployment[] = [];
    dbUp = true;
    dokkuProcesses: string[] = ["/usr/sbin/sshd -D", "nginx: master process"];
    settleAfter = 0; // `top` calls that still show a build
    topCalls = 0;
    unhealthy = new Set<string>();
    failures: ((args: string[]) => RunResult | undefined)[] = [];
    // Throws once `n` matching calls have run, as if the process had been killed.
    killAt: { match: (args: string[]) => boolean; remaining: number } | null = null;
    seq = 0;
    helperFails = false;
    profiles = new Set<string>();
    events: string[] = [];
    realpaths = new Map<string, string>();
    removedProfiles: string[] = [];
    resets: boolean[] = [];
    current: string | null = null;

    constructor(public repo = "/home/dev/launchpad") {
        this.addDir("/home/dev", 0o755);
        this.addDir(repo, 0o755);
    }

    // ---- fs ----
    addDir(p: string, mode = 0o700, uid = this.uid) {
        this.nodes.set(p, { kind: "dir", uid, mode });
    }
    addFile(p: string, data = "", mode = 0o600, uid = this.uid) {
        this.nodes.set(p, { kind: "file", uid, mode, data });
    }
    files(prefix: string) {
        return [...this.nodes.keys()].filter((k) => k.startsWith(`${prefix}/`)).sort();
    }
    children(dir: string) {
        return [...this.nodes.keys()]
            .filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/"))
            .map((k) => k.slice(dir.length + 1))
            .sort();
    }
    stateDirName = ".local-deploy";
    get dir() {
        return `${this.repo}/${this.stateDirName}`;
    }
    text(p: string) {
        const n = this.nodes.get(p);
        return n?.kind === "file" ? n.data : null;
    }

    fs: Fs = {
        stat: async (p): Promise<FsStat | null> => {
            const n = this.nodes.get(p);
            if (!n) return null;
            return {
                isDirectory: n.kind === "dir",
                isSymlink: n.kind === "link",
                isFile: n.kind === "file",
                uid: n.uid,
                mode: n.mode,
                size: n.kind === "file" ? n.data.length : 0,
            };
        },
        realpath: async (p) => {
            const n = this.nodes.get(p);
            return this.realpaths.get(p) ?? (n?.kind === "link" ? n.target : p);
        },
        mkdir: async (p, mode) => {
            if (this.nodes.has(p)) throw new Error("EEXIST");
            this.addDir(p, mode);
        },
        readdir: async (p) => this.children(p),
        readFile: async (p) => {
            const n = this.nodes.get(p);
            if (!n) return null;
            if (n.kind !== "file") throw new Error("not a file");
            if (n.uid !== this.uid) throw new Error("EACCES");
            return n.data;
        },
        writeFile: async (p, data, mode, exclusive) => {
            const old = this.nodes.get(p);
            if (old && exclusive) throw new Error("EEXIST");
            if (old && old.uid !== this.uid) throw new Error("EACCES");
            this.addFile(p, data, mode);
        },
        rename: async (a, b) => {
            const n = this.nodes.get(a);
            if (!n) throw new Error("ENOENT");
            this.nodes.delete(a);
            this.nodes.set(b, n);
        },
        unlink: async (p) => {
            const n = this.nodes.get(p);
            if (n && n.uid !== this.uid && p.includes("/credentials/")) {
                // The directory is ours, so even a 10001-owned file in it can be unlinked.
            }
            this.events.push(`unlink ${p.split("/").pop()}`);
            this.nodes.delete(p);
        },
        rmTree: async (p) => {
            const inside = [...this.nodes.keys()]
                .filter((k) => k === p || k.startsWith(`${p}/`))
                .sort((x, y) => y.length - x.length);
            let stuck = false;
            for (const k of inside) {
                const stays = [...this.nodes.keys()].some((o) => o.startsWith(`${k}/`));
                if (this.nodes.get(k)!.uid === this.uid && !stays) this.nodes.delete(k);
                else stuck = true;
            }
            if (stuck) throw new Error("EACCES");
        },
        rmdir: async (p) => {
            if (this.children(p).length > 0) throw new Error("ENOTEMPTY");
            this.events.push("rmdir");
            this.nodes.delete(p);
        },
    };

    // ---- docker world ----
    id() {
        return (++this.seq).toString(16).padStart(64, "0");
    }
    add(name: string, project: string, service: string, extra: Partial<Container> = {}) {
        const c: Container = {
            id: this.id(),
            name,
            labels: { [LABEL_PROJECT]: project, [LABEL_SERVICE]: service, [LABEL_ONEOFF]: "False" },
            state: "running",
            health: "healthy",
            ports: "",
            networks: [],
            ...extra,
        };
        this.containers.push(c);
        return c;
    }
    projectOf(args: string[]): string {
        return args[args.indexOf("-p") + 1]!;
    }
    // Adds a deployed site the way Dokku and the worker would leave it.
    deploySite(
        project: string,
        d: Deployment,
        opts: { tags?: string[]; inDb?: boolean; dokku?: boolean } = {},
    ) {
        if (opts.inDb !== false) this.deployments.push(d);
        this.dokkuApps.add(d.app);
        const c = this.add(`${d.app}.web.1`, "", "web", {
            labels: { [LABEL_APP]: d.app },
            networks: [`${project}-apps`],
        });
        this.dokkuContainers.set(d.app, [c.id]);
        this.networks.get(`${project}-apps`)?.members.push(c.name);
        for (const tag of opts.tags ?? ["latest"])
            this.images.set(`dokku/${d.app}:${tag}`, this.id().slice(0, 12));
        this.images.set(imageTagFor(d.id), this.id().slice(0, 12));
    }
    projectContainers(project: string) {
        return this.containers.filter((c) => c.labels[LABEL_PROJECT] === project);
    }
    // Everything in the engine that belongs to anything but the baseline.
    snapshot() {
        return {
            containers: this.containers.map((c) => c.name).sort(),
            volumes: [...this.volumes.keys()].sort(),
            networks: [...this.networks.keys()].sort(),
            images: [...this.images.keys()].sort(),
        };
    }
    removeContainer(id: string) {
        const c = this.containers.find((x) => x.id === id)!;
        this.containers = this.containers.filter((x) => x !== c);
        for (const n of this.networks.values()) n.members = n.members.filter((m) => m !== c.name);
    }

    deps(overrides: Partial<Deps> = {}): Deps {
        return {
            run: (args, input) => this.run(args, input),
            fetch: (async () => new Response("{}")) as unknown as typeof fetch,
            fs: this.fs,
            env: { HOME: "/home/dev", ...this.dockerEnv },
            log: (line) => this.logs.push(line),
            sleep: async (ms) => {
                this.clock += ms;
            },
            now: () => this.clock,
            probePort: async (port) => !this.busyPorts.has(port),
            removeProfile: async (controller, resetCurrent) => {
                this.removedProfiles.push(controller);
                this.resets.push(resetCurrent);
            },
            currentProfile: async () => this.current,
            uid: this.uid,
            repo: this.repo,
            version: "0.0.0",
            ...overrides,
        };
    }

    get commands() {
        return this.calls.map((a) => this.describe(a));
    }
    describe(args: string[]): string {
        if (args[0] !== "docker") return args.join(" ");
        const rest = args.slice(args[1] === "--host" ? 3 : 1);
        if (rest[0] === "compose") {
            let start = rest.indexOf("-f", rest.indexOf("-f") + 1) + 2;
            if (rest[start] === "--profile") start += 2;
            return `compose ${rest.slice(start).join(" ")}`;
        }
        return rest.join(" ");
    }

    run = async (args: string[], input?: string): Promise<RunResult> => {
        this.calls.push(args);
        this.inputs.push(input);
        this.events.push(this.describe(args));
        if (this.killAt?.match(args)) {
            if (--this.killAt.remaining < 0) {
                this.killAt = null;
                throw new Error("killed");
            }
        }
        for (const failure of this.failures) {
            const r = failure(args);
            if (r) return r;
        }
        const [cmd, ...rest] = args;
        switch (cmd) {
            case "git":
                if (rest.includes("ls-files")) {
                    // Only paths under the pathspec after `--`; no pathspec lists every tracked file.
                    const spec = rest.includes("--") ? rest[rest.indexOf("--") + 1] : undefined;
                    return ok(
                        this.trackedFiles
                            .filter(
                                (f) => spec === undefined || f === spec || f.startsWith(`${spec}/`),
                            )
                            .join("\n"),
                    );
                }
                return this.ignored ? ok() : fail("", 1);
            case "stat":
                return ok("988\n");
            case "ssh-keygen":
                return this.hostSsh(rest);
            case "openssl":
                return this.hostOpenssl(rest);
            case "docker":
                return this.docker(rest, input);
        }
        return fail(`${cmd}: not found`, 127);
    };

    private hostSsh(args: string[]) {
        const f = args[args.indexOf("-f") + 1]!;
        this.addFile(f, "PRIVATE", 0o600);
        this.addFile(`${f}.pub`, "ssh-ed25519 AAAAWORKERKEY worker", 0o644);
        return ok();
    }
    private hostOpenssl(args: string[]) {
        for (const flag of ["-keyout", "-out"]) {
            const at = args.indexOf(flag);
            if (at >= 0) this.addFile(args[at + 1]!, "PEM", flag === "-keyout" ? 0o600 : 0o644);
        }
        if (args.includes("-CAcreateserial")) {
            this.addFile(`${args[args.indexOf("-CA") + 1]!.replace(/ca\.pem$/, "")}ca.srl`, "01");
        }
        return ok();
    }

    private docker(all: string[], input?: string): RunResult {
        if (all[0] !== "--host" || all[1] !== DOCKER_HOST) return fail("wrong host", 125);
        const args = all.slice(2);
        if (!this.dockerUp) return fail("Cannot connect to the Docker daemon", 1);
        switch (args[0]) {
            case "version":
                return ok("29.1.0\n");
            case "info":
                return ok("OSType: linux\nOperating System: Fedora\n");
            case "buildx":
                return ok("Name: default\nDriver: docker\nStatus: running\n");
            case "compose":
                if (args[1] === "version") return ok("Docker Compose version v5.8.0\n");
                return this.composeCmd(args.slice(1), input);
            case "ps":
                return this.ps(args.slice(1));
            case "inspect":
                return this.inspect(args.slice(1));
            case "stop": {
                const id = args[args.length - 1]!;
                const c = this.containers.find((x) => x.id === id || x.name === id);
                if (!c) return fail("No such container");
                c.state = "exited";
                return ok(id);
            }
            case "rm": {
                const id = args[args.length - 1]!;
                if (!this.containers.some((x) => x.id === id)) return fail("No such container");
                this.removeContainer(id);
                return ok(id);
            }
            case "network":
                return this.network(args.slice(1));
            case "volume":
                return this.volume(args.slice(1));
            case "image":
                return this.image(args.slice(1));
            case "pull":
                this.pulled.add(args[1]!);
                return ok();
            case "run":
                return this.helper(args.slice(1));
            case "exec":
                return this.dokku(args.slice(1));
            case "top":
                return this.top();
        }
        return fail(`unexpected docker ${args.join(" ")}`, 125);
    }

    private filters(args: string[]) {
        const out: string[] = [];
        args.forEach((a, i) => {
            if (a === "--filter") out.push(args[i + 1]!);
        });
        return out;
    }

    private ps(args: string[]): RunResult {
        const filters = this.filters(args);
        let found = this.containers.filter((c) =>
            filters.every((f) => {
                if (f.startsWith("label=")) {
                    const [k, v] = f.slice(6).split(/=(.*)/s);
                    return c.labels[k!] === v;
                }
                return true;
            }),
        );
        if (args.includes("-q") || args.includes("-aq")) {
            return ok(found.map((c) => c.id).join("\n"));
        }
        const format = args[args.indexOf("--format") + 1];
        if (format === "{{.Ports}}") {
            if (!args.includes("-a")) found = found.filter((c) => c.state === "running");
            return ok(found.map((c) => c.ports).join("\n"));
        }
        if (format === "{{.ID}}") {
            return ok(
                found
                    .filter((c) => c.state === "running")
                    .map((c) => c.id)
                    .join("\n"),
            );
        }
        if (format !== PS_FORMAT) return fail("unexpected format", 125);
        return ok(
            found.map((c) => `${c.id} ${c.state} ${c.labels[LABEL_SERVICE] ?? ""}`).join("\n"),
        );
    }

    private inspect(args: string[]): RunResult {
        const template = args[args.indexOf("-f") + 1]!;
        const target = args[args.length - 1]!;
        const c = this.containers.find((x) => x.id === target || x.name === target);
        if (template === STATE_FORMAT) {
            if (!c) return fail("No such object");
            return ok(`${c.state} ${c.state === "running" ? c.health : ""}`);
        }
        const label = /index \.Config\.Labels "([^"]+)"/.exec(template)?.[1];
        if (label) return c ? ok(`${c.labels[label] ?? ""}\n`) : fail("No such object");
        return fail("unexpected template", 125);
    }

    private network(args: string[]): RunResult {
        if (args[0] === "ls") {
            const filters = this.filters(args);
            const project = filters
                .find((f) => f.startsWith(`label=${LABEL_PROJECT}=`))!
                .split("=")[2];
            return ok(
                [...this.networks]
                    .filter(([, n]) => n.project === project)
                    .map(([name]) => name)
                    .join("\n"),
            );
        }
        const name = args[args.length - 1]!;
        const n = this.networks.get(name);
        if (args[0] === "inspect") {
            if (!n) return fail("No such network");
            const template = args[args.indexOf("-f") + 1];
            if (template === NETWORK_LABEL_TEMPLATE) return ok(`${n.project}\n`);
            if (template === NETWORK_MEMBERS_TEMPLATE) return ok(n.members.join("\n"));
            return fail("unexpected template", 125);
        }
        if (args[0] === "rm") {
            if (!n) return fail("No such network");
            this.networks.delete(name);
            return ok(name);
        }
        return fail("unexpected network command", 125);
    }

    private volume(args: string[]): RunResult {
        const filters = this.filters(args);
        const project = filters.find((f) => f.startsWith(`label=${LABEL_PROJECT}=`))!.split("=")[2];
        return ok(
            [...this.volumes]
                .filter(([, p]) => p === project)
                .map(([name]) => name)
                .join("\n"),
        );
    }

    protected image(args: string[]): RunResult {
        if (args[0] === "ls") {
            const ref = args[args.indexOf("--filter") + 1]!.replace("reference=", "");
            if (args[args.indexOf("--format") + 1] !== IMAGE_FORMAT) return fail("format", 125);
            const rows = [...this.images]
                .filter(([name]) => {
                    const [repo, tag] = name.split(":") as [string, string];
                    const [wantRepo, wantTag] = ref.split(":");
                    return repo === wantRepo && (wantTag === undefined || wantTag === tag);
                })
                .map(([name, id]) => {
                    const [repo, tag] = name.split(":");
                    return `${repo} ${tag} ${id}`;
                });
            return ok(rows.join("\n"));
        }
        if (args[0] === "inspect") {
            const ref = args[args.length - 1]!;
            return this.images.has(ref) || this.pulled.has(ref)
                ? ok("sha256:abc")
                : fail("No such image");
        }
        if (args[0] === "rm") {
            const ref = args[1]!;
            if (this.images.delete(ref)) return ok();
            const byId = [...this.images].find(([, id]) => id === ref);
            if (byId) {
                this.images.delete(byId[0]);
                return ok();
            }
            return fail("No such image");
        }
        return fail("unexpected image command", 125);
    }

    private top(): RunResult {
        const busy = this.topCalls++ < this.settleAfter;
        const rows = [...this.dokkuProcesses, ...(busy ? ["docker build -t x ."] : [])];
        return ok(
            ["PID COMMAND COMMAND", ...rows.map((r, i) => `${i + 1} ${r.split(" ")[0]} ${r}`)].join(
                "\n",
            ),
        );
    }

    private dokkuContainer(project?: string) {
        return this.containers.find(
            (c) =>
                c.labels[LABEL_SERVICE] === "dokku" &&
                (!project || c.labels[LABEL_PROJECT] === project),
        );
    }

    // `docker exec <id> dokku ...`
    private dokku(args: string[]): RunResult {
        const id = args[0]!;
        const c = this.containers.find((x) => x.id === id);
        if (!c || c.state !== "running" || args[1] !== "dokku") return fail("exec failed");
        const rest = args.slice(2).filter((a) => a !== "--quiet");
        if (rest[0] === "apps:list") return ok([...this.dokkuApps, ...this.strangeApps].join("\n"));
        if (rest[0] === "apps:exists")
            return this.dokkuApps.has(rest[1]!) ? ok() : fail("does not exist", 20);
        if (rest[0] === "apps:destroy") {
            const app = rest[1]!;
            if (!this.dokkuApps.has(app)) return fail(`App ${app} does not exist`, 20);
            if (rest[2] !== "--force") return fail("needs --force");
            this.dokkuApps.delete(app);
            for (const cid of this.dokkuContainers.get(app) ?? []) this.removeContainer(cid);
            this.dokkuContainers.delete(app);
            for (const name of Array.from(this.images.keys()))
                if (name.startsWith(`dokku/${app}:`)) this.images.delete(name);
            return ok();
        }
        return fail(`unexpected dokku ${rest.join(" ")}`, 125);
    }
    strangeApps: string[] = [];

    // The root helper and the chown helper.
    private helper(args: string[]): RunResult {
        const entry = args[args.indexOf("--entrypoint") + 1];
        const image = args[args.indexOf("--entrypoint") + 2]!;
        if (
            !args.includes("--rm") ||
            !args.includes("--network") ||
            args[args.indexOf("--network") + 1] !== "none"
        ) {
            return fail("unsafe helper", 125);
        }
        if (!args.includes("--pull") || args[args.indexOf("--pull") + 1] !== "never")
            return fail("pull", 125);
        if (!this.images.has(image) && !this.pulled.has(image)) return fail("No such image");
        const mount = args[args.indexOf("--mount") + 1]!;
        const src = /src=([^,]+)/.exec(mount)![1]!;
        if (this.helperFails) return fail("helper failed");
        const names = args.slice(args.indexOf(image) + 1);
        if (entry === "chown") {
            for (const n of names.filter((x) => x.startsWith("/state/"))) {
                const node = this.nodes.get(`${src}/${n.replace("/state/", "")}`);
                if (node) node.uid = 10001;
            }
            return ok();
        }
        if (entry === "rm") {
            for (const n of names.filter((x) => x.startsWith("/state/"))) {
                const p = `${src}/${n.slice(7)}`;
                for (const k of Array.from(this.nodes.keys()))
                    if (k === p || k.startsWith(`${p}/`)) this.nodes.delete(k);
            }
            return ok();
        }
        return fail("unexpected helper", 125);
    }

    protected composeCmd(all: string[], input?: string): RunResult {
        // -p P --env-file E -f F -f O --profile admin <sub...>
        const project = all[all.indexOf("-p") + 1]!;
        const envFile = all[all.indexOf("--env-file") + 1]!;
        if (!all.includes(COMPOSE_FILE)) return fail("wrong compose file", 125);
        let start = all.indexOf("-f", all.indexOf("-f") + 1) + 2;
        if (all[start] === "--profile") start += 2;
        const sub = all.slice(start);
        const overrideFile = all[all.indexOf("-f", all.indexOf("-f") + 1) + 1]!;
        if (!this.nodes.get(envFile) || !this.nodes.get(overrideFile))
            return fail("env file missing");
        const svc = (name: string) =>
            this.containers.find(
                (c) =>
                    c.labels[LABEL_PROJECT] === project &&
                    c.labels[LABEL_SERVICE] === name &&
                    c.labels[LABEL_ONEOFF] === "False",
            );
        switch (sub[0]) {
            case "build":
                for (const s of ["controller", "worker", "dokku", "router", "admin"]) {
                    this.images.set(`${project}/${s}:local`, this.id().slice(0, 12));
                }
                return ok();
            case "up": {
                const wanted = sub.filter((x) => !x.startsWith("-")).slice(1);
                const services =
                    wanted.length > 0
                        ? wanted
                        : ["postgres", "dokku", "controller", "worker", "router"];
                for (const name of services) {
                    const existing = svc(name);
                    if (existing) {
                        // `up -d` starts a stopped container again and leaves a running one alone.
                        if (existing.state !== "running") existing.state = "running";
                        continue;
                    }
                    const c = this.add(`${project}-${name}-1`, project, name, {
                        health: this.unhealthy.has(name) ? "starting" : "healthy",
                        ports:
                            name === "controller"
                                ? `127.0.0.1:${this.envPort(envFile, "CONTROLLER_HOST_PORT")}->3000/tcp`
                                : name === "dokku"
                                  ? `127.0.0.1:${this.envPort(envFile, "PREVIEW_HTTP_HOST_PORT")}->80/tcp`
                                  : "",
                    });
                    c.networks = [`${project}_backend`];
                }
                for (const n of [`${project}_backend`, `${project}_database`, `${project}-apps`]) {
                    if (!this.networks.has(n)) this.networks.set(n, { project, members: [] });
                }
                for (const v of ["postgres-data", "launchpad-data", "router-state"])
                    this.volumes.set(`${project}_${v}`, project);
                return ok();
            }
            case "exec":
                return this.composeExec(project, sub.slice(1));
            case "run": {
                const at = sub.findIndex((x) => x === "admin" || x === "router");
                const service = sub[at]!;
                const rest = sub.slice(at + 1);
                if (service === "router") {
                    return rest[0] === "init" && input?.trim()
                        ? ok("compose noise\nd9a4ff5b-d607-41ac-84aa-b0d64c4c4cba\n")
                        : fail("init");
                }
                return rest[0] === "migrate" ? ok("Database is up to date.\n") : ok();
            }
            case "down": {
                if (!sub.includes("--volumes") || !sub.includes("--remove-orphans"))
                    return fail("flags", 125);
                // A real engine refuses to remove a network that still has an endpoint.
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
                for (const [n, v] of Array.from(this.volumes))
                    if (v === project) this.volumes.delete(n);
                for (const [n, v] of Array.from(this.networks))
                    if (v.project === project) this.networks.delete(n);
                return ok();
            }
            case "logs":
                return ok("log\n");
        }
        return fail(`unexpected compose ${sub.join(" ")}`, 125);
    }

    envPort(envFile: string, key: string) {
        return new RegExp(`${key}=(\\d+)`).exec(this.text(envFile) ?? "")?.[1];
    }

    protected composeExec(project: string, args: string[]): RunResult {
        const rest = args.filter((a) => a !== "-T");
        const service = rest[0]!;
        const c = this.containers.find(
            (x) => x.labels[LABEL_PROJECT] === project && x.labels[LABEL_SERVICE] === service,
        );
        if (!c || c.state !== "running") return fail("service not running");
        if (service === "postgres" && rest[1] === "psql") {
            if (!this.dbUp) return fail("could not connect");
            return ok(this.deployments.map((d) => `${d.id} ${d.app} ${d.state}`).join("\n"));
        }
        if (service === "dokku") {
            const cmd = rest.slice(1);
            if (cmd[0] === "cat") return ok("ssh-ed25519 AAAADOKKUHOSTKEY root@dokku\n");
            if (
                cmd[0] === "dokku" &&
                ["network:set", "ssh-keys:add", "ssh-keys:remove"].includes(cmd[1]!)
            )
                return ok();
        }
        return fail(`unexpected exec ${rest.join(" ")}`, 125);
    }
}
