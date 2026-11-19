import { Command } from "@commander-js/extra-typings";
import {
    createAuth,
    loadAuthConfig,
    provisionUser,
    resetPassword,
    setupFirstOperator,
} from "@launchpad-kit/auth";
import { createDatabase, migrateToLatest, migrationStatus } from "@launchpad-kit/database";
import { lifecycleConfigFromEnv } from "@launchpad-kit/services";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createDokkuClient } from "@launchpad-kit/dokku";
import { createBackup, verifyBackup } from "./backup";
import { inventoryPreviews } from "./inventory";
import { checkRestore, restoreBackup } from "./restore";

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks)
        .toString("utf8")
        .replace(/\r?\n$/, "");
}

function sshPort(value: string | undefined): number {
    if (value === undefined) return 22;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("DOKKU_SSH_PORT must be a port number (1-65535).");
    }
    return port;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is required (or pass --no-dokku).`);
    return value;
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
    .option("--status", "only list applied and pending migrations; change nothing")
    .action(async (options) => {
        if (options.status) {
            const status = await withDatabase((db) => migrationStatus(db));
            console.log(
                `applied: ${status.applied.length}\npending: ${status.pending.length}` +
                    status.pending.map((name) => `\n  ${name}`).join("") +
                    (status.unknown.length > 0
                        ? `\nunknown to this version (migrated by a newer one): ${status.unknown.join(", ")}`
                        : ""),
            );
            process.exitCode = status.pending.length > 0 || status.unknown.length > 0 ? 1 : 0;
            return;
        }
        const results = await withDatabase((db) => migrateToLatest(db));
        console.log(
            results.length === 0
                ? "Database is up to date."
                : results.map((r) => `${r.name}: ${r.status}`).join("\n"),
        );
    });

program
    .command("backup")
    .description(
        "Write a backup (database dump, stored archives, manifest with checksums) to a new directory",
    )
    .argument("<dir>", "a directory that does not exist yet")
    .option(
        "--i-have-stopped-the-workers",
        "confirm every worker and the lifecycle are stopped (required while the lifecycle is on)",
    )
    .action(async (dir, options) => {
        const manifest = await withDatabase((db) =>
            createBackup({
                db,
                databaseUrl: process.env.DATABASE_URL!,
                dataDir: path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                dest: dir,
                workersStopped: options.iHaveStoppedTheWorkers === true,
                lifecycleEnabled: lifecycleConfigFromEnv(process.env).enabled,
                version:
                    process.env.LAUNCHPAD_VERSION || process.env.npm_package_version || "unknown",
                pgDump: process.env.LAUNCHPAD_PG_DUMP,
            }),
        );
        console.log(
            `Backup written to ${path.resolve(dir)}: ${manifest.migrations.length} migrations, ` +
                `${manifest.artifacts.length} archive(s). Keep it private: the dump holds password and API-key hashes.`,
        );
    });

program
    .command("verify-backup")
    .description("Check a backup directory against its manifest (no database needed)")
    .argument("<dir>", "the backup directory")
    .action(async (dir) => {
        const problems = await verifyBackup(dir);
        if (problems.length > 0) {
            console.error(problems.map((p) => `  ${p}`).join("\n"));
            throw new Error(`The backup does not verify (${problems.length} problem(s)).`);
        }
        console.log("The backup verifies.");
    });

program
    .command("restore")
    .description(
        "Restore a backup into an empty database (or --replace one), and its archives into the data directory",
    )
    .argument("<dir>", "the backup directory")
    .option(
        "--i-have-stopped-the-workers",
        "confirm the lifecycle and deployments are off and every worker has stopped (required)",
    )
    .option(
        "--replace <host:port/database>",
        "replace a database that has data: type its address exactly as the restore prints it",
    )
    .action(async (dir, options) => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is required.");
        const result = await restoreBackup({
            backupDir: dir,
            databaseUrl: url,
            dataDir: path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
            workersStopped: options.iHaveStoppedTheWorkers === true,
            replaceDatabase: options.replace,
            pgRestore: process.env.LAUNCHPAD_PG_RESTORE,
        });
        console.log(
            `Restored the database (${result.manifest.migrations.length} migrations applied) and ` +
                `${result.filesRestored} archive(s) copied (${result.filesAlreadyPresent} already there).`,
        );
        if (result.pendingMigrations.length > 0) {
            console.log(
                `This version has ${result.pendingMigrations.length} migration(s) the backup lacks: run migrate.`,
            );
        }
        console.log(
            "Next: if migrations are pending run migrate, then run check-restore and follow docs/restore.md: " +
                "bring deployments back on first, with the lifecycle still off.",
        );
    });

program
    .command("check-restore")
    .description(
        "Read-only: list live artifacts whose file is missing and live previews whose Dokku app is gone",
    )
    .option("--no-dokku", "skip the Dokku check (otherwise DOKKU_SSH_* settings are required)")
    .action(async (options) => {
        const env = process.env;
        const dokku =
            options.dokku === false
                ? null
                : createDokkuClient({
                      host: required(env, "DOKKU_SSH_HOST"),
                      port: sshPort(env.DOKKU_SSH_PORT),
                      username: env.DOKKU_SSH_USER || "dokku",
                      privateKeyPath: required(env, "DOKKU_SSH_KEY_PATH"),
                      knownHostsPath: required(env, "DOKKU_SSH_KNOWN_HOSTS_PATH"),
                  });
        const report = await withDatabase((db) =>
            checkRestore({
                db,
                dataDir: path.resolve(env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                appExists: dokku ? (name) => dokku.apps.exists(name) : undefined,
            }),
        );
        for (const preview of report.expired) {
            console.log(
                `expired: preview ${preview.previewId} (slug ${preview.slug}) expired ${preview.expiresAt.toISOString()}; extend it to keep it`,
            );
        }
        for (const key of report.missingFiles) console.log(`missing archive: ${key}`);
        for (const app of report.missingApps) {
            console.log(
                `missing app: ${app.appName} (preview ${app.previewId}, slug ${app.slug}, organization ${app.organizationId})`,
            );
        }
        console.log(
            `${report.missingFiles.length} archive(s) missing; ` +
                (report.dokkuChecked
                    ? `${report.missingApps.length} of ${report.appsChecked} deployed preview(s) have no app`
                    : "Dokku was not checked"),
        );
        process.exitCode = report.missingFiles.length + report.missingApps.length > 0 ? 1 : 0;
        if (report.expired.length > 0) {
            console.log(`${report.expired.length} live preview(s) have already expired.`);
        }
    });

program
    .command("inventory-previews")
    .description(
        "Read-only: list the preview-era apps the database recorded and whether they are ready to retire",
    )
    .option("--all", "also list previews that are already deleted")
    .action(async (options) => {
        const inventory = await withDatabase((db) => inventoryPreviews(db));
        for (const item of options.all ? inventory.items : inventory.blocking) {
            const notes = [
                `state ${item.state}`,
                item.deletion ? `deletion ${item.deletion}` : null,
                item.unfinishedDeployments
                    ? `${item.unfinishedDeployments} unfinished deployment(s)`
                    : null,
                item.heldDeployments ? `${item.heldDeployments} held deployment(s)` : null,
                item.imageTags.length ? `images ${item.imageTags.join(", ")}` : null,
            ].filter(Boolean);
            console.log(`${item.appName} ${item.hostname} (${notes.join("; ")})`);
        }
        console.log(
            inventory.readyToRetire
                ? `All ${inventory.items.length} recorded preview(s) are deleted: ready to retire.`
                : `${inventory.blocking.length} of ${inventory.items.length} recorded preview(s) must be deleted or finished first. Nothing was changed; delete each by exact name through the guarded deletion path.`,
        );
        process.exitCode = inventory.readyToRetire ? 0 : 1;
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
            `Password reset for ${result.email}; revoked ${result.revokedSessions} session(s) and ${result.revokedKeys} API key(s).`,
        );
    });

try {
    await program.parseAsync();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
