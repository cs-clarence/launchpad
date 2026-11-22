import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocker, dokkuIdle, raceRounds, type Resources } from "./harness";
import { isFaultRule, matches, pickRule, summarize, type FaultRule } from "./rules";

const rule = (over: Partial<FaultRule> = {}): FaultRule => ({
    id: "r1",
    action: "hold",
    method: "POST",
    pathPrefix: "/v1/routes",
    body: { hostname: "a.example", generation: "3" },
    once: true,
    ...over,
});
const write = {
    method: "POST",
    path: "/v1/routes",
    body: { hostname: "a.example", generation: 3 },
};

describe("Dokku fixture settlement", () => {
    const header = "PID COMMAND          COMMAND";
    const daemons = "1 tini /usr/bin/tini\n2 sshd sshd: /usr/sbin/sshd -D [listener]";
    const listing = (out: string, code = 0) => ({ out, code, err: "" });

    it("requires a usable process listing and rejects active SSH or Docker/Dokku work", () => {
        expect(dokkuIdle(listing(`${header}\n${daemons}`))).toBe(true);
        for (const line of [
            "3 bash /bin/bash /usr/bin/dokku apps:destroy lp-1234567890",
            "3 docker /usr/bin/docker container rm app",
            "3 sshd sshd: dokku@notty",
        ]) {
            expect(dokkuIdle(listing(`${header}\n${daemons}\n${line}`))).toBe(false);
        }
        expect(dokkuIdle(listing(header))).toBe(false);
        expect(dokkuIdle(listing(daemons))).toBe(false);
        expect(dokkuIdle(listing(`${header}\n${daemons}`, 1))).toBe(false);
    });
});

it("keeps the last complete fixture inventory when a new write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-inventory-"));
    const r: Resources = {
        dir,
        network: "fixture-net",
        containers: {
            controller: "controller",
            dokku: "dokku",
            postgres: "postgres",
            router: "router",
            proxy: "proxy",
            worker1: "worker1",
            worker2: "worker2",
        },
        images: { controller: "controller", worker: "worker", router: "router" },
        volumes: [],
        helpers: [],
        discovered: [],
    };
    try {
        const { persist } = createDocker(r);
        await persist();
        const previous = await readFile(join(dir, "resources.json"), "utf8");
        const temp = join(dir, "resources.json.next");
        await mkdir(temp);
        r.helpers.push("fixture-helper");
        await expect(persist()).rejects.toThrow();
        expect(await readFile(join(dir, "resources.json"), "utf8")).toBe(previous);
        await rm(temp, { recursive: true });
        await persist();
        expect(JSON.parse(await readFile(join(dir, "resources.json"), "utf8")).helpers).toEqual([
            "fixture-helper",
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

describe("fault rules", () => {
    it("rejects malformed rules and reusable holds", () => {
        expect(isFaultRule(rule({ body: {} }))).toBe(true);
        expect(isFaultRule(rule({ once: false }))).toBe(false);
        expect(isFaultRule(rule({ action: "drop-response", once: false }))).toBe(true);
        for (const invalid of [null, [], undefined, { generation: 3 }]) {
            expect(isFaultRule({ ...rule(), body: invalid })).toBe(false);
        }
        expect(isFaultRule({ ...rule(), method: null })).toBe(false);
        expect(isFaultRule({ ...rule(), pathPrefix: "" })).toBe(false);
    });
    it("matches by method, path prefix and string-compared body fields", () => {
        expect(matches(rule(), write)).toBe(true);
        expect(matches(rule(), { ...write, method: "GET" })).toBe(false);
        expect(matches(rule(), { ...write, path: "/v1/deployments" })).toBe(false);
        expect(matches(rule(), { ...write, body: { hostname: "a.example", generation: 4 } })).toBe(
            false,
        );
        expect(matches(rule(), { ...write, body: { hostname: "a.example" } })).toBe(false);
        expect(matches(rule(), { ...write, body: null })).toBe(false);
        expect(matches(rule({ body: {} }), { ...write, body: null })).toBe(true);
    });

    it("spends a once rule on its first match only", () => {
        const rules = [rule()];
        expect(pickRule(rules, new Set(), write)?.id).toBe("r1");
        expect(pickRule(rules, new Set(["r1"]), write)).toBeUndefined();
        expect(pickRule([rule({ once: false })], new Set(["r1"]), write)?.id).toBe("r1");
    });

    it("records identifiers only", () => {
        expect(
            summarize({ hostname: "h", generation: 7, targetDeploymentId: null, token: "secret" }),
        ).toEqual({ hostname: "h", generation: "7", targetDeploymentId: null });
        expect(summarize("not an object")).toEqual({});
    });
});

it("requires at least one race round before provisioning", () => {
    expect(raceRounds(undefined)).toBe(3);
    expect(raceRounds("6")).toBe(6);
    for (const invalid of ["", "0", "-1", "NaN", "1.5", "Infinity"]) {
        expect(() => raceRounds(invalid)).toThrow("must be a positive integer");
    }
});
