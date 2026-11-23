import { Command } from "@commander-js/extra-typings";
import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import {
    createAuth,
    loadAuthConfig,
    provisionUser,
    resetPassword,
    revokeAllCredentials,
    setupFirstOperator,
} from "@launchpad-kit/auth";
import { createDatabase, migrateToLatest, migrationStatus } from "@launchpad-kit/database";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createDokkuClient } from "@launchpad-kit/dokku";
import {
    acknowledgeDeploymentImport,
    assertPrivateControlUrl,
    clearDeploymentRecovery,
    parseAppRoutingConfig,
    readRecoveryMarker,
    raiseAliasCounters,
    withdrawUnknownRoute,
    readRouterCredential,
    readDriftDatabase,
    reconcileDeployment,
    RECONCILIATION_REQUESTED,
    republishRecoveryAlias,
    supersedeOperation,
} from "@launchpad-kit/services";
import { createBackup, verifyBackup } from "./backup";
import {
    collectDrift,
    driftCommandExitCode,
    readDriftArchives,
    readDriftDokku,
    readDriftProbes,
    readDriftRouter,
    readRepublishProbe,
    readUnservableProbe,
} from "./drift";
import { recoveryAnchorNotice, routerAnchorFromEnv, routerSessionFromEnv } from "./router-view";
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

function dokkuFromEnv(env: NodeJS.ProcessEnv) {
    return createDokkuClient({
        host: required(env, "DOKKU_SSH_HOST"),
        port: sshPort(env.DOKKU_SSH_PORT),
        username: env.DOKKU_SSH_USER || "dokku",
        privateKeyPath: required(env, "DOKKU_SSH_KEY_PATH"),
        knownHostsPath: required(env, "DOKKU_SSH_KNOWN_HOSTS_PATH"),
    });
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
        // Read the router's epoch before anything changes, while the pre-restore credentials still
        // match: recovery-clear later verifies that it has been rotated since.
        const routerAnchor = await routerAnchorFromEnv(process.env);
        const dataDir = path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller");
        const result = await restoreBackup({
            backupDir: dir,
            databaseUrl: url,
            dataDir,
            workersStopped: options.iHaveStoppedTheWorkers === true,
            replaceDatabase: options.replace,
            pgRestore: process.env.LAUNCHPAD_PG_RESTORE,
            routerAnchor,
        });
        // Judge by the marker on disk: a retry keeps the first anchor, whatever this run read.
        const notice = recoveryAnchorNotice(await readRecoveryMarker(dataDir));
        if (notice) console.log(notice);
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
    .description("Verify recovery evidence and reopen model mutations after a restore")
    .option(
        "--i-have-checked-the-dokku-host",
        "confirm no Dokku work dispatched before the restore is still running",
    )
    .option(
        "--router-epoch-unrecorded",
        "confirm you rotated the router yourself: the restore recorded no router epoch to verify against",
    )
    .option(
        "--accept <code:id...>",
        "accept exact current external findings; repeat the option as needed",
    )
    .action(async (options) => {
        const env = process.env;
        const dataDir = path.resolve(env.LAUNCHPAD_DATA_DIR ?? ".data/controller");
        const router = routerSessionFromEnv(env);
        const report = await withDatabase((db) =>
            clearDeploymentRecovery(
                db,
                dataDir,
                options.iHaveCheckedTheDokkuHost === true,
                router?.view,
                {
                    routerEpochUnrecorded: options.routerEpochUnrecorded === true,
                    accept: options.accept,
                    evidence: {
                        dokku: () => readDriftDokku(dokkuFromEnv(env)),
                        archives: (snapshot) => readDriftArchives(dataDir, snapshot),
                        probe:
                            env.LAUNCHPAD_APPS_PROXY_URL || router
                                ? (snapshot) => readDriftProbes(env, snapshot, true)
                                : undefined,
                    },
                },
            ),
        );
        console.log(JSON.stringify(report, null, 2));
        console.log("Deployment recovery cleared after verification.");
    });

program
    .command("recovery-republish-alias")
    .description(
        "While recovery is blocked, republish and verify the restored committed route for one alias",
    )
    .requiredOption("--alias <id>", "exact restored alias UUID")
    .option(
        "--router-epoch-unrecorded",
        "confirm a rotation that the restore could not independently anchor",
    )
    .option(
        "--withdraw-unservable-target",
        "audited override: withdraw the alias only if its committed Dokku app is gone and the target is not served",
    )
    .action(async (options) => {
        const env = process.env;
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.alias))
            throw new Error("--alias must be an alias UUID.");
        const router = routerSessionFromEnv(env)?.republish;
        if (!router) throw new Error("Router settings are required.");
        const result = await withDatabase((db) =>
            republishRecoveryAlias(
                db,
                path.resolve(env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                options.alias,
                {
                    ...router,
                    serves: async (hostname, target) =>
                        (await (
                            options.withdrawUnservableTarget === true && target !== null
                                ? readUnservableProbe
                                : readRepublishProbe
                        )(env.LAUNCHPAD_ALIAS_PROBE_URL, hostname)) ===
                        (target?.deploymentId ?? null),
                },
                options.routerEpochUnrecorded === true,
                options.withdrawUnservableTarget === true
                    ? (appName) => dokkuFromEnv(env).apps.exists(appName)
                    : undefined,
            ),
        );
        console.log(
            `Alias ${result.changed ? "republished" : "already verified"}; generation ${result.generation}; ${result.superseded} operation(s) superseded. Recovery remains blocked.`,
        );
    });

