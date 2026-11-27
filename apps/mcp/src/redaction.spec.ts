import { createContext } from "@launchpad-kit/client-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createMcpServer } from "./server";

const BODY = "kQ7xLm2Zp9Rt4VbN8cYd5HfJ3wSa6Ue";
const KEY = `lp_${BODY}`;
const FORMS = [
    `plain ${BODY}`,
    `shouting ${BODY.toUpperCase()} and ${BODY.toLowerCase()}`,
    `with prefix ${KEY} / ${KEY.toUpperCase()}`,
    "header Bearer zzTopSecretToken123",
    "cookie __Secure-better-auth.session_token=abc123.sig%2B",
    'quoted __Secure-better-auth.session_token="qq9quoted.sig"; Path=/',
    'host __Host-sid="hh8hosted"; Secure',
];
const LEAKS = [
    BODY,
    BODY.toUpperCase(),
    BODY.toLowerCase(),
    "zzTopSecretToken123",
    "abc123.sig",
    "qq9quoted",
    "hh8hosted",
];

async function call(failing: boolean) {
    const text = FORMS.join("; ");
    const server = createMcpServer(
        createContext(
            { LAUNCHPAD_CONTROLLER: "https://control.example.com", LAUNCHPAD_API_KEY: KEY },
            {
                fetch: (async () =>
                    failing
                        ? Response.json(
                              { code: "forbidden", status: 403, title: text },
                              { status: 403 },
                          )
                        : Response.json({
                              id: "11111111-1111-4111-8111-111111111111",
                              name: text,
                              organizationId: "org-one",
                              scopes: ["project:read"],
                              projectIds: null,
                              expiresAt: "2027-01-01T00:00:00.000Z",
                          })) as unknown as typeof fetch,
            },
        ),
        { workingDir: process.cwd() },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(b);
    await client.connect(a);
    try {
        return await client.callTool({ name: "whoami", arguments: {} });
    } finally {
        await client.close();
        await server.close();
    }
}

it.each([true, false])(
    "hides the run's key in every form in tool output (error: %s)",
    async (failing) => {
        const result = await call(failing);
        const text = JSON.stringify(result);
        for (const leak of LEAKS) expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
        expect(text).toContain("[redacted]");
        expect(() => JSON.parse(text)).not.toThrow();
    },
);
