import { once } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createClient, LaunchpadTransportError } from "../index";

const KEY = `lp_${"a".repeat(43)}`;
const fixtures: Server[] = [];

// Ephemeral loopback fixtures, never a controller or an external destination.
async function listen(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    fixtures.push(server);
    const ready = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await ready;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
    await Promise.all(
        fixtures.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                    server.closeAllConnections();
                }),
        ),
    );
});

describe("real fetch transport boundaries", () => {
    it.each([302, 307, 308])(
        "does not follow a %s redirect or forward the bearer key to a different origin",
        async (status) => {
            const destinationHeaders: unknown[] = [];
            const destination = await listen((request, response) => {
                destinationHeaders.push(request.headers.authorization);
                response.end("{}");
            });
            const sourceHeaders: unknown[] = [];
            const source = await listen((request, response) => {
                sourceHeaders.push(request.headers.authorization);
                response.writeHead(status, { location: `${destination}/capture` });
                response.end();
            });
            const client = createClient({ baseUrl: source, apiKey: KEY, timeoutMs: 2_000 });

            // Runtime-specific fetch messages can classify the failure as redirect
            // or unreachable; the invariant is rejection without a follow-up request.
            await expect(client.key.get()).rejects.toBeInstanceOf(LaunchpadTransportError);
            expect(sourceHeaders).toEqual([`Bearer ${KEY}`]);
            expect(destinationHeaders).toEqual([]);
        },
    );

    it("times out a stalled body after real response headers have arrived", async () => {
        let closed: Promise<unknown[]> | undefined;
        const source = await listen((_request, response) => {
            closed = once(response, "close");
            response.writeHead(200, { "content-type": "application/json" });
            response.flushHeaders();
            response.write('{"id":');
            // No end(): only the client's abort or fixture cleanup closes this body.
        });
        let headersReceived = false;
        const client = createClient({
            baseUrl: source,
            apiKey: KEY,
            timeoutMs: 1_000,
            fetch: (async (...args: Parameters<typeof fetch>) => {
                const response = await fetch(...args);
                headersReceived = true;
                return response;
            }) as typeof fetch,
        });

        await expect(client.key.get()).rejects.toMatchObject({
            name: "LaunchpadTransportError",
            reason: "timeout",
        });
        expect(headersReceived).toBe(true);
        expect(closed).toBeDefined();
        await closed;
    });
});
