import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "./errors";
import {
    ACTING,
    callLines,
    expectClean,
    ID,
    noHandlers,
    onFirstCall,
    ORG,
    v1,
} from "./org-harness";
import {
    CONTROLLER,
    json,
    makeDir,
    newServer,
    OPERATOR,
    OWNER,
    PASSWORD,
    session,
    trackProcessListeners,
    USERS,
    type Api,
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

const go = (args: string[], options: Options = {}) => session(args, dir, { server, ...options });
const refused = (w: World, code: number = EXIT.usage) => {
    expect(w.code).toBe(code);
    expect(w.requests).toEqual([]);
    expect(w.prompts).toEqual([]);
    expectClean(w);
    noHandlers(w);
};
const error = (status: number, title: string) => json({ code: "x", title, status }, { status });

describe("org create", () => {
    const args = (...extra: string[]) => [
        "org",
        "create",
        "--email",
        OPERATOR,
        "--password-file",
        "pw",
        "--name",
        "Demo",
        "--slug",
        "demo",
        "--owner-email",
        "Ann@Example.com",
        "--confirm",
        ...extra,
    ];
    const opts = (extra: Options = {}): Options => ({
        files: { pw: USERS[OPERATOR]! },
        ...extra,
    });

    it("sends POST /organizations with {name, slug, ownerEmail} and prints the ID", async () => {
        const w = await go(args(), {
            ...opts({
                onRequest: onFirstCall((x) => expect(x.err).toContain(ACTING(OPERATOR))),
            }),
            respond: () => json({ id: ORG, name: "Demo", slug: "demo" }, { status: 201 }),
        });
        expect(w.code).toBe(EXIT.ok);
        expect(w.requests.map((r) => r.path)).toEqual([
            "/api/auth/sign-in/email",
            "/api/v1/organizations",
            "/api/auth/sign-out",
        ]);
        const request = v1(w)[0]!;
        expect(request.method).toBe("POST");
        expect(JSON.parse(request.body)).toEqual({
            name: "Demo",
            slug: "demo",
            ownerEmail: "ann@example.com",
        });
        expect(request.headers.origin).toBe(CONTROLLER);
        expect(w.out).toEqual([`Created organization demo (${ORG}) with owner ann@example.com.`]);
        expect(w.err.filter((l) => l.startsWith("Acting as"))).toEqual([ACTING(OPERATOR)]);
        expectClean(w);
        noHandlers(w);
    });

    it("--json prints the response and nothing else on stdout", async () => {
        const w = await go(args("--json"), {
            ...opts(),
            respond: () => json({ id: ORG, name: "Demo", slug: "demo" }, { status: 201 }),
        });
        expect(JSON.parse(w.out.join("\n"))).toEqual({ id: ORG, name: "Demo", slug: "demo" });
    });

    it("exits 2 with zero requests without --confirm, with a key set, with no --email or bad input", async () => {
        const without = (flag: string, count = 2) => {
            const a = args();
            a.splice(a.indexOf(flag), count);
            return a;
        };
        for (const [a, extra] of [
            [without("--confirm", 1), {}],
            [args(), { env: { LAUNCHPAD_API_KEY: `lp_${"k".repeat(43)}` } }],
            [without("--email"), {}],
            [without("--name"), {}],
            [without("--slug"), {}],
            [without("--owner-email"), {}],
            [args().map((x) => (x === "demo" ? "Not A Slug" : x)), {}],
            [args().map((x) => (x === "Ann@Example.com" ? "nope" : x)), {}],
            [args().map((x) => (x === "Demo" ? " " : x)), {}],
        ] as Array<[string[], Options]>) {
            refused(await go(a, { ...opts(), ...extra }));
        }
    });

    it("maps a non-operator to exit 3, an unknown owner to 1 and a duplicate slug to 1", async () => {
        for (const [status, title, code] of [
            [403, "Only the instance operator can do this.", EXIT.unauthorized],
            [422, "The owner must be an existing user", EXIT.failure],
            [409, "That slug is taken.", EXIT.failure],
        ] as const) {
            const w = await go(args(), { ...opts(), respond: () => error(status, title) });
            expect(w.code).toBe(code);
            expect(w.err.join("\n")).toContain(title);
            expect(callLines(w)).toEqual(["POST /api/v1/organizations"]);
            expectClean(w);
        }
    });
});

describe("member", () => {
    const BOB = "bob@example.com";
    const members = [
        { userId: "u1", email: OWNER, name: "Ann", role: "owner" },
        { userId: "u2", email: BOB, name: "Bob", role: "deployer" },
    ];
    const base = ["--org", ORG, "--email", OWNER];
    const respond = (api: Api) => {
        if (
            api.path !== `/organizations/${ORG}/members` &&
            !api.path.startsWith(`/organizations/${ORG}/members/`)
        ) {
            return error(404, "Not found");
        }
        if (api.method === "GET") return json(members);
        if (api.method === "POST")
            return json({ userId: "u2", role: JSON.parse(api.body).role }, { status: 201 });
        return json({ ok: true });
    };

    it("lists, adds and removes, one request each", async () => {
        const list = await go(["member", "list", ...base], { respond });
        expect(list.code).toBe(EXIT.ok);
        expect(list.out.join("\n")).toMatch(/^USER ID\s+EMAIL\s+NAME\s+ROLE/);
        expect(list.out.join("\n")).toMatch(/u2\s+bob@example\.com\s+Bob\s+deployer/);
        expect(callLines(list)).toEqual([`GET /api/v1/organizations/${ORG}/members`]);
        expect(list.err).toContain(ACTING(OWNER, ORG));

        const add = await go(
            [
                "member",
                "add",
                ...base,
                "--user-email",
                "Bob@Example.com",
                "--role",
                "deployer",
                "--confirm",
            ],
            { respond },
        );
        expect(add.code).toBe(EXIT.ok);
        expect(callLines(add)).toEqual([`POST /api/v1/organizations/${ORG}/members`]);
        expect(JSON.parse(v1(add)[0]!.body)).toEqual({ email: BOB, role: "deployer" });
        expect(add.out).toEqual([`Added ${BOB} to ${ORG} as deployer.`]);

        const remove = await go(["member", "remove", "user/2", ...base, "--confirm"], { respond });
        expect(remove.code).toBe(EXIT.ok);
        expect(callLines(remove)).toEqual([`DELETE /api/v1/organizations/${ORG}/members/user%2F2`]);
        expect(remove.out).toEqual([`Removed user/2 from ${ORG}.`]);
        for (const w of [list, add, remove]) {
            expect(w.requests.map((r) => r.path)).toHaveLength(3);
            expect(w.err.filter((l) => l.startsWith("Acting as"))).toHaveLength(1);
            expectClean(w);
            noHandlers(w);
        }
    });

    it("--json prints exactly the response for add and remove", async () => {
        const add = await go(
            [
                "member",
                "add",
                ...base,
                "--user-email",
                BOB,
                "--role",
                "viewer",
                "--confirm",
                "--json",
            ],
            { respond },
        );
        expect(JSON.parse(add.out.join("\n"))).toEqual({ userId: "u2", role: "viewer" });
        const remove = await go(["member", "remove", "u2", ...base, "--confirm", "--json"], {
            respond,
        });
        expect(JSON.parse(remove.out.join("\n"))).toEqual({ ok: true });
        expect(add.out.join("\n") + remove.out.join("\n")).not.toContain("Acting as");
    });

    it("--json prints the body with no acting line on stdout", async () => {
        const w = await go(["member", "list", ...base, "--json"], { respond });
        expect(JSON.parse(w.out.join("\n"))).toEqual(members);
        expect(w.out.join("\n")).not.toContain("Acting as");
    });

    it("maps the controller's refusals: last owner 409, admin adding admin 403, already a member 409, outsider 404", async () => {
        for (const [argv, status, title, code] of [
            [
                ["member", "remove", "u1", ...base, "--confirm"],
                409,
                "An organization must keep at least one owner",
                EXIT.failure,
            ],
            [
                ["member", "add", ...base, "--user-email", BOB, "--role", "admin", "--confirm"],
                403,
                "Your role cannot assign the admin role.",
                EXIT.unauthorized,
            ],
            [
                ["member", "add", ...base, "--user-email", BOB, "--role", "viewer", "--confirm"],
                409,
                "Already a member.",
                EXIT.failure,
            ],
            [["member", "list", ...base], 404, "Not found", EXIT.notFound],
        ] as const) {
            const w = await go([...argv], { respond: () => error(status, title) });
            expect(w.code).toBe(code);
            expect(w.err.join("\n")).toContain(title);
            expect(w.requests.filter((r) => r.path.startsWith("/api/v1/"))).toHaveLength(1);
        }
    });

    it("exits 2 with zero requests for bad input, a missing --confirm, a key or a slug org", async () => {
        const key = { env: { LAUNCHPAD_API_KEY: `lp_${"k".repeat(43)}` } };
        for (const [argv, extra] of [
            [["member", "add", ...base, "--user-email", BOB, "--role", "viewer"], {}],
            [["member", "add", ...base, "--user-email", BOB, "--role", "boss", "--confirm"], {}],
            [
                ["member", "add", ...base, "--user-email", "nope", "--role", "viewer", "--confirm"],
                {},
            ],
            [["member", "add", ...base, "--role", "viewer", "--confirm"], {}],
            [["member", "remove", "u2", ...base], {}],
            [["member", "remove", "..", ...base, "--confirm"], {}],
            [["member", "remove", "a\nb", ...base, "--confirm"], {}],
            [["member", "remove", "u2", "--org", "demo", "--email", OWNER, "--confirm"], {}],
            [["member", "list", ...base], key],
            [["member", "add", ...base, "--user-email", BOB, "--role", "viewer", "--confirm"], key],
            [["member", "remove", "u2", ...base, "--confirm"], key],
            [["member", "list", "--org", ORG], {}],
        ] as Array<[string[], Options]>) {
            refused(await go(argv, { respond, ...extra }));
        }
    });

    it("a wrong account: a different --email from the saved session exits 2, nothing sent", async () => {
        await go(["login", "--session", "--email", OWNER]);
        const w = await go(["member", "list", "--org", ORG, "--email", OPERATOR], { respond });
        expect(w.code).toBe(EXIT.usage);
        expect(w.requests).toEqual([]);
    });

    it("never shows the password or cookie even when the controller echoes them", async () => {
        const w = await go(["member", "list", ...base], {
            respond: () => error(500, `boom ${PASSWORD} ${ID}`),
        });
        expect(w.text()).not.toContain(PASSWORD);
    });
});
