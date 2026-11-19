import { createAuth, createMailer, loadAuthConfig } from "@launchpad-kit/auth";
import { assertSchemaCurrent, createDatabase } from "@launchpad-kit/database";
import { requireModelDataDirectory, type InvitationDeps } from "@launchpad-kit/services";
import path from "node:path";
import { createApi } from "./api";

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
    const features = { emailRecovery: mailer !== null, invitations: invitations.enabled };
    const api = createApi({
        auth,
        db,
        origin: config.origin,
        invitations,
        // Serves the OpenAPI document and Scalar reference; set to "false" to remove them.
        docs: process.env.LAUNCHPAD_API_DOCS !== "false",
    });
    return { config, db, auth, api, invitations, features };
}

let runtime: ReturnType<typeof compose> | undefined;

export function getRuntime() {
    runtime ??= compose();
    return runtime;
}

// A schema check that passed is final. One that failed is repeated, at most every few seconds
// and shared by concurrent requests, so a database that was briefly unreachable, or one the
// operator has since migrated, recovers without a restart.
const RECHECK_AFTER_MS = 3000;
let schemaCheck: Promise<void> | undefined;
let schemaFailedAt = 0;

// The runtime once the schema is known to match. Rejects with SchemaMismatchError when it
// does not; any other rejection is a failure to check (and surfaces as an error).
export async function getReadyRuntime() {
    const ready = getRuntime();
    if (!schemaCheck || (schemaFailedAt > 0 && Date.now() - schemaFailedAt > RECHECK_AFTER_MS)) {
        const check = assertSchemaCurrent(ready.db).then(async () => {
            await requireModelDataDirectory(
                path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
            );
        });
        schemaCheck = check;
        schemaFailedAt = 0;
        check.catch((error) => {
            schemaFailedAt = Date.now();
            console.error(error instanceof Error ? error.message : error);
        });
    }
    await schemaCheck;
    return ready;
}
