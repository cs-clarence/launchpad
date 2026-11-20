import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouterControlClient } from "./control-client";
import { createControlHandler } from "./host/control";
import { hostFixture, type HostFixture } from "./host/test-support";

type Send = NonNullable<Parameters<typeof createRouterControlClient>[0]["fetch"]>;

let fixture: HostFixture | undefined;
afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
});

function setup() {
    const state = (fixture = hostFixture());
    const handle = createControlHandler(state.store);
    const send: Send = (input, init) => handle(new Request(input, init));
    const options = {
        baseUrl: new URL("https://router.example.net"),
        credentials: state.credentials,
    };
    const target = { deploymentId: randomUUID(), hostname: "candidate.sites.example.net" };
    const write = {
        hostname: "prod.sites.example.net",
        aliasId: randomUUID(),
        operationId: randomUUID(),
        generation: "9007199254740993",
        targetDeploymentId: target.deploymentId,
    };
    return { state, send, options, target, write };
}

describe("private router control client", () => {
    it("registers, binds, reads and withdraws through the real control handler", async () => {
        const { send, options, target, write } = setup();
        const client = createRouterControlClient({ ...options, fetch: send });
        expect(await client.readRoute(write.hostname)).toMatchObject({ route: null });
        expect(await client.registerDeployment(target)).toEqual(target);
        const bound = await client.replaceRoute(write);
        expect(bound).toMatchObject({
            epoch: options.credentials.epoch,
            instanceId: options.credentials.instanceId,
            route: { generation: write.generation, operationId: write.operationId, target },
        });
        expect(await client.readRoute(write.hostname)).toEqual(bound);
        await expect(
            client.replaceRoute({ ...write, operationId: randomUUID(), generation: "1" }),
        ).rejects.toMatchObject({ kind: "uncertain" });
        expect(await client.readRoute(write.hostname)).toEqual(bound);
        const withdrawn = await client.replaceRoute({
            ...write,
            generation: "9007199254740994",
            operationId: randomUUID(),
            targetDeploymentId: null,
        });
        expect(withdrawn.route).toMatchObject({ target: null, generation: "9007199254740994" });
        expect(await client.readRoute(write.hostname)).toEqual(withdrawn);
    });

    it("reads the router's epoch, and refuses a reply from another router", async () => {
        const { send, options } = setup();
        const client = createRouterControlClient({ ...options, fetch: send });
        expect(await client.readEpoch()).toBe(options.credentials.epoch);
        const other = createRouterControlClient({
            ...options,
            fetch: async () =>
                Response.json({
                    instanceId: randomUUID(),
                    epoch: randomUUID(),
                    routes: [],
                    nextCursor: null,
                }),
        });
        await expect(other.readEpoch()).rejects.toMatchObject({ kind: "uncertain" });
        // The right router answering with an epoch that is not the one it authenticated: refused.
        const drifted = createRouterControlClient({
            ...options,
            fetch: async () =>
                Response.json({
                    instanceId: options.credentials.instanceId,
                    epoch: randomUUID(),
                    routes: [],
                    nextCursor: null,
                }),
        });
        await expect(drifted.readEpoch()).rejects.toMatchObject({ kind: "uncertain" });
    });

    it("lists every route, following pages and refusing a reply from another authority or a stuck cursor", async () => {
        const { send, options, target, write } = setup();
        const client = createRouterControlClient({ ...options, fetch: send });
        expect((await client.listRoutes()).routes).toEqual([]);
        await client.registerDeployment(target);
        await client.replaceRoute(write);
        const listed = await client.listRoutes();
        expect(listed).toMatchObject({
            instanceId: options.credentials.instanceId,
            epoch: options.credentials.epoch,
        });
        expect(listed.routes).toHaveLength(1);
        expect(listed.routes[0]).toMatchObject({
            hostname: write.hostname,
            generation: write.generation,
        });

        const route = listed.routes[0]!;
        const page = (
            routes: unknown[],
            nextCursor: string | null,
            epoch = options.credentials.epoch,
        ) =>
            Response.json({
                instanceId: options.credentials.instanceId,
                epoch,
                routes,
                nextCursor,
            });
        const fetch = vi
            .fn<Send>()
            .mockResolvedValueOnce(page([route], "b.sites.example.net"))
            .mockResolvedValueOnce(page([{ ...route, hostname: "b.sites.example.net" }], null));
        const paged = await createRouterControlClient({ ...options, fetch }).listRoutes();
        expect(paged.routes.map((row) => row.hostname)).toEqual([
            write.hostname,
            "b.sites.example.net",
        ]);
        expect(String(fetch.mock.calls[1]![0])).toContain("after=b.sites.example.net");

        const stuck = vi.fn<Send>().mockResolvedValue(page([route], "a.sites.example.net"));
        await expect(
            createRouterControlClient({ ...options, fetch: stuck }).listRoutes(),
        ).rejects.toMatchObject({ kind: "uncertain" });
        const wrongEpoch = vi.fn<Send>().mockResolvedValue(page([], null, randomUUID()));
        await expect(
            createRouterControlClient({ ...options, fetch: wrongEpoch }).listRoutes(),
        ).rejects.toMatchObject({ kind: "uncertain" });
    });

    it("lists more routes than one page holds, in order and without loss", async () => {
        const { send, options } = setup();
        const client = createRouterControlClient({ ...options, fetch: send });
        const hostnames: string[] = [];
        for (let index = 0; index < 501; index++) {
            const deployment = {
                deploymentId: randomUUID(),
                hostname: `d${String(index).padStart(4, "0")}.sites.example.net`,
            };
            const hostname = `a${String(index).padStart(4, "0")}.sites.example.net`;
            await client.registerDeployment(deployment);
            await client.replaceRoute({
                hostname,
                aliasId: randomUUID(),
                operationId: randomUUID(),
                generation: "1",
                targetDeploymentId: deployment.deploymentId,
            });
            hostnames.push(hostname);
        }
        const listed = await client.listRoutes();
        expect(listed.routes.map((row) => row.hostname)).toEqual(hostnames.toSorted());
    }, 60_000);

    it("does not turn a dropped reply after commit into a refusal", async () => {
        const { options, send, target, write } = setup();
        const healthy = createRouterControlClient({ ...options, fetch: send });
        const dropped = createRouterControlClient({
            ...options,
            fetch: async (input, init) => {
                expect((await send(input, init)).status).toBe(200);
                throw new Error("connection lost");
            },
        });
        await healthy.registerDeployment(target);
        await expect(dropped.replaceRoute(write)).rejects.toMatchObject({ kind: "uncertain" });
        expect((await healthy.readRoute(write.hostname)).route).toMatchObject({
            operationId: write.operationId,
            target,
        });
    });

    it("distinguishes local validation from server refusal", async () => {
        const { send, options, target, write } = setup();
        const fetch = vi.fn(send);
        const client = createRouterControlClient({ ...options, fetch });
        await expect(client.readRoute("../healthz")).rejects.toMatchObject({ kind: "not-sent" });
        await expect(client.replaceRoute(write, AbortSignal.abort())).rejects.toMatchObject({
            kind: "not-sent",
        });
        expect(fetch).not.toHaveBeenCalled();
        // A valid route request with an unregistered target is refused by the actual router.
        await expect(client.replaceRoute(write)).rejects.toMatchObject({ kind: "rejected" });
        const wrongEpoch = createRouterControlClient({
            ...options,
            credentials: { ...options.credentials, epoch: randomUUID() },
            fetch,
        });
        await expect(wrongEpoch.registerDeployment(target)).rejects.toMatchObject({
            kind: "rejected",
        });
    });

    it("bounds a transport that never returns headers", async () => {
        const { options, write } = setup();
        const client = createRouterControlClient({
            ...options,
            timeoutMs: 10,
            fetch: () => new Promise<Response>(() => {}),
        });
        await expect(client.replaceRoute(write)).rejects.toMatchObject({
            kind: "uncertain",
            message: "The router outcome could not be confirmed.",
        });
    });

    it.each(["timeout", "abort"] as const)(
        "cancels a stalled response body on %s",
        async (reason) => {
            const { options, write } = setup();
            const caller = new AbortController();
            const opened = Promise.withResolvers<void>();
            const cancel = vi.fn();
            const client = createRouterControlClient({
                ...options,
                timeoutMs: reason === "timeout" ? 25 : 1000,
                fetch: async () =>
                    new Response(
                        new ReadableStream(
                            {
                                pull(controller) {
                                    controller.enqueue(new TextEncoder().encode("{"));
                                    opened.resolve();
                                    return new Promise<void>(() => {});
                                },
                                cancel,
                            },
                            { highWaterMark: 0 },
                        ),
                        { headers: { "content-type": "application/json" } },
                    ),
            });
            const reply = expect(client.replaceRoute(write, caller.signal)).rejects.toMatchObject({
                kind: "uncertain",
                message: "The router outcome could not be confirmed.",
            });
            if (reason === "abort") {
                await opened.promise;
                caller.abort(new Error("private detail"));
            }
            await reply;
            expect(cancel).toHaveBeenCalledOnce();
        },
    );

    it("rejects oversized JSON, malformed identity, and a different operation", async () => {
        const { options, write, target } = setup();
        const good = {
            instanceId: options.credentials.instanceId,
            epoch: options.credentials.epoch,
            route: {
                aliasId: write.aliasId,
                hostname: write.hostname,
                operationId: write.operationId,
                generation: write.generation,
                target,
            },
        };
        const fetch = vi
            .fn<Send>()
            .mockResolvedValueOnce(Response.json(good))
            .mockResolvedValueOnce(
                new Response(JSON.stringify(good) + " ".repeat(8192), {
                    headers: { "content-type": "application/json" },
                }),
            )
            .mockResolvedValueOnce(Response.json({ ...good, epoch: randomUUID() }))
            .mockResolvedValueOnce(
                Response.json({ ...good, route: { ...good.route, operationId: randomUUID() } }),
            );
        const client = createRouterControlClient({ ...options, fetch });
        expect(await client.replaceRoute(write)).toEqual(good);
        for (let i = 0; i < 3; i++) {
            await expect(client.replaceRoute(write)).rejects.toMatchObject({ kind: "uncertain" });
        }
    });

    it.each([400, 401, 404, 413, 503])(
        "treats a non-protocol %s reply as uncertain",
        async (status) => {
            const { options, write } = setup();
            const client = createRouterControlClient({
                ...options,
                fetch: async () =>
                    Response.json(
                        { error: status === 400 ? "unauthorized" : "invalid" },
                        { status },
                    ),
            });
            await expect(client.replaceRoute(write)).rejects.toMatchObject({ kind: "uncertain" });
        },
    );

    it("uses a configured proxy prefix without allowing credentials to follow redirects", async () => {
        const { options, write } = setup();
        const fetch = vi.fn<Send>().mockResolvedValue(
            new Response(null, {
                status: 302,
                headers: { location: "https://other.example.net" },
            }),
        );
        const client = createRouterControlClient({
            ...options,
            baseUrl: new URL("/control", options.baseUrl),
            fetch,
        });
        await expect(client.readRoute(write.hostname)).rejects.toMatchObject({ kind: "uncertain" });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
            new URL(`/control/v1/routes/${write.hostname}`, options.baseUrl),
            expect.objectContaining({ redirect: "error" }),
        );
    });
});
