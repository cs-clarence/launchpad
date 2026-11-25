import { ClientCoreError, type Context, normalizeEmail } from "@launchpad-kit/client-core";
import { normalizeBaseUrl } from "@launchpad-kit/sdk";

const bad = (message: string) => new ClientCoreError("bad-input", message);

// `--session` is for a person's own account. A key in the environment means this is a key
// context (CI, MCP), so it is refused before anything is asked or sent.
export function refuseWithKey(ctx: Context, flag: string): void {
    if (ctx.env.LAUNCHPAD_API_KEY !== undefined) {
        throw bad(
            `${flag} cannot be used while LAUNCHPAD_API_KEY is set. Unset it to use your own account.`,
        );
    }
}

export function checkEmail(input: string): string {
    const email = normalizeEmail(input);
    if (email.length > 254 || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(email)) {
        throw bad("--email must be an email address.");
    }
    return email;
}

export interface SessionTarget {
    // The normalized controller URL; the key of a kept session.
    controller: string;
    // From the selected profile (only if it is for this controller) or LAUNCHPAD_ORG; never a key.
    organizationId: string | null;
}

// The controller comes from `--controller`, else the selected profile (its controller and
// organization only: its key is neither used nor sent), else LAUNCHPAD_CONTROLLER, else the
// current profile. Anything that is not https (or loopback http) is refused here.
export async function resolveSessionTarget(
    ctx: Context,
    input: { controller?: string; profile?: string },
): Promise<SessionTarget> {
    const organization = ctx.env.LAUNCHPAD_ORG || null;
    const fromProfile = async (name: string | undefined) => {
        const config = await ctx.store.load();
        const chosen = name ?? ctx.env.LAUNCHPAD_PROFILE ?? config.currentProfile;
        const profile =
            chosen && Object.hasOwn(config.profiles, chosen) ? config.profiles[chosen] : undefined;
        if (!chosen || !profile) {
            throw new ClientCoreError(
                "not-logged-in",
                chosen
                    ? `No profile named "${chosen}". Run: launchpad login`
                    : "No controller: use --controller, --profile or LAUNCHPAD_CONTROLLER.",
            );
        }
        return { controller: profile.controller, organizationId: profile.organizationId };
    };
    if (input.controller !== undefined) {
        const controller = normalizeBaseUrl(input.controller);
        let profileOrganization: string | null = null;
        if (input.profile) {
            const profile = await fromProfile(input.profile);
            if (normalizeBaseUrl(profile.controller) === controller) {
                profileOrganization = profile.organizationId;
            }
        }
        return { controller, organizationId: organization ?? profileOrganization };
    }
    if (input.profile === undefined && ctx.env.LAUNCHPAD_CONTROLLER) {
        return {
            controller: normalizeBaseUrl(ctx.env.LAUNCHPAD_CONTROLLER),
            organizationId: organization,
        };
    }
    const profile = await fromProfile(input.profile);
    return {
        controller: normalizeBaseUrl(profile.controller),
        organizationId: organization ?? profile.organizationId,
    };
}
