import { Command } from "@commander-js/extra-typings";
import {
    createAuth,
    loadAuthConfig,
    provisionUser,
    resetPassword,
    setupFirstOperator,
} from "@launchpad/auth";
import { createDatabase, migrateToLatest } from "@launchpad/database";
import { readFileSync, statSync } from "node:fs";

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\r?\n$/, "");
}

// Opens the database named by DATABASE_URL for one command and always closes it.
async function withDatabase<T>(run: (db: ReturnType<typeof createDatabase>) => Promise<T>) {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error("DATABASE_URL is required.");
    }
    const db = createDatabase(url);
    try {
        return await run(db);
    } finally {
        await db.destroy();
    }
}

// The password never travels in an argument or the environment: it comes from a
// file the operator controls, or from piped stdin. A file readable by other users
// is refused. Use a file when running through `omni run`, which does not forward stdin.
async function readPassword(passwordFile: string | undefined): Promise<string> {
    if (passwordFile) {
        if (statSync(passwordFile).mode & 0o077) {
            throw new Error(`${passwordFile} is readable by other users; run chmod 600 on it.`);
        }
        return readFileSync(passwordFile, "utf8").replace(/\r?\n$/, "");
    }
    if (process.stdin.isTTY) {
        throw new Error("Give --password-file <path>, or pipe the password on stdin.");
    }
    return readStdin();
}

const program = new Command()
    .name("launchpad-admin")
    .description(
        "Operator commands for a Launchpad controller. Requires DATABASE_URL; setup and " +
            "reset-password also need the LAUNCHPAD_* authentication settings. Passwords are " +
            "read from a mode-600 file or stdin, never from arguments or the environment.",
    )
    .showHelpAfterError();

program
    .command("migrate")
    .description("Apply pending database migrations (forward-only)")
    .action(async () => {
        const results = await withDatabase((db) => migrateToLatest(db));
        console.log(
            results.length === 0
                ? "Database is up to date."
                : results.map((r) => `${r.name}: ${r.status}`).join("\n"),
        );
    });

program
    .command("setup")
    .description("Create the one instance operator (password on stdin)")
    .requiredOption("--email <email>", "operator email address")
    .option(
        "--password-file <path>",
        "read the password from this file (mode 600) instead of stdin",
    )
    .option("--name <name>", "display name")
    .action(async (options) => {
        const password = await readPassword(options.passwordFile);
        const operator = await withDatabase((db) =>
            setupFirstOperator(
                { db, auth: createAuth({ db, config: loadAuthConfig(process.env) }) },
                { email: options.email, name: options.name ?? "", password },
            ),
        );
        console.log(`Created operator ${operator.email}.`);
    });

program
    .command("create-user")
    .description("Create an ordinary user account (password on stdin)")
    .requiredOption("--email <email>", "user email address")
    .option(
        "--password-file <path>",
        "read the password from this file (mode 600) instead of stdin",
    )
    .option("--name <name>", "display name")
    .action(async (options) => {
        const password = await readPassword(options.passwordFile);
        const user = await withDatabase((db) =>
            provisionUser(
                { db, auth: createAuth({ db, config: loadAuthConfig(process.env) }) },
                { email: options.email, name: options.name ?? "", password, actor: "operator-cli" },
            ),
        );
        console.log(`Created user ${user.email}.`);
    });

program
    .command("reset-password")
    .description("Replace a user's password and revoke their sessions (new password on stdin)")
    .requiredOption("--email <email>", "address of the user to recover")
    .option(
        "--password-file <path>",
        "read the new password from this file (mode 600) instead of stdin",
    )
    .action(async (options) => {
        const password = await readPassword(options.passwordFile);
        const result = await withDatabase((db) =>
            resetPassword(
                { db, auth: createAuth({ db, config: loadAuthConfig(process.env) }) },
                { email: options.email, password, actor: "operator-cli" },
            ),
        );
        console.log(
            `Password reset for ${result.email}; revoked ${result.revokedSessions} session(s).`,
        );
    });

try {
    await program.parseAsync();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
