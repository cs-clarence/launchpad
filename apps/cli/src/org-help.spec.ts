import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDir, session, trackProcessListeners } from "./session-harness";

trackProcessListeners();
let dir = "";
beforeEach(async () => {
    dir = await makeDir();
});
afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const COMMANDS: Array<[string[], string]> = [
    [["org", "create"], "POST /organizations"],
    [["member", "list"], "GET /organizations/:org/members"],
    [["member", "add"], "POST /organizations/:org/members"],
    [["member", "remove"], "DELETE /organizations/:org/members/:userId"],
    [["invite", "create"], "POST /organizations/:org/invitations"],
    [["invite", "list"], "GET /organizations/:org/invitations"],
    [["invite", "revoke"], "DELETE /organizations/:org/invitations/:id"],
    [["key", "list"], "GET /organizations/:org/api-keys"],
    [["key", "issue"], "POST /organizations/:org/api-keys"],
    [["key", "revoke"], "DELETE /organizations/:org/api-keys/:id"],
];

describe("--help of the session-only commands", () => {
    it.each(COMMANDS)(
        "%j names its API call and the lockout note, and sends nothing",
        async (command, call) => {
            const w = await session([...command, "--help"], dir);
            const help = w.out.join("\n").replace(/\s+/g, " ");
            expect(help).toContain(call);
            expect(help).toContain("dashboard sign-in");
            expect(help).toContain("--keep");
            expect(help).toContain("launchpad logout --session");
            expect(help).toContain("15 minutes");
            expect(w.requests).toEqual([]);
            expect(w.prompts).toEqual([]);
        },
    );

    it("says the organization is an ID, for the commands that take one", async () => {
        for (const [command] of COMMANDS.filter(([c]) => c[0] !== "org")) {
            const w = await session([...command, "--help"], dir);
            expect(w.out.join("\n").replace(/\s+/g, " ")).toContain("a UUID, not a slug");
        }
    });
});
