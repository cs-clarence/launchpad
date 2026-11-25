import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import { ACTING, callLines, expectClean, ID, noHandlers, ORG, v1 } from "./org-harness";
import {
    json,
    makeDir,
    newServer,
    OWNER,
    session,
    trackProcessListeners,
    type Options,
    type Server,
    type World,
} from "./session-harness";

trackProcessListeners();
let dir = "";
let server: Server;
beforeEach(async () => {
    dir = await makeDir();
    server = newServer();
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const TOKEN = "tok_" + "t".repeat(48);
const go = (args: string[], options: Options = {}) => session(args, dir, { server, ...options });
const base = ["--org", ORG, "--email", OWNER];
const when = "2026-11-26T10:00:00.000Z";
const error = (status: number, title: string) => json({ code: "x", title, status }, { status });
const refused = (w: World) => {
    expect(w.code).toBe(EXIT.usage);
    expect(w.requests).toEqual([]);
    expect(w.prompts).toEqual([]);
    expectClean(w, [TOKEN]);
    noHandlers(w);
};

describe("invite", () => {
    it("creates, lists and revokes, one request each, and never shows a token", async () => {
        const respond = (api: { method: string }) =>
            api.method === "POST"
                ? json(
                      { id: ID, email: "carol@example.com", role: "viewer", token: TOKEN },
                      { status: 201 },
                  )
                : api.method === "GET"
                  ? json([
                        {
                            id: ID,
                            email: "carol@example.com",
                            role: "viewer",
                            createdAt: when,
                            expiresAt: when,
                            token: TOKEN,
                        },
                    ])
                  : json({ ok: true });
        const create = await go(
            [
                "invite",
                "create",
                ...base,
                "--to",
                "Carol@Example.com",
                "--role",
                "viewer",
                "--confirm",
            ],
            { respond },
        );
        expect(create.code).toBe(EXIT.ok);
        expect(callLines(create)).toEqual([`POST /api/v1/organizations/${ORG}/invitations`]);
        expect(JSON.parse(v1(create)[0]!.body)).toEqual({
            email: "carol@example.com",
            role: "viewer",
        });
        expect(create.out).toEqual([
            `Invited carol@example.com as viewer (${ID}). The invitation was emailed.`,
        ]);

        const list = await go(["invite", "list", ...base], { respond });
        expect(list.out.join("\n")).toMatch(/^ID\s+EMAIL\s+ROLE\s+CREATED\s+EXPIRES/);
        expect(list.out.join("\n")).toContain("carol@example.com");
        expect(callLines(list)).toEqual([`GET /api/v1/organizations/${ORG}/invitations`]);

        const revoke = await go(["invite", "revoke", ID, ...base, "--confirm"], { respond });
        expect(revoke.out).toEqual([`Revoked invitation ${ID}.`]);
        expect(callLines(revoke)).toEqual([
            `DELETE /api/v1/organizations/${ORG}/invitations/${ID}`,
        ]);

        for (const w of [create, list, revoke]) {
            expect(w.err.filter((l) => l.startsWith("Acting as"))).toEqual([ACTING(OWNER, ORG)]);
            expect(w.requests).toHaveLength(3);
            expectClean(w, [TOKEN]);
            noHandlers(w);
        }
        for (const flags of [
            ["invite", "create", "--to", "a@b.co", "--role", "viewer", "--confirm"],
            ["invite", "list"],
        ]) {
            const w = await go([...flags.slice(0, 2), ...base, ...flags.slice(2), "--json"], {
                respond,
            });
            expect(w.out.join("\n")).not.toContain(TOKEN);
            expect(JSON.parse(w.out.join("\n"))).toBeTruthy();
            expect(w.out.join("\n")).not.toContain("Acting as");
        }
    });

    it("says there are none", async () => {
        const w = await go(["invite", "list", ...base], { respond: () => json([]) });
        expect(w.out).toEqual(["No invitations."]);
    });

    it("maps not enabled 404, mail failure 502, duplicate 409 and forbidden 403", async () => {
        for (const [status, title, code] of [
            [404, "Invitations are not enabled.", EXIT.notFound],
            [502, "The invitation email could not be sent.", EXIT.failure],
            [409, "Already a member.", EXIT.failure],
            [403, "Your role cannot assign the admin role.", EXIT.unauthorized],
        ] as const) {
            const w = await go(
                ["invite", "create", ...base, "--to", "c@d.co", "--role", "admin", "--confirm"],
                { respond: () => error(status, title) },
            );
            expect(w.code).toBe(code);
            expect(w.err.join("\n")).toContain(title);
            expect(callLines(w)).toHaveLength(1);
        }
    });

    it("exits 2 with zero requests for bad input, no --confirm, a key or a slug org", async () => {
        const key = { env: { LAUNCHPAD_API_KEY: `lp_${"k".repeat(43)}` } };
        for (const [argv, extra] of [
            [["invite", "create", ...base, "--to", "c@d.co", "--role", "viewer"], {}],
            [["invite", "create", ...base, "--to", "c@d.co", "--role", "boss", "--confirm"], {}],
            [["invite", "create", ...base, "--to", "nope", "--role", "viewer", "--confirm"], {}],
            [["invite", "create", ...base, "--role", "viewer", "--confirm"], {}],
            [["invite", "revoke", ID, ...base], {}],
            [["invite", "revoke", "not-a-uuid", ...base, "--confirm"], {}],
            [["invite", "list", "--org", "demo", "--email", OWNER], {}],
            [["invite", "list", ...base], key],
            [["invite", "create", ...base, "--to", "c@d.co", "--role", "viewer", "--confirm"], key],
            [["invite", "revoke", ID, ...base, "--confirm"], key],
        ] as Array<[string[], Options]>) {
            refused(await go(argv, { respond: () => json([]), ...extra }));
        }
    });
});
