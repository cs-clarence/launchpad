import { RouterError, parseRouterHostConfig } from "@launchpad-kit/alias-router";
import { parseArgs } from "node:util";
import { initRouter, rotateRouter } from "./commands";
import { checkHealth } from "./healthcheck";
import { LockError } from "./lock";
import { readOwnerFile, readSecretFile, readSecretStdin, SecretError } from "./secret";
import { startRouter } from "./serve";

const USAGE = `Usage: launchpad-router <command>

Commands:
  serve                                  Run the router (control and data listeners).
  init   (--token-file <path> | --token-stdin)   Create new routing state; prints the epoch.
  rotate (--token-file <path> | --token-stdin) (--database-url-file <path> | --standalone)
                                         Start a new epoch and token; prints the epoch.
                                         Use --standalone only if the router has no model users.
  healthcheck                            Exit 0 when the control listener reports a healthy store.

Settings come from LAUNCHPAD_ROUTER_* and LAUNCHPAD_APPS_* environment variables. The token is read
from an owner-only file or from standard input, never from an argument or the environment.
`;

function fail(message: string): never {
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
}

// Messages here are fixed text or setting names: never a secret, a path's contents or a SQLite error.
function describe(error: unknown): string {
    if (
        error instanceof SecretError ||
        error instanceof LockError ||
        error instanceof RouterError
    ) {
        return error.message;
    }
    if (error instanceof Error && /^LAUNCHPAD_[A-Z_]+ /.test(error.message)) return error.message;
    return "The command failed.";
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    if (!command || command === "--help" || command === "-h") {
        process.stdout.write(USAGE);
        return;
    }
    if (!["serve", "init", "rotate", "healthcheck"].includes(command)) {
        fail(`unknown command "${command.slice(0, 40)}"; see --help`);
    }
    let config: ReturnType<typeof parseRouterHostConfig>;
    try {
        config = parseRouterHostConfig(process.env);
    } catch (error) {
        return fail(describe(error));
    }

    if (command === "healthcheck" || command === "serve") {
        try {
            parseArgs({ args: rest, options: {}, strict: true });
        } catch {
            return fail(`${command} takes no arguments`);
        }
        if (command === "healthcheck") {
            const healthy = await checkHealth(config.control, fetch, 3000, config.controlTls);
            process.stdout.write(healthy ? "ok\n" : "unhealthy\n");
            process.exit(healthy ? 0 : 1);
        }
        let router: ReturnType<typeof startRouter>;
        try {
            router = startRouter(config);
        } catch (error) {
            return fail(describe(error));
        }
        process.stdout.write(
            `${JSON.stringify({ event: "listening", control: router.control, data: router.data })}\n`,
        );
        const stop = (signal: string) => {
            process.stdout.write(`${JSON.stringify({ event: "stopping", signal })}\n`);
            router.shutdown().then(
                () => process.exit(0),
                () => process.exit(1),
            );
        };
        process.once("SIGTERM", () => stop("SIGTERM"));
        process.once("SIGINT", () => stop("SIGINT"));
        return;
    }

    let values: {
        "token-file"?: string;
        "token-stdin"?: boolean;
        standalone?: boolean;
        "database-url-file"?: string;
    };
    try {
        ({ values } = parseArgs({
            args: rest,
            options: {
                "token-file": { type: "string" },
                "token-stdin": { type: "boolean" },
                standalone: { type: "boolean" },
                "database-url-file": { type: "string" },
            },
            strict: true,
        }));
    } catch {
        return fail("expected exactly one of --token-file <path> or --token-stdin");
    }
    if ((values["token-file"] === undefined) === (values["token-stdin"] !== true)) {
        return fail("expected exactly one of --token-file <path> or --token-stdin");
    }
    const standalone = values.standalone === true;
    const databaseFile = values["database-url-file"];
    if (command === "init" && (standalone || databaseFile !== undefined)) {
        return fail("database and standalone options are for rotate only");
    }
    if (command === "rotate" && standalone === (databaseFile !== undefined)) {
        return fail("expected exactly one of --database-url-file <path> or --standalone");
    }
    try {
        const token =
            values["token-file"] !== undefined
                ? readSecretFile(values["token-file"])
                : await readSecretStdin(process.stdin);
        let epoch: string;
        if (command === "init") epoch = initRouter(config, token);
        else if (standalone) {
            epoch = rotateRouter(config, token);
        } else {
            const url = readOwnerFile(databaseFile!, 4096)
                .toString("utf8")
                .replace(/\r?\n$/, "");
            if (!/^postgres(?:ql)?:\/\/\S+$/.test(url))
                return fail("The database URL file is invalid.");
            const { createDatabase } = await import("@launchpad-kit/database");
            const { isModelPrimary, withDeploymentRecoveryMaintenance } =
                await import("@launchpad-kit/database/deployment-lock");
            const db = createDatabase(url, { max: 1, connectionTimeout: 5 });
            const budget = AbortSignal.timeout(30_000);
            // The budget must also end a query PostgreSQL accepted but never answers.
            const deadline = new Promise<never>((_, reject) =>
                budget.addEventListener("abort", () => reject(budget.reason), { once: true }),
            );
            let committed: string | undefined;
            const maintenance = withDeploymentRecoveryMaintenance(
                db,
                async (connection) => {
                    if (!(await isModelPrimary(connection))) {
                        throw new SecretError(
                            "Managed rotation requires the primary deployment model database.",
                        );
                    }
                    // Nothing awaits between this check and the synchronous rotation, so a
                    // rotation can never commit after the command has reported a timeout.
                    budget.throwIfAborted();
                    committed = rotateRouter(config, token);
                    return committed;
                },
                budget,
            );
            maintenance.catch(() => {});
            try {
                epoch = await Promise.race([maintenance, deadline]);
            } catch (error) {
                if (committed !== undefined) {
                    // The router already changed epoch; only releasing the lock failed. Report
                    // the epoch (not a secret) so the credentials can be updated, then exit.
                    process.stderr.write(
                        "warning: the epoch was rotated but releasing the maintenance lock failed; update the worker epoch and token before resuming.\n",
                    );
                    process.stdout.write(`${committed}\n`, () => process.exit(0));
                    return;
                }
                if (error instanceof Error && error.name === "TimeoutError") {
                    throw new SecretError(
                        "Timed out waiting for exclusive router maintenance; pause model writers, check database connectivity, and retry.",
                    );
                }
                throw error;
            } finally {
                await Promise.race([
                    db.destroy().catch(() => {}),
                    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
                ]);
            }
        }
        process.stdout.write(`${epoch}\n`);
    } catch (error) {
        fail(describe(error));
    }
}

await main();
