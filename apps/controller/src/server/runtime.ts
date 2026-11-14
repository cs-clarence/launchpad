import { createAuth, createMailer, loadAuthConfig } from "@launchpad/auth";
import { createDatabase } from "@launchpad/database";
import type { InvitationDeps } from "@launchpad/services";
import path from "node:path";
import { sweepStaleUploads } from "@launchpad/services";
import { createApi } from "./api";
import { artifactLimitsFromEnv } from "./artifact-config";

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
    // Uploaded archives live here: a directory only the controller can write.
    const artifacts = {
        dataDir: path.resolve(process.env.LAUNCHPAD_DATA_DIR ?? ".data/controller"),
        limits: artifactLimitsFromEnv(process.env),
    };
    // A crash mid-upload leaves a staged file behind; clear the old ones at startup.
    void sweepStaleUploads(artifacts.dataDir).catch((error) =>
        console.error("Could not sweep stale uploads", error),
    );
    const features = { emailRecovery: mailer !== null, invitations: invitations.enabled };
    const api = createApi({
        auth,
        db,
        origin: config.origin,
        invitations,
        artifacts,
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
