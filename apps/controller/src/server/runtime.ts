import { createAuth, createMailer, loadAuthConfig } from "@launchpad/auth";
import { createDatabase } from "@launchpad/database";
import type { InvitationDeps } from "@launchpad/services";
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
