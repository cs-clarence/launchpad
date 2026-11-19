import { describe, expect, it } from "vitest";
import { connectionNames, forwardableRequestHeaders, isResponseHeaderForwarded } from "./headers";

describe("header policy", () => {
    it("drops a request header named by Connection, case-insensitively", () => {
        const headers = new Headers({ connection: "Close, X-Hop", "x-hop": "1", "x-keep": "2" });
        expect(forwardableRequestHeaders(headers)).toEqual({ "x-keep": "2" });
    });

    it("strips hop-by-hop response headers and those Connection names, keeping Location and Set-Cookie", () => {
        const names = connectionNames("X-Custom, close");
        for (const name of [
            "Transfer-Encoding",
            "Keep-Alive",
            "Connection",
            "Proxy-Authenticate",
            "X-Custom",
            "TE",
        ]) {
            expect(isResponseHeaderForwarded(name, names), name).toBe(false);
        }
        for (const name of ["Location", "Set-Cookie", "Content-Type", "X-Launchpad-Deployment"]) {
            expect(isResponseHeaderForwarded(name, names), name).toBe(true);
        }
    });
});