program
    .command("recovery-raise-counters")
    .description(
        "After a restore, raise each alias counter to the router's generation for its hostname (never lower). Does not reopen the model",
    )
    .action(async () => {
        const router = routerSessionFromEnv(process.env);
        if (!router) {
            throw new Error(
                "Router settings are required (LAUNCHPAD_ALIAS_CONTROL_URL, LAUNCHPAD_APPS_DOMAIN and the other LAUNCHPAD_ALIAS_* settings).",
            );
        }
        const result = await withDatabase((db) =>
            raiseAliasCounters(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                router.view,
            ),
        );
        console.log(`Raised ${result.raised} alias counter(s).`);
        if (result.unknownRoutes.length) {
            console.log(
                `The router serves ${result.unknownRoutes.length} route(s) Launchpad has no alias for: ${result.unknownRoutes.slice(0, 20).join(", ")}. recovery-clear refuses until each is withdrawn (recovery-withdraw-unknown) or its alias is restored.`,
            );
        }
        if (result.conflicting.length) {
            console.log(
                `The router records ${result.conflicting.length} hostname(s) for a different alias id than the database: ${result.conflicting.slice(0, 20).join(", ")}. recovery-clear refuses until each is resolved (the router would reject that alias's writes); do not withdraw them as unknown.`,
            );
        }
        if (result.unknownWithdrawn.length) {
            console.log(
                `The router also holds ${result.unknownWithdrawn.length} withdrawn route(s) Launchpad does not know; they serve nothing and do not block recovery-clear. Their hostnames stay reserved on the router for the old alias, so do not create an alias with the same hostname.`,
            );
        }
    });

program
    .command("recovery-withdraw-unknown")
    .description(
        "Withdraw one live route the router serves for a hostname Launchpad has no alias for (written at the next generation). Never touches a known alias",
    )
    .requiredOption("--hostname <hostname>", "the exact hostname the router serves")
    .option(
        "--i-have-verified-the-router-by-exact-route",
        "attest: you checked that this route is not one you want to keep",
    )
    .action(async (options) => {
        if (options.iHaveVerifiedTheRouterByExactRoute !== true) {
            throw new Error(
                "Withdrawing a route needs --i-have-verified-the-router-by-exact-route: read the route first.",
            );
        }
        const router = routerSessionFromEnv(process.env);
        if (!router) throw new Error("Router settings are required.");
        const result = await withDatabase((db) =>
            withdrawUnknownRoute(
                db,
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                options.hostname,
                router,
            ),
        );
        console.log(
            `Withdrew ${result.hostname} at generation ${result.generation}. Its hostname stays reserved on the router for the old alias.`,
        );
    });

