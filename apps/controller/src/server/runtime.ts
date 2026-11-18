import { createAuth, createMailer, loadAuthConfig } from "@launchpad/auth";
import { assertSchemaCurrent, createDatabase } from "@launchpad/database";
import type { InvitationDeps } from "@launchpad/services";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
    deploymentsEnabled,
    lifecycleConfigFromEnv,
    PREVIEW_DOMAIN_PATTERN,
    sweepStaleUploads,
} from "@launchpad/services";
import { getDomain } from "tldts";
import { createApi } from "./api";
import { artifactLimitsFromEnv } from "./artifact-config";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required`);
    }
    return value;
}

// Previews are off unless LAUNCHPAD_DEPLOYMENTS=on, and then they need a domain of their
// own: sibling hosts of the controller share its site, so previews live on a separate
// registrable domain (see the organization-roles decision). The check here refuses the
// obvious overlaps; it cannot know the public suffix list.
export function previewSettings(env: Record<string, string | undefined>, origin: string) {
    const enabled = deploymentsEnabled(env.LAUNCHPAD_DEPLOYMENTS);
    const previewDomain = (env.LAUNCHPAD_PREVIEW_DOMAIN ?? "").toLowerCase();
    if (!enabled) {
        return {
            enabled,
            previewDomain: previewDomain || "previews.example.com",
            lifecycle: lifecycleConfigFromEnv(env),
        };
    }
    if (!previewDomain) {
        throw new Error("LAUNCHPAD_PREVIEW_DOMAIN is required when deployments are on.");
    }
    if (!PREVIEW_DOMAIN_PATTERN.test(previewDomain)) {
        throw new Error("LAUNCHPAD_PREVIEW_DOMAIN must be a plain lowercase domain name.");
    }
    const host = new URL(origin).hostname.toLowerCase();
    // Preview pages are deployer-controlled, and hosts of one registrable domain share a
    // site: cookies and same-site requests cross between them. So the preview domain must
    // be a different registrable domain from the controller's (by the public suffix list,
    // so `co.uk`-style suffixes are handled), not merely a different name.
    const registrable = (name: string) => getDomain(name, { allowPrivateDomains: true });
    const hostSite = registrable(host);
    const sameSite = hostSite !== null && hostSite === registrable(previewDomain);
    // A host with no registrable domain (localhost, an address) falls back to plain overlap.
    const overlaps =
        sameSite ||
        host === previewDomain ||
        host.endsWith(`.${previewDomain}`) ||
        previewDomain.endsWith(`.${host}`);
    if (overlaps) {
        throw new Error(
            "LAUNCHPAD_PREVIEW_DOMAIN must be a different registrable domain from the controller's own.",
        );
    }
    const raw = env.LAUNCHPAD_MAX_PREVIEWS;
    const maxPreviews = raw ? Number(raw) : undefined;
    if (maxPreviews !== undefined && (!Number.isSafeInteger(maxPreviews) || maxPreviews < 1)) {
        throw new Error("LAUNCHPAD_MAX_PREVIEWS must be a positive integer.");
    }
    return { enabled, previewDomain, maxPreviews, lifecycle: lifecycleConfigFromEnv(env) };
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
    // Where deployments are on the directory must exist and be the controller's own: made
    // here (not on the first upload) so the operator's status can tell "not yet" from "gone".
    if (deploymentsEnabled(process.env.LAUNCHPAD_DEPLOYMENTS)) {
        try {
            mkdirSync(artifacts.dataDir, { recursive: true, mode: 0o700 });
        } catch (error) {
            // Not fatal: the operator's status reports the directory, and uploads fail clearly.
            console.error("Could not create the data directory", error);
        }
    }
    // A crash mid-upload leaves a staged file behind; clear the old ones at startup.
    void sweepStaleUploads(artifacts.dataDir).catch((error) =>
        console.error("Could not sweep stale uploads", error),
    );
    const previews = previewSettings(process.env, config.origin);
    const features = { emailRecovery: mailer !== null, invitations: invitations.enabled };
    const api = createApi({
        auth,
        db,
        origin: config.origin,
        invitations,
        artifacts,
        previews,
        // Serves the OpenAPI document and Scalar reference; set to "false" to remove them.
        docs: process.env.LAUNCHPAD_API_DOCS !== "false",
    });
    return { config, db, auth, api, invitations, features, previews, artifacts };
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
        const check = assertSchemaCurrent(ready.db);
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
