import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import {
    assertPrivateControlUrl,
    parseAppRoutingConfig,
    readRouterCredential,
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
    withdraw(route: { aliasId: string; hostname: string; generation: string }): Promise<void>;
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
