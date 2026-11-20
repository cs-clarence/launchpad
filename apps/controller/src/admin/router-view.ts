import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import {
    assertPrivateControlUrl,
    parseAppRoutingConfig,
    readRouterCredential,
    type RecoveryMarker,
    type RecoveryRepublishRouter,
    type RouterAnchor,
    type RouterView,
} from "@launchpad-kit/services";

// The router, as the operator commands reach it. Router settings belong to the worker's
// environment, so an installation that has never used aliases has none: that is "no router", not
// an error, and the service then refuses a recovery only if the database holds aliases. As soon as
// the control URL is set, every router setting must be valid. Epoch and token are read from their
// files at the moment of use, so a rotation is picked up. This host's admin user must own its own
// copy of the token file (it is refused if another user owns it).
export interface RouterSession {
    view: RouterView;
    // The router's active epoch (not a secret).
    epoch(): Promise<string>;
    withdraw(route: { aliasId: string; hostname: string; generation: string }): Promise<void>;
    republish?: Omit<RecoveryRepublishRouter, "serves">;
}

export function routerSessionFromEnv(
    env: Record<string, string | undefined>,
): RouterSession | undefined {
    if (!env.LAUNCHPAD_ALIAS_CONTROL_URL) return undefined;
    const routing = parseAppRoutingConfig(env);
    if (!routing.enabled) {
        throw new Error(
            "LAUNCHPAD_ALIAS_CONTROL_URL is set, so LAUNCHPAD_APPS_DOMAIN and every LAUNCHPAD_ALIAS_* setting are required.",
        );
    }
    assertPrivateControlUrl(routing.aliasControlUrl, "LAUNCHPAD_ALIAS_CONTROL_URL");
    const client = () =>
        createRouterControlClient({
            baseUrl: routing.aliasControlUrl,
            credentials: {
                instanceId: routing.aliasInstanceId,
                epoch: readRouterCredential(routing.aliasRouterEpochFile, false),
                token: readRouterCredential(routing.aliasControlTokenFile, true),
            },
        });
    return {
        view: async () => client().listRoutes(AbortSignal.timeout(120_000)),
        epoch: async () => client().readEpoch(AbortSignal.timeout(15_000)),
        republish: {
            observe: async (hostname) => client().readRoute(hostname, AbortSignal.timeout(15_000)),
            register: async (target) =>
                client().registerDeployment(target, AbortSignal.timeout(15_000)),
            replace: async (write) => client().replaceRoute(write, AbortSignal.timeout(15_000)),
        },
        async withdraw(route) {
            await client().replaceRoute(
                {
                    hostname: route.hostname,
                    aliasId: route.aliasId,
                    operationId: crypto.randomUUID(),
                    generation: route.generation,
                    targetDeploymentId: null,
                },
                AbortSignal.timeout(30_000),
            );
        },
    };
}

// What the recovery marker should record at the start of a restore. A router that is not configured
// or cannot be read must not stop an emergency restore. If it cannot be read, the anchor is the epoch
// in the configured epoch file (the epoch the workers were using), so rotation can still be verified;
// only with neither is there no anchor, and recovery-clear then needs --router-epoch-unrecorded.
export async function routerAnchorFromEnv(
    env: Record<string, string | undefined>,
): Promise<RouterAnchor> {
    let session: RouterSession | undefined;
    try {
        session = routerSessionFromEnv(env);
    } catch {
        // Incomplete or unsafe router settings must not stop an emergency restore either.
        return { routerEpoch: null, note: "unreachable" };
    }
    if (!session) return { routerEpoch: null, note: "not-configured" };
    try {
        return { routerEpoch: await session.epoch(), note: "recorded" };
    } catch {
        try {
            const routing = parseAppRoutingConfig(env);
            if (routing.enabled) {
                const epoch = readRouterCredential(routing.aliasRouterEpochFile, false);
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(epoch)) {
                    return { routerEpoch: epoch, note: "from-epoch-file" };
                }
            }
        } catch {
            // No readable epoch file either: no anchor.
        }
        return { routerEpoch: null, note: "unreachable" };
    }
}

// What to tell the operator after a restore, from the marker that is actually on disk: a retry keeps
// the first anchor, so this must not follow whatever the retry happened to read.
export function recoveryAnchorNotice(marker: RecoveryMarker | "damaged" | null): string | null {
    if (marker === "damaged") {
        return "The recovery marker is damaged; repeat the documented restore with all writers stopped.";
    }
    if (!marker) return null;
    if (marker.routerEpoch === null) {
        const why =
            marker.routerEpochNote === "unreachable"
                ? "the router could not be read"
                : marker.routerEpochNote === "not-configured"
                  ? "no router is configured"
                  : "it is not known whether a router was in use";
        return `No router epoch was recorded (${why}); recovery-clear will need --router-epoch-unrecorded.`;
    }
    if (marker.routerEpochNote === "from-epoch-file") {
        return "The router could not be read, so the anchor is the epoch in the configured epoch file; recovery-clear will need --router-epoch-unrecorded to confirm the rotation.";
    }
    return null;
}
