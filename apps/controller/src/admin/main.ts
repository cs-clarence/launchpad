import { Command } from "@commander-js/extra-typings";
import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import {
    createAuth,
    loadAuthConfig,
    provisionUser,
    resetPassword,
    setupFirstOperator,
} from "@launchpad-kit/auth";
import { createDatabase, migrateToLatest, migrationStatus } from "@launchpad-kit/database";
import {
    closeSync,
    constants,
    fstatSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
import path from "node:path";
import { createDokkuClient } from "@launchpad-kit/dokku";
import {
    acknowledgeDeploymentImport,
    clearDeploymentRecovery,
    parseAppRoutingConfig,
    reconcileDeployment,
    supersedeOperation,
} from "@launchpad-kit/services";
import { createBackup, verifyBackup } from "./backup";
import { checkRestore, restoreBackup, replaceTarget } from "./restore";

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

function readRouterCredential(file: string, secret: boolean): string {
    try {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd);
            const bytes = Buffer.alloc(257);
            if (
                !stat.isFile() ||
                (secret && (stat.uid !== process.getuid?.() || stat.mode & 0o077)) ||
                stat.size > 256
            ) {
                throw new Error();
            }
            const size = readSync(fd, bytes);
            if (size === 257) throw new Error();
            return new TextDecoder("utf-8", { fatal: true })
                .decode(bytes.subarray(0, size))
                .replace(/\r?\n$/, "");
        } finally {
            closeSync(fd);
        }
    } catch {
        throw new Error("Could not read the configured router credential file.");
    }
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
    .action(async (dir) => {
        const manifest = await withDatabase((db) =>
            createBackup({
                db,
                databaseUrl: process.env.DATABASE_URL!,
                dataDir: path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                dest: dir,
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
        "confirm every writer is stopped and the Dokku operations they dispatched have settled (required)",
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
                `This version has ${result.pendingMigrations.length} migration(s) the backup lacks. Before migrate, follow docs/restore.md step 3: use the pre-P2b binary to inventory/clean up pre-018 data after a verified backup.`,
            );
        }
        console.log(
            "Next: follow docs/restore.md before migrating or starting the controller; keep ingress closed and preserve the recovery records.",
        );
    });

program
    .command("recovery-ack-import")
    .description(
        "Acknowledge a crashed restore importer only after its OS process and database backend have exited",
    )
    .requiredOption(
        "--i-have-stopped-the-importer",
        "confirm the old importer, wrappers and its database backend have exited",
    )
    .action(async (options) => {
        await withDatabase((db) =>
            acknowledgeDeploymentImport(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                replaceTarget(process.env.DATABASE_URL!),
                options.iHaveStoppedTheImporter === true,
            ),
        );
        console.log(
            "Previous importer acknowledged in the durable maintenance audit. Model recovery remains blocked.",
        );
    });

program
    .command("recovery-clear")
    .description("Reopen model mutations after a restore, once the operator has reconciled")
    .option(
        "--i-have-reconciled-router-and-dokku",
        "attest: ingress closed, dispatched Dokku work settled, router epoch and credentials rotated (if used), router and Dokku reconciled",
    )
    .action(async (options) => {
        await withDatabase((db) =>
            clearDeploymentRecovery(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                options.iHaveReconciledRouterAndDokku === true,
            ),
        );
        console.log("Deployment recovery cleared on the operator's attestation.");
    });

program
    .command("promotion-repair-generation")
    .description("Verify a held generation mismatch and queue a higher-generation correction")
    .requiredOption("--operation <id>", "the held promotion operation")
    .option("--target <id>", "bind to an eligible target from the held chain")
    .option("--withdraw", "correct an uncertain withdrawal")
    .option(
        "--i-have-verified-the-router-by-exact-route",
        "attest that the configured router is authoritative",
    )
    .action(async (options) => {
        if (Boolean(options.target) === Boolean(options.withdraw)) {
            throw new Error("Specify exactly one of --target or --withdraw.");
        }
        const routing = parseAppRoutingConfig(process.env);
        if (!routing.enabled) throw new Error("Router settings are required.");
        const url = routing.aliasControlUrl;
        if (
            url.protocol !== "https:" &&
            !["127.0.0.1", "[::1]"].includes(url.hostname) &&
            process.env.LAUNCHPAD_ALIAS_CONTROL_PRIVATE_NETWORK !== "1"
        ) {
            throw new Error(
                "Router control requires HTTPS, loopback, or explicit private-network opt-in.",
            );
        }
        const authority = {
            instanceId: routing.aliasInstanceId,
            epoch: readRouterCredential(routing.aliasRouterEpochFile, false),
        };
        const client = createRouterControlClient({
            baseUrl: url,
            credentials: {
                ...authority,
                token: readRouterCredential(routing.aliasControlTokenFile, true),
            },
        });
        const result = await withDatabase((db) =>
            supersedeOperation(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                {
                    operationId: options.operation,
                    action: options.withdraw ? "withdraw" : "bind",
                    targetDeploymentId: options.target,
                    attested: options.iHaveVerifiedTheRouterByExactRoute === true,
                },
                { authority, readRoute: client.readRoute },
            ),
        );
        console.log(
            `Queued corrective promotion ${result.operationId} at generation ${result.generation}.`,
        );
    });

program
    .command("deployment-reconcile")
    .description(
        "Record what you observed on Dokku for a deployment or deletion the worker held as reconciliation-needed. Never calls Dokku",
    )
    .requiredOption("--deployment <id>", "the deployment's ID")
    .requiredOption(
        "--outcome <outcome>",
        "succeeded (deployment: it serves its recorded image; deletion: the app is gone), failed-clean (deployment: nothing of it exists; deletion: the app was not destroyed), failed-owned (deployment only: its app exists and deletion may destroy it), or abandon (deployment only; nothing unrecorded is ever destroyed)",
    )
    .option(
        "--i-have-verified-dokku-by-exact-name",
        "attest: you checked Dokku for this deployment's exact app name and image",
    )
    .action(async (options) => {
        if (!["succeeded", "failed-clean", "failed-owned", "abandon"].includes(options.outcome)) {
            throw new Error("--outcome must be succeeded, failed-clean, failed-owned or abandon.");
        }
        if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                options.deployment,
            )
        ) {
            throw new Error("--deployment must be a deployment ID (a UUID).");
        }
        const result = await withDatabase((db) =>
            reconcileDeployment(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                {
                    deploymentId: options.deployment,
                    outcome: options.outcome as
                        | "succeeded"
                        | "failed-clean"
                        | "failed-owned"
                        | "abandon",
                    attested: options.iHaveVerifiedDokkuByExactName === true,
                },
            ),
        );
        console.log(`Recorded ${result.outcome} for 1 ${result.kind}.`);
    });

program
    .command("check-restore")
    .description("Read-only: list missing archives and deployment apps")
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
        for (const deployment of report.expired) {
            console.log(
                `expired: deployment ${deployment.deploymentId} preview deadline ${deployment.expiresAt.toISOString()}; reconcile before enabling model mutations`,
            );
        }
        for (const key of report.missingFiles) console.log(`missing archive: ${key}`);
        for (const app of report.missingApps) {
            console.log(
                `missing app: ${app.appName} (deployment ${app.deploymentId}, organization ${app.organizationId})`,
            );
        }
        console.log(
            `${report.missingFiles.length} archive(s) missing; ` +
                (report.dokkuChecked
                    ? `${report.missingApps.length} of ${report.appsChecked} deployment(s) have no app`
                    : "Dokku was not checked"),
        );
        process.exitCode = report.missingFiles.length + report.missingApps.length > 0 ? 1 : 0;
        if (report.expired.length > 0) {
            console.log(`${report.expired.length} deployment preview deadline(s) have passed.`);
        }
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
