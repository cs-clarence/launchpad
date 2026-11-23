import { expect, it } from "bun:test";
import { parseStats, peaks } from "./capacity";

const row = (Name: string, MemUsage: string, CPUPerc: string, PIDs: string) =>
    JSON.stringify({ Name, MemUsage, CPUPerc, PIDs });

it("parses Docker stats units and keeps each container's peak", () => {
    const first = parseStats(
        [row("a", "512KiB / 1GiB", "1.5%", "3"), row("b", "1.5GiB / 2GiB", "50.0%", "9")].join(
            "\n",
        ),
    );
    const second = parseStats(row("a", "64MiB / 512MiB", "12.0%", "40"));
    expect(first.map((s) => Math.round(s.memoryMiB * 100) / 100)).toEqual([0.5, 1536]);
    expect(peaks([...first, ...second])).toEqual({
        a: { memoryMiB: 64, cpuPercent: 12, pids: 40 },
        b: { memoryMiB: 1536, cpuPercent: 50, pids: 9 },
    });
});

it("rejects output it does not understand instead of recording a wrong number", () => {
    expect(() => parseStats(row("a", "unknown", "1%", "1"))).toThrow();
});
