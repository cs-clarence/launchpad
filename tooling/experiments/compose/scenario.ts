import { randomUUID } from "node:crypto";
import type { Fixture } from "./docker";

type RecordStep = (name: string, observations?: object) => Promise<void>;
type Wait = <T>(label: string, read: () => Promise<T | false>, seconds?: number) => Promise<T>;

export async function aliasScenario(options: {
    plan: Fixture;
    operatorPassword: string;
    ownerPassword: string;
    archive: ArrayBuffer;
    signal: AbortSignal;
    record: RecordStep;
    wait: Wait;
    inventory: () => Promise<void>;
}) {
    const { plan, signal, wait, record } = options;
    const origin = plan.env.LAUNCHPAD_BASE_URL!;
    const local = (port: string) => `http://127.0.0.1:${plan.env[port]}`;
    const controller = local("CONTROLLER_HOST_PORT");
    const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);

    async function request(
        method: string,
        path: string,
        expected: number[],
        headers: Record<string, string>,
        body?: object | ArrayBuffer,
    ) {
        const response = await fetch(`${controller}${path}`, {
            method,
            redirect: "error",
            signal: deadline(),
            headers: {
                ...(body
                    ? {
                          "content-type":
                              body instanceof ArrayBuffer ? "application/gzip" : "application/json",
                      }
                    : {}),
                ...headers,
            },
            body: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined,
        });
        if (!expected.includes(response.status)) {
            await response.body?.cancel();
            throw new Error(
                `Fixture API ${method} returned ${response.status}, expected ${expected.join("/")}.`,
            );
        }
        return response;
    }

    async function signIn(name: string, password: string) {
        const res = await request(
            "POST",
            "/api/auth/sign-in/email",
            [200],
            { origin },
            {
                email: `${name}@example.net`,
                password,
            },
        );
        const cookie = res.headers
            .getSetCookie()
            .map((item) => item.split(";")[0])
            .join("; ");
        await res.body?.cancel();
        if (!cookie) throw new Error("Fixture sign-in did not issue a cookie.");
        return cookie;
    }
    async function create<T>(cookie: string, route: string, data: object): Promise<T> {
        return (
            await request("POST", `/api/v1${route}`, [201], { cookie, origin }, data)
        ).json() as Promise<T>;
    }
    const { id: org } = await create<{ id: string }>(
        await signIn("operator", options.operatorPassword),
        "/organizations",
        { name: "Fixture", slug: "fixture", ownerEmail: "owner@example.net" },
    );
    const owner = await signIn("owner", options.ownerPassword);
    const prefix = `/organizations/${org}`;
    const { id: project } = await create<{ id: string }>(owner, `${prefix}/projects`, {
        name: "Fixture",
        slug: "site",
    });
    const { secret } = await create<{ secret: string }>(owner, `${prefix}/api-keys`, {
        name: "compose",
        scopes: ["app:read", "app:deploy", "app:delete", "app:alias:manage", "app:promote"],
        expiresInDays: 1,
    });
    async function api<T>(
        method: string,
        route: string,
        expected: number[],
        data?: object | ArrayBuffer,
        keyed = false,
    ): Promise<T> {
        const res = await request(
            method,
            `/api/v1${prefix}${route}`,
            expected,
            {
                authorization: `Bearer ${secret}`,
                ...(keyed ? { "idempotency-key": randomUUID() } : {}),
            },
            data,
        );
        if (res.headers.get("content-type")?.includes("application/json"))
            return (await res.json()) as T;
        await res.body?.cancel();
        throw new Error("Fixture API did not return JSON.");
    }
    async function probe(port: string, hostname: string, id: string | null) {
        const res = await fetch(`${local(port)}/`, {
            headers: { host: hostname },
            redirect: "error",
            signal: deadline(),
        });
        await res.body?.cancel();
        if (
            res.status !== (id ? 200 : 404) ||
            res.headers.get("x-launchpad-deployment") !== (id?.replaceAll("-", "") ?? null)
        )
            throw new Error("Fixture app probe did not return the expected deployment identity.");
    }

    const artifact = await api<{ id: string }>(
        "POST",
        `/projects/${project}/artifacts`,
        [200, 201],
        options.archive,
    );
    const app = await api<{ id: string }>("POST", `/projects/${project}/apps`, [201], {
        slug: "compose-tls",
    });
    type Deployment = { id: string; hostname: string; status: string; desiredState: string };
    const deploy = async () => {
        const deployment = await api<Deployment>("POST", `/apps/${app.id}/deployments`, [202], {
            artifactId: artifact.id,
        });
        await options.inventory();
        await wait("deployment succeeded", async () => {
            const row = await api<Deployment>("GET", `/deployments/${deployment.id}`, [200]);
            if (["failed", "reconciliation-needed", "cancelled"].includes(row.status))
                throw new Error(`Fixture deployment ended ${row.status}.`);
            return row.status === "succeeded";
        });
        await probe("PREVIEW_HTTP_HOST_PORT", deployment.hostname, deployment.id);
        return deployment;
    };
    const a = await deploy();
    const b = await deploy();
    await record("Two immutable deployments served by Dokku");
    const alias = await api<{ id: string; hostname: string }>(
        "POST",
        `/apps/${app.id}/aliases`,
        [201],
        { slug: "production" },
    );
    const route = `/aliases/${alias.id}`;
    const generation = async () =>
        (await api<{ reservedGeneration: string }>("GET", route, [200])).reservedGeneration;
    type Operation = { id: string; status: string };
    const complete = (operation: Operation) =>
        wait(
            "promotion succeeded",
            async () => {
                const rows = await api<Operation[]>("GET", `${route}/operations`, [200]);
                const status = rows.find((item) => item.id === operation.id)?.status;
                if (status && ["failed", "superseded", "reconciliation-needed"].includes(status))
                    throw new Error(`Fixture promotion ended ${status}.`);
                return status === "succeeded";
            },
            180,
        );
    for (const deployment of [a, b]) {
        await complete(
            await api<Operation>(
                "POST",
                `${route}/promotions`,
                [202],
                {
                    expectedGeneration: await generation(),
                    targetDeploymentId: deployment.id,
                },
                true,
            ),
        );
        await probe("ROUTER_DATA_HOST_PORT", alias.hostname, deployment.id);
    }
    await record("Alias bound to A and promoted to B; data identity matched");
    await complete(
        await api<Operation>(
            "DELETE",
            route,
            [202],
            { expectedGeneration: await generation() },
            true,
        ),
    );
    await probe("ROUTER_DATA_HOST_PORT", alias.hostname, null);
    await record("Alias withdrawal returned 404 without a deployment identity");
    for (const { id } of [a, b]) {
        await api("DELETE", `/deployments/${id}`, [202]);
        await wait(
            "deployment deleted",
            async () =>
                (await api<Deployment>("GET", `/deployments/${id}`, [200])).desiredState ===
                "deleted",
        );
    }
    await record("Both deployments deleted through the API");
}
