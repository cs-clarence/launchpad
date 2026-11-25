import { expect } from "vitest";
import { PASSWORD, type Recorded, type World } from "./session-harness";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
export const ID = "22222222-2222-4222-8222-222222222222";
export const SECRET = `lp_${"s".repeat(43)}`;
// What a fake controller might leak: the session cookie's pieces.
const COOKIE_PARTS = ["tok1.sig", "tok1%2B", "secretvalue", "better-auth.session_token="];

export const v1 = (w: World): Recorded[] => w.requests.filter((r) => r.path.startsWith("/api/v1/"));
export const callLines = (w: World) => v1(w).map((r) => `${r.method} ${r.path}`);

// The password and cookie are never on screen, no API request carries a key, and every request
// that carries a cookie also carries the exact Origin and no Authorization.
export function expectClean(w: World, extra: string[] = []) {
    for (const secret of [PASSWORD, ...COOKIE_PARTS, ...extra]) {
        expect(w.text()).not.toContain(secret);
    }
    for (const request of w.requests) {
        expect(Object.keys(request.headers)).not.toContain("authorization");
        expect(JSON.stringify(request.headers)).not.toContain("lp_");
    }
}

export const ACTING = (email: string, org?: string) =>
    `Acting as ${email} on https://control.example.com${org ? `, organization ${org}` : ""}`;

// The first `/api/v1` call is made only after the acting line was printed (stderr).
export const onFirstCall = (check: (world: World) => void) => {
    let done = false;
    return (request: Recorded, world: World) => {
        if (!done && request.path.startsWith("/api/v1/")) {
            done = true;
            check(world);
        }
    };
};

export const noHandlers = (w: World) => {
    for (const set of w.listeners.values()) expect(set.size).toBe(0);
};
