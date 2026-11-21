import { mkdir, writeFile } from "node:fs/promises";
import { command, NAME, type Resources } from "./harness";
import type { FaultRule } from "./rules";
import type { World } from "./scenarios";

type Docker = (
    args: string[],
    allowFailure?: boolean,
    stdin?: string,
) => Promise<{ out: string; err: string; code: number }>;

export interface WorldInput {
    r: Resources;
    dir: string;
    docker: Docker;
    persist: () => Promise<void>;
    baseUrl: string;
    appsDomain: string;
    operator: { email: string; password: string };
    ann: { email: string; password: string };
    socketGroup: string;
    epoch: string;
    routerToken: string;
    instanceId: string;
}

const compact = (id: string) => id.replaceAll("-", "");

export async function buildWorld(input: WorldInput): Promise<World> {
    const { r, dir, docker } = input;
    const ipOf = async (container: string) => {
        const out = (
            await docker([
                "inspect",
                "-f",
                `{{(index .NetworkSettings.Networks "${r.network}").IPAddress}}`,
                container,
            ])
        ).out;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(out)) throw new Error(`No address for ${container}.`);
        return out;
    };
    const controller = `http://${await ipOf(r.containers.controller)}:3000`;
    const routerIp = await ipOf(r.containers.router);
    const dokkuIp = await ipOf(r.containers.dokku);
    const proxyIp = await ipOf(r.containers.proxy);

    // Bounded wait for the process to be up, not a fixed delay.
    for (let i = 0, up = false; !up; i++) {
        if (i >= 90) {
            const logs = await docker(["logs", r.containers.controller], true);
            throw new Error(
                `The controller did not start: ${logs.out}\n${logs.err}`.slice(0, 2000),
            );
        }
        up = await fetch(`${controller}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
            (response) => response.status === 200,
            () => false,
        );
        if (!up) await Bun.sleep(1000);
    }

    // Bootstrap through the real HTTP surface: the operator creates the organization, its owner
    // creates a project and issues the API key everything after this uses.
    const signIn = async (who: { email: string; password: string }) => {
        const response = await fetch(`${controller}/api/auth/sign-in/email`, {
            signal: AbortSignal.timeout(10_000),
            method: "POST",
            headers: { "content-type": "application/json", origin: input.baseUrl },
            body: JSON.stringify(who),
        });
        if (response.status !== 200) throw new Error(`Sign-in failed with ${response.status}.`);
        return response.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0])
            .join("; ");
    };
    const withCookie = async (cookie: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`${controller}/api/v1${path}`, {
            signal: AbortSignal.timeout(10_000),
            method,
            headers: { cookie, origin: input.baseUrl, "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        // The reply of an API-key issue carries a secret: never put it in an error.
        if (response.status >= 300) {
            throw new Error(
                `${method} ${path.replace(/[0-9a-f-]{36}/g, ":id")}: ${response.status}`,
            );
        }
        return JSON.parse(text) as Record<string, unknown>;
    };
    const operatorCookie = await signIn(input.operator);
    const org = (await withCookie(operatorCookie, "POST", "/organizations", {
        name: "Acme",
        slug: "acme",
        ownerEmail: input.ann.email,
    })) as { id: string };
    const annCookie = await signIn(input.ann);
    const project = (await withCookie(annCookie, "POST", `/organizations/${org.id}/projects`, {
        name: "Site",
        slug: "site",
    })) as { id: string };
    const issued = (await withCookie(annCookie, "POST", `/organizations/${org.id}/api-keys`, {
        name: "acceptance",
        scopes: ["app:read", "app:deploy", "app:delete", "app:alias:manage", "app:promote"],
        expiresInDays: 1,
    })) as { secret: string };
    const apiKey = issued.secret;

    const api: World["api"] = async (method, path, body, options = {}) => {
        const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };
        let payload: BodyInit | undefined;
        if (options.raw) {
            payload = options.raw as unknown as BodyInit;
            headers["content-type"] = "application/gzip";
        } else if (body !== undefined) {
            payload = JSON.stringify(body);
            headers["content-type"] = "application/json";
        }
        if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
        const response = await fetch(`${controller}/api/v1/organizations/${org.id}${path}`, {
            method,
            headers,
            body: payload,
            signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            // Keep the text.
        }
        return { status: response.status, body: parsed as never };
    };

    const sql: World["sql"] = async <T>(query: string) => {
        const result = await docker([
            "exec",
            r.containers.postgres,
            "psql",
            "-U",
            "launchpad",
            "-d",
            "launchpad",
            "-At",
            "-c",
            `select coalesce(json_agg(t), '[]'::json) from (${query}) t`,
        ]);
        return JSON.parse(result.out) as T[];
    };

    const identity = async (base: string, host: string) => {
        const response = await fetch(`${base}/`, {
            headers: { host },
            signal: AbortSignal.timeout(15_000),
        });
        await response.arrayBuffer();
        return {
            status: response.status,
            deployment: response.headers.get("x-launchpad-deployment"),
        };
    };

    const proxyAdmin = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://${proxyIp}:8083${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
        return { status: response.status, body: await response.json() };
    };

    const workerName = (which: 1 | 2) =>
        which === 1 ? r.containers.worker1 : r.containers.worker2;
    const mounts = [
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${dir}/credentials:/credentials:ro`,
        "-v",
        `${dir}/data:/data`,
    ];

    const world: World = {
        r,
        dir,
        docker,
        org: org.id,
        project: project.id,
        compact,
        api,
        sql,
        probeRouter: (host) => identity(`http://${routerIp}:8080`, host),
        probeDokku: (host) => identity(`http://${dokkuIp}:80`, host),
        async routerRoute(host) {
            const response = await fetch(`http://${routerIp}:8081/v1/routes/${host}`, {
                headers: {
                    authorization: `Bearer ${input.routerToken}`,
                    "x-launchpad-instance": input.instanceId,
                    "x-launchpad-epoch": input.epoch,
                },
                signal: AbortSignal.timeout(10_000),
            });
            if (response.status !== 200) {
                throw new Error(`Router route read returned ${response.status}.`);
            }
            const body = (await response.json()) as {
                route: null | {
                    generation: string;
                    operationId: string;
                    aliasId: string;
                    target: { deploymentId: string } | null;
                };
            };
            if (body.route === undefined) throw new Error("Router reply did not include a route.");
            return { status: response.status, route: body.route };
        },
        proxy: {
            async addRule(rule: FaultRule) {
                const reply = await proxyAdmin("POST", "/rules", rule);
                if (reply.status !== 200) throw new Error(`Proxy rejected rule ${rule.id}.`);
            },
            release: async (id) => (await proxyAdmin("POST", `/release/${id}`)).status === 200,
            async log() {
                const reply = await proxyAdmin("GET", "/log");
                if (reply.status !== 200 || !Array.isArray(reply.body)) {
                    throw new Error("Could not read proxy evidence.");
                }
                return reply.body;
            },
        },
        async startWorker(which) {
            const name = workerName(which);
            await docker([
                "run",
                "-d",
                "--name",
                name,
                "--network",
                `container:${r.containers.proxy}`,
                "--group-add",
                input.socketGroup,
                "--env-file",
                `${dir}/worker.env`,
                ...mounts,
                r.images.worker,
            ]);
            for (let i = 0; ; i++) {
                const logs = await docker(["logs", name], true);
                if (`${logs.out}\n${logs.err}`.includes("deployment-worker-started")) return;
                if (i >= 60) {
                    throw new Error(`${name} did not start: ${logs.out}${logs.err}`.slice(0, 2000));
                }
                await Bun.sleep(500);
            }
        },
        pauseWorker: (which) => docker(["pause", workerName(which)]).then(() => undefined),
        unpauseWorker: (which) => docker(["unpause", workerName(which)]).then(() => undefined),
        stopWorker: (which) =>
            docker(["stop", "--time", "30", workerName(which)], true).then(() => undefined),
        async workerEvents(which) {
            const logs = await docker(["logs", workerName(which)]);
            return `${logs.out}\n${logs.err}`.split("\n").flatMap((line) => {
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    // Event names and identifiers only.
                    return typeof parsed.event === "string"
                        ? [
                              {
                                  event: parsed.event,
                                  operationId: parsed.operationId as string | undefined,
                                  status: parsed.status as string | undefined,
                                  deploymentId: parsed.deploymentId as string | undefined,
                              },
                          ]
                        : [];
                } catch {
                    return [];
                }
            });
        },
        async databaseWrites(since) {
            const logs = await docker(["logs", "--since", since, r.containers.postgres], true);
            const counts: Record<string, number> = {};
            const statement =
                /(?:statement|execute [^:]*): (UPDATE|INSERT INTO|DELETE FROM)\s+"?(\w+)"?/i;
            for (const line of `${logs.out}\n${logs.err}`.split("\n")) {
                const match = statement.exec(line);
                if (match) {
                    const key = `${match[1]!.toUpperCase()} ${match[2]}`;
                    counts[key] = (counts[key] ?? 0) + 1;
                }
            }
            return counts;
        },
        async reconcile(operationId, targetId) {
            const result = await docker(
                [
                    "run",
                    "--rm",
                    "--network",
                    `container:${r.containers.proxy}`,
                    "--env-file",
                    `${dir}/worker.env`,
                    "-v",
                    `${dir}/credentials:/credentials:ro`,
                    "-v",
                    `${dir}/data:/data`,
                    "--entrypoint",
                    "bun",
                    r.images.controller,
                    ".output/admin.mjs",
                    "promotion-reconcile",
                    "--operation",
                    operationId,
                    "--target",
                    targetId,
                    "--i-have-verified-the-router-by-exact-route",
                ],
                true,
            );
            return { code: result.code, out: result.out, err: result.err };
        },
        async discover() {
            const rows = await sql<{ id: string; app_name: string }>(
                "select id, app_name from deployment",
            );
            for (const row of rows) {
                // The image tag is derived from the deployment ID, as the worker derives it.
                const imageTag = `launchpad/site:${compact(row.id)}`;
                if (
                    NAME.app.test(row.app_name) &&
                    NAME.tag.test(imageTag) &&
                    !r.discovered.some((entry) => entry.deploymentId === row.id)
                ) {
                    r.discovered.push({ deploymentId: row.id, app: row.app_name, imageTag });
                }
            }
            await input.persist();
        },
        async archive(name, files) {
            const folder = `${dir}/site/${name}`;
            await mkdir(folder, { recursive: true });
            for (const [file, content] of Object.entries(files)) {
                await writeFile(`${folder}/${file}`, content);
            }
            const out = `${dir}/site/${name}.tgz`;
            await command([
                "tar",
                "--format=ustar",
                "-czf",
                out,
                "-C",
                folder,
                ...Object.keys(files),
            ]);
            return new Uint8Array(await Bun.file(out).arrayBuffer());
        },
        async damageArtifact(artifactId) {
            const [row] = await sql<{ storage_key: string }>(
                `select storage_key from artifact where id = '${artifactId}'`,
            );
            if (
                !row ||
                !/^[A-Za-z0-9_./-]+$/.test(row.storage_key) ||
                row.storage_key.includes("..")
            ) {
                throw new Error("Unexpected artifact storage key.");
            }
            await docker([
                "run",
                "--rm",
                "--user",
                "0",
                "--entrypoint",
                "sh",
                "-v",
                `${dir}/data:/data`,
                r.images.worker,
                "-c",
                `printf 'not an archive' > "/data/${row.storage_key}"`,
            ]);
        },
        async finish() {
            await writeFile(
                `${dir}/proxy-log.json`,
                JSON.stringify(await world.proxy.log(), null, 2),
            );
        },
    };
    return world;
}
