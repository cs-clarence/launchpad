import { createAuth, createMailer, loadAuthConfig } from "@launchpad-kit/auth";
import { assertSchemaCurrent, createDatabase } from "@launchpad-kit/database";
import {
    parseAliasConfig,
    parseDeploymentConfig,
    DeploymentRecoveryError,
    requireModelDataDirectory,
    sweepStaleUploads,
    type InvitationDeps,
} from "@launchpad-kit/services";
import path from "node:path";
import { createApi } from "./api";
import { artifactLimitsFromEnv } from "./artifact-config";
import { createSchemaGate, GateRejectedError, type SchemaGate } from "./schema-gate";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

// Composed on first use so importing the module (build, tests, route
// generation) never reads configuration or opens a connection.
function compose() {
    const config = loadAuthConfig(process.env);
    const db = createDatabase(requireEnv("DATABASE_URL"));
    const mailer = createMailer(config);
    const auth = createAuth({ db, config, mailer });
    // Email settings never enable invitations on their own: enrollment must also
    // be "invitation".
    const invitations: InvitationDeps = {
        enabled: config.enrollment === "invitation" && mailer !== null,
        mailer,
        baseUrl: config.baseUrl,
        publicSignup: config.publicSignup,
        hashPassword: async (password) => (await auth.$context).password.hash(password),
    };
    // Uploaded archives live in the shared data directory, which must already exist: the
    // controller never creates a missing mount (see requireModelDataDirectory).
    const dataDir = path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller");
    const artifacts = { dataDir, limits: artifactLimitsFromEnv(process.env) };
    // `LAUNCHPAD_DEPLOYMENTS` is off unless set; invalid settings stop the process at startup
    // (see startup-settings.ts), so a parse failure here only repeats that for a bare import.
    const deployments = { dataDir, settings: parseDeploymentConfig(process.env) };
    const aliases = parseAliasConfig(process.env);
    // A crash mid-upload leaves a staged file behind; clear the old ones at startup.
    void sweepStaleUploads(dataDir).catch((error) =>
        console.error("Could not sweep stale uploads", error),
    );
    const features = { emailRecovery: mailer !== null, invitations: invitations.enabled };
    const api = createApi({
        auth,
        db,
        origin: config.origin,
        invitations,
        artifacts,
        deployments,
        aliases,
        // Serves the OpenAPI document and Scalar reference; set to "false" to remove them.
        docs: process.env.LAUNCHPAD_API_DOCS !== "false",
        readiness: () => getSchemaGate().check({ includeDataDirectory: true }),
        onSchemaError: () => getSchemaGate().invalidate(),
    });
    return { config, db, auth, api, invitations, features, artifacts, deployments, aliases };
}

let runtime: ReturnType<typeof compose> | undefined;

export function getRuntime() {
    runtime ??= compose();
    return runtime;
}

const RECHECK_AFTER_MS = 3000;
const CHECK_TIMEOUT_MS = 4000;

function dataDirectory() {
    return path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller");
}

// The one check behind every request, readiness and the dashboard. For now a pass is final and
// a failure is repeated at most every few seconds, shared by concurrent callers, so a database
// that was briefly unreachable, or one the operator has since migrated, recovers without a restart.
let gate: SchemaGate | undefined;
export function getSchemaGate(): SchemaGate {
    gate ??= createSchemaGate({
        checkSchema: () => assertSchemaCurrent(getRuntime().db),
        checkDataDirectory: async () => {
            await requireModelDataDirectory(dataDirectory());
        },
        isDataDirectoryProblem: (error) =>
            error instanceof DeploymentRecoveryError ||
            typeof (error as NodeJS.ErrnoException)?.code === "string",
        intervalMs: null,
        retryMs: RECHECK_AFTER_MS,
        timeoutMs: CHECK_TIMEOUT_MS,
        onFailure: (failure) =>
            console.error(failure.error instanceof Error ? failure.error.message : failure.error),
    });
    return gate;
}

// The runtime once the schema is known to match. Rejects with GateRejectedError carrying the
// outcome, which `databaseProblem` maps to a response.
export async function getReadyRuntime() {
    const ready = getRuntime();
    const outcome = await getSchemaGate().check();
    if (outcome.kind !== "ok") {
        throw new GateRejectedError(outcome);
    }
    return ready;
}