program
    .command("reconciliation-requests")
    .description(
        "List the latest 100 reconciliation requests for operator review, including historical requests",
    )
    .action(async () => {
        const requests = await withDatabase((db) =>
            db
                .selectFrom("audit_event")
                .select([
                    "occurred_at as requestedAt",
                    "actor",
                    "organization_id as organizationId",
                    "target_type as kind",
                    "target_id as targetId",
                    "detail",
                ])
                .where("action", "=", RECONCILIATION_REQUESTED)
                .orderBy("occurred_at", "desc")
                .orderBy("id", "desc")
                .limit(100)
                .execute(),
        );
        console.log(JSON.stringify(requests, null, 2));
    });

program
    .command("promotion-reconcile")
    .alias("promotion-repair-generation")
    .description(
        "Verify the router's exact route for a held promotion operation (including a generation mismatch) and queue a higher-generation correction",
    )
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
        assertPrivateControlUrl(url, "LAUNCHPAD_ALIAS_CONTROL_URL");
        const authority = {
            instanceId: routing.aliasInstanceId,
            epoch: readRouterCredential(routing.aliasRouterEpochFile, false),
        };
        const client = createRouterControlClient({
            baseUrl: url,
            caFile: routing.aliasControlCaFile,
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
    .command("drift")
    .description(
        "Read-only: compare deployments, aliases, archives, Dokku and the router; never repair",
    )
    .option("--no-dokku", "skip Dokku (reported as skipped)")
    .option("--no-router", "skip the router (reported as skipped)")
    .option(
        "--probe",
        "also check served deployment identities through the configured proxy origins",
    )
    .action(async (options) => {
        const env = process.env;
        try {
            const report = await withDatabase((db) =>
                collectDrift({
                    database: () => readDriftDatabase(db),
                    dokku:
                        options.dokku === false
                            ? undefined
                            : () =>
                                  readDriftDokku(
                                      createDokkuClient({
                                          host: required(env, "DOKKU_SSH_HOST"),
                                          port: sshPort(env.DOKKU_SSH_PORT),
                                          username: env.DOKKU_SSH_USER || "dokku",
                                          privateKeyPath: required(env, "DOKKU_SSH_KEY_PATH"),
                                          knownHostsPath: required(
                                              env,
                                              "DOKKU_SSH_KNOWN_HOSTS_PATH",
                                          ),
                                      }),
                                  ),
                    router:
                        options.router === false
                            ? undefined
                            : async () => {
                                  const session = routerSessionFromEnv(env);
                                  if (!session) throw new Error("Router settings are required.");
                                  return readDriftRouter(session);
                              },
                    archives: (snapshot) =>
                        readDriftArchives(
                            path.resolve(env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
                            snapshot,
                        ),
                    probe: options.probe ? (snapshot) => readDriftProbes(env, snapshot) : undefined,
                    config: {
                        // The control client independently checks the configured epoch on every
                        // page. If it cannot be loaded, the requested router read is unavailable.
                        expectedEpoch: (() => {
                            try {
                                return readRouterCredential(
                                    env.LAUNCHPAD_ALIAS_ROUTER_EPOCH_FILE ?? "",
                                    false,
                                );
                            } catch {
                                return "";
                            }
                        })(),
                        appNamePattern: /^lp-[a-z0-9]{10}$/,
                        now: new Date(),
                    },
                }),
            );
            console.log(JSON.stringify(report, null, 2));
            process.exitCode = driftCommandExitCode(report);
        } catch {
            console.error("Drift check failed; no complete report was produced.");
            process.exitCode = 2;
        }
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

program
    .command("revoke-all-credentials")
    .description(
        "After a restore: end every session, API key, emailed token and open invitation (no password changes)",
    )
    .option(
        "--i-understand-this-signs-everyone-out",
        "confirm: stop the controller and keep ingress closed, because anything issued meanwhile is not revoked",
    )
    .action(async (options) => {
        if (options.iUnderstandThisSignsEveryoneOut !== true) {
            throw new Error(
                "This signs every user out and revokes every API key and open invitation. Stop the controller and keep ingress closed, then pass --i-understand-this-signs-everyone-out.",
            );
        }
        const result = await withDatabase((db) =>
            revokeAllCredentials({ db }, { actor: "operator-cli" }),
        );
        console.log(
            `Revoked ${result.sessions} session(s), ${result.apiKeys} API key(s), ${result.verificationTokens} emailed token(s) and ${result.invitations} open invitation(s). Passwords are unchanged: reset any account that must be locked out.`,
        );
    });

try {
    await program.parseAsync();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
