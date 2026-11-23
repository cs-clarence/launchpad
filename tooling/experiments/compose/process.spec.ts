import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureProcessTimeout, runFixtureProcess } from "./process";

const env = { PATH: process.env.PATH ?? "" };

it("collects both pipes and stdin on normal completion", async () => {
    const result = await runFixtureProcess(["sh", "-c", "cat; printf error >&2; exit 3"], {
        env,
        input: "input\n",
        timeoutMs: 2000,
    });
    expect(result).toEqual({ out: "input", err: "error", code: 3 });
});

it("times out even when a child holds the pipes after its launcher exits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-pipe-test-"));
    const marker = join(dir, "survived");
    try {
        await expect(
            runFixtureProcess(
                ["sh", "-c", '(sleep 0.4; printf survived > "$1"; sleep 5) & exit 0', "sh", marker],
                { env, timeoutMs: 120 },
            ),
        ).rejects.toBeInstanceOf(FixtureProcessTimeout);
        await Bun.sleep(500);
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
