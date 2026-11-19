// Bundled and run inside the worker image, never imported by default tests.
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createDokkuClient } from "../../../packages/dokku/src";
import { artifactStorageKey } from "../../../packages/services/src";
import { tarGz } from "../../../packages/services/src/testing/tar-fixtures";
import { createDocker } from "../../../apps/worker/src/docker";
import { createDeployPorts } from "../../../apps/worker/src/ports";

const resources = await Bun.file("/experiment/resources.json").json();
const dokku = createDokkuClient(
    {
        host: "dokku",
        port: 22,
        username: "dokku",
        privateKeyPath: "/credentials/id_ed25519",
        knownHostsPath: "/credentials/known_hosts",
    },
    { appNamePattern: /^lp-test-[a-z0-9]{6}$/ },
);
const ports = createDeployPorts({
    dokku,
    docker: createDocker(),
    dataDir: "/data",
    limits: { maxExpandedBytes: 1024 * 1024, maxEntries: 100, maxDepth: 8 },
    baseImage: "nginx:1.27-alpine",
    probe: { proxyUrl: new URL("http://dokku"), timeoutMs: 120_000, intervalMs: 1000 },
});
const signal = AbortSignal.timeout(600_000);
const fixtures = [];
const created: { app: string; deploymentId: string; imageTag: string }[] = [];
for (const app of resources.apps as string[]) {
    if (await dokku.apps.exists(app, signal)) throw new Error("Refusing an existing app.");
    const deploymentId = randomUUID();
    const digest = Bun.CryptoHasher.hash("sha256", deploymentId, "hex");
    const storageKey = artifactStorageKey("routing-experiment", digest);
    await mkdir(`/data/${storageKey.substring(0, storageKey.lastIndexOf("/"))}`, {
        recursive: true,
    });
    await writeFile(
        `/data/${storageKey}`,
        tarGz([{ name: "index.html", content: `fixture:${deploymentId}` }]),
    );
    const context = {
        deploymentId,
        appName: app,
        hostname: `${app}.live.example.com`,
        spa: false,
        storageKey,
    };
    created.push({
        app,
        deploymentId,
        imageTag: `launchpad/site:${deploymentId.replaceAll("-", "")}`,
    });
    // Written beside and renamed over the old journal, so a failed write cannot corrupt the
    // record of what earlier fixtures created.
    await Bun.write("/data/created-apps.json.next", JSON.stringify(created, null, 2));
    await rename("/data/created-apps.json.next", "/data/created-apps.json");
    await dokku.apps.create(app, signal);
    const { imageTag } = await ports.build(context, signal);
    // Record the identity before loadImage removes the worker's temporary source tag.
    const inspect = Bun.spawn(["docker", "image", "inspect", "--format", "{{.Id}}", imageTag]);
    const imageId = (await new Response(inspect.stdout).text()).trim();
    if ((await inspect.exited) !== 0) throw new Error("Cannot inspect built fixture.");
    await dokku.domains.set(app, context.hostname, signal);
    await dokku.ports.set(app, "http:80:80", signal);
    await ports.loadImage(context, imageTag, signal);
    await ports.verify(context, signal);
    fixtures.push({ ...context, imageId, imageTag });
    await Bun.write("/data/fixtures.json", JSON.stringify(fixtures, null, 2));
    console.log(JSON.stringify({ event: "fixture-verified", app, deploymentId, imageId }));
}
