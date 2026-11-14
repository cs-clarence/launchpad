// Starts or stops the disposable PostgreSQL that integration tests use. Bound to
// 127.0.0.1 only, throwaway credentials, removed on stop. Run by
// `omni run test:db:up` / `omni run test:db:down`.
export {};

const NAME = "launchpad-test-db";
const IMAGE = "postgres:17-alpine";
const PORT = process.env.TEST_DB_PORT ?? "55432";

async function docker(...args: string[]) {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { out: out.trim(), err: err.trim(), code };
}

const running = async () => (await docker("ps", "-q", "-f", `name=^${NAME}$`)).out !== "";

async function ready(): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
        // Over TCP: on a fresh container the image first runs a temporary, socket-only
        // server for initialization and then restarts, so a socket probe succeeds too early.
        const probe = await docker(
            "exec",
            NAME,
            "pg_isready",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            "postgres",
        );
        if (probe.code === 0) {
            console.log(
                `PostgreSQL is ready. TEST_DATABASE_URL=postgres://postgres:dev@127.0.0.1:${PORT}/postgres`,
            );
            return;
        }
        await Bun.sleep(500);
    }
    throw new Error(`${NAME} did not become ready within 30 seconds.`);
}

async function up() {
    if (await running()) {
        console.log(`${NAME} is already running; waiting until it is ready.`);
        await ready();
        return;
    }
    const started = await docker(
        "run",
        "-d",
        "--rm",
        "--name",
        NAME,
        "-e",
        "POSTGRES_PASSWORD=dev",
        "-p",
        `127.0.0.1:${PORT}:5432`,
        IMAGE,
        // Omni runs the integration suites of several projects at once.
        "postgres",
        "-c",
        "max_connections=300",
    );
    if (started.code !== 0) {
        throw new Error(`Could not start ${IMAGE}: ${started.err}`);
    }
    await ready();
}

async function down() {
    if (!(await running())) {
        console.log(`${NAME} is not running.`);
        return;
    }
    const stopped = await docker("stop", NAME);
    if (stopped.code !== 0) {
        throw new Error(`Could not stop ${NAME}: ${stopped.err}`);
    }
    console.log(`Stopped ${NAME}.`);
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") await down();
else {
    console.error("Usage: bun tooling/test-db.ts up|down");
    process.exit(2);
}
