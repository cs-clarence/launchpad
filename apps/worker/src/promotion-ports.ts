import { createRouterControlClient } from "@launchpad-kit/alias-router/control-client";
import {
    assertPrivateControlUrl,
    readRouterCredential,
    type AppRoutingConfig,
} from "@launchpad-kit/services";
import type { PromotionReadback } from "@launchpad-kit/services";
import type { PromotionRunnerPorts } from "./promotion-runner";
import { compactId } from "./template";
import { fetchIdentity, parseProxyUrl, type ProbeConfig } from "./verify";

export interface PromotionPortsDeps {
    // Request deadline for the router control client; its default is used when omitted.
    controlTimeoutMs?: number;
    settings: Pick<
        AppRoutingConfig,
        | "aliasControlUrl"
        | "aliasProbeUrl"
        | "aliasInstanceId"
        | "aliasControlTokenFile"
        | "aliasRouterEpochFile"
    >;
}

export function createPromotionPorts({
    settings,
    controlTimeoutMs,
}: PromotionPortsDeps): PromotionRunnerPorts {
    const base = assertPrivateControlUrl(settings.aliasControlUrl, "LAUNCHPAD_ALIAS_CONTROL_URL");
    const probe: ProbeConfig = {
        proxyUrl: parseProxyUrl(settings.aliasProbeUrl.href, "LAUNCHPAD_ALIAS_PROBE_URL"),
        timeoutMs: 0,
        intervalMs: 0,
    };
    return {
        open() {
            const authority = {
                instanceId: settings.aliasInstanceId,
                epoch: readRouterCredential(settings.aliasRouterEpochFile, false),
            };
            const client = createRouterControlClient({
                baseUrl: base,
                ...(controlTimeoutMs === undefined ? {} : { timeoutMs: controlTimeoutMs }),
                credentials: {
                    ...authority,
                    token: readRouterCredential(settings.aliasControlTokenFile, true),
                },
            });
            return {
                authority,
                register: (target, signal) => client.registerDeployment(target, signal),
                replaceRoute: (write, signal) => client.replaceRoute(write, signal),
                observe: async (hostname, signal): Promise<PromotionReadback> =>
                    client.readRoute(hostname, signal),
            };
        },
        async serves(hostname, target, signal) {
            const served = await fetchIdentity(probe, hostname, signal);
            if (!served) return false;
            return target
                ? served.status === 200 && served.deployment === compactId(target.deploymentId)
                : served.status === 404 && served.deployment === null;
        },
    };
}
