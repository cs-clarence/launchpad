import { RouterError, parseRouterHostConfig } from "@launchpad-kit/alias-router";
import { parseArgs } from "node:util";
import { initRouter, rotateRouter } from "./commands";
import { checkHealth } from "./healthcheck";
import { LockError } from "./lock";
import { readSecretFile, readSecretStdin, SecretError } from "./secret";
import { startRouter } from "./serve";

const USAGE = `Usage: launchpad-router <command>

Commands:
  serve                                  Run the router (control and data listeners).
  init   (--token-file <path> | --token-stdin)   Create new routing state; prints the epoch.
  rotate (--token-file <path> | --token-stdin)   Start a new epoch and token; prints the epoch.
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
            const healthy = await checkHealth(config.control);
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

    let values: { "token-file"?: string; "token-stdin"?: boolean };
    try {
        ({ values } = parseArgs({
            args: rest,
            options: { "token-file": { type: "string" }, "token-stdin": { type: "boolean" } },
            strict: true,
        }));
    } catch {
        return fail("expected exactly one of --token-file <path> or --token-stdin");
    }
    if ((values["token-file"] === undefined) === (values["token-stdin"] !== true)) {
        return fail("expected exactly one of --token-file <path> or --token-stdin");
    }
    try {
        const token =
            values["token-file"] !== undefined
                ? readSecretFile(values["token-file"])
                : await readSecretStdin(process.stdin);
        const epoch = command === "init" ? initRouter(config, token) : rotateRouter(config, token);
        process.stdout.write(`${epoch}\n`);
    } catch (error) {
        fail(describe(error));
    }
}

await main();
