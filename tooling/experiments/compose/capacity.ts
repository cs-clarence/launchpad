import type { Fixture } from "./docker";
import type { ScenarioContext } from "./scenario";

// One deliberately small, single-host measurement at the DEFAULT limits: it shows how the
// shipped limits behave on this host, not what the stack can sustain. Nothing here is a
// capacity guarantee.
export interface Sample {
    container: string;
    memoryMiB: number;
    cpuPercent: number;
    pids: number;
}

export function parseStats(output: string): Sample[] {
    const unit: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 };
    return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const row = JSON.parse(line) as Record<string, string>;
            const [amount = "", name = ""] =
                (row.MemUsage ?? "")
                    .split(" / ")[0]!
                    .match(/^([\d.]+)(\D+)$/)
                    ?.slice(1) ?? [];
            const scale = unit[name];
            if (scale === undefined || !Number.isFinite(Number(amount)))
                throw new Error("Unrecognized Docker stats output.");
            return {
                container: row.Name ?? "",
                memoryMiB: Number(amount) * scale,
                cpuPercent: Number((row.CPUPerc ?? "0%").replace("%", "")),
                pids: Number(row.PIDs ?? 0),
            };
        });
}

export function peaks(samples: Sample[]) {
    const byName: Record<string, { memoryMiB: number; cpuPercent: number; pids: number }> = {};
    for (const s of samples) {
        const old = byName[s.container] ?? { memoryMiB: 0, cpuPercent: 0, pids: 0 };
        byName[s.container] = {
            memoryMiB: Math.max(old.memoryMiB, Math.round(s.memoryMiB * 10) / 10),
            cpuPercent: Math.max(old.cpuPercent, s.cpuPercent),
            pids: Math.max(old.pids, s.pids),
        };
    }
    return byName;
}

export type Measure = <T>(
    label: string,
    run: () => Promise<T>,
) => Promise<{ value: T; seconds: number; peaks: ReturnType<typeof peaks> }>;

export async function capacityScenario(options: {
    plan: Fixture;
    context: ScenarioContext;
    archives: Record<"near-limit" | "expanded-limit" | "many-files" | "small", ArrayBuffer>;
    measure: Measure;
    backup: () => Promise<number>;
}) {
    const { context: c, archives, measure } = options;
    type Artifact = { id: string };
    type Deployment = { id: string; hostname: string; status: string; desiredState: string };
    const upload = async (bytes: ArrayBuffer) =>
        c.api<Artifact>("POST", `/projects/${c.project}/artifacts`, [200, 201], bytes);
    const app = async (slug: string) =>
        (await c.api<{ id: string }>("POST", `/projects/${c.project}/apps`, [201], { slug })).id;
    const deployed: string[] = [];
    const deploy = async (appId: string, artifact: string) => {
        const row = await c.api<Deployment>("POST", `/apps/${appId}/deployments`, [202], {
            artifactId: artifact,
        });
        deployed.push(row.id);
        await c.inventory();
        return row;
    };
    const succeeded = (id: string, seconds = 600) =>
        c.wait(
            "deployment succeeded",
            async () => {
                const row = await c.api<Deployment>("GET", `/deployments/${id}`, [200]);
                if (["failed", "reconciliation-needed", "cancelled"].includes(row.status))
                    throw new Error(`Fixture deployment ended ${row.status}.`);
                return row.status === "succeeded";
            },
            seconds,
        );

    const results: Record<string, unknown> = {};
    for (const kind of ["small", "near-limit", "expanded-limit", "many-files"] as const) {
        const bytes = archives[kind];
        const uploaded = await measure(`upload ${kind}`, () => upload(bytes));
        const appId = await app(`cap-${kind}`.slice(0, 30));
        const built = await measure(`deploy ${kind}`, async () => {
            const d = await deploy(appId, uploaded.value.id);
            await succeeded(d.id);
        });
        results[kind] = {
            archiveMiB: Math.round((bytes.byteLength / 1048576) * 10) / 10,
            uploadSeconds: uploaded.seconds,
            deploySeconds: built.seconds,
            peaksDuringDeploy: built.peaks,
        };
    }
    await c.record("Upload and deploy at the default limits", results);

    // Many apps deploying at once from one stored archive. The default quota is 10 apps and
    // five already exist (the alias flow's and one per archive size), so five more fill it.
    const small = await upload(archives.small);
    const slugs = Array.from({ length: 5 }, (_, i) => `cap-parallel-${i}`);
    const apps = await Promise.all(slugs.map(app));
    const parallel = await measure("five concurrent deployments", async () => {
        const rows = await Promise.all(apps.map((id) => deploy(id, small.id)));
        await Promise.all(rows.map((row) => succeeded(row.id, 900)));
    });
    await c.record("Five concurrent deployments, filling the default app quota", {
        seconds: parallel.seconds,
        peaks: parallel.peaks,
    });

    const backupSeconds = await options.backup();
    await c.record("Backup and verify with all fixture archives and rows", {
        seconds: backupSeconds,
    });

    // Deletion is part of the fixture contract: cleanup requires every deployment to be gone.
    for (const id of deployed) await c.api("DELETE", `/deployments/${id}`, [202]);
    await c.wait(
        "deployments deleted",
        async () => {
            for (const id of deployed)
                if (
                    (await c.api<Deployment>("GET", `/deployments/${id}`, [200])).desiredState !==
                    "deleted"
                )
                    return false;
            return true;
        },
        600,
    );
    await c.record("Capacity deployments deleted through the API");
}
