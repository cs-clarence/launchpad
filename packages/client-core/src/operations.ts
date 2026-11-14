import { createClient, type LaunchpadClient, normalizeBaseUrl } from "@launchpad/sdk";
import { ClientCoreError } from "./errors";
import { configDirectory, CredentialStore } from "./store";

export interface Context {
    store: CredentialStore;
    env: Record<string, string | undefined>;
    fetch?: typeof fetch;
}

export function createContext(
    env: Record<string, string | undefined> = process.env,
    options: { fetch?: typeof fetch } = {},
): Context {
    return { store: new CredentialStore(configDirectory(env)), env, ...options };
}

export interface Resolved {
    profile: string | null; // null when credentials came from the environment
    controller: string;
    apiKey: string;
    organizationId: string | null;
    fromEnvironment: boolean;
}

// Precedence: explicit profile name, then the environment, then the current profile.
// LAUNCHPAD_CONTROLLER and LAUNCHPAD_API_KEY together bypass the store entirely (CI).
export async function resolve(ctx: Context, profileName?: string): Promise<Resolved> {
    const { LAUNCHPAD_CONTROLLER: controller, LAUNCHPAD_API_KEY: apiKey } = ctx.env;
    if (!profileName && controller && apiKey) {
        return {
            profile: null,
            controller,
            apiKey,
            organizationId: ctx.env.LAUNCHPAD_ORG ?? null,
            fromEnvironment: true,
        };
    }
    const config = await ctx.store.load();
    const name = profileName ?? ctx.env.LAUNCHPAD_PROFILE ?? config.currentProfile;
    const profile =
        name && Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
    if (!name || !profile) {
        throw new ClientCoreError(
            "not-logged-in",
            name
                ? `No profile named "${name}". Run: launchpad login`
                : "Not logged in. Run: launchpad login",
        );
    }
    return {
        profile: name,
        controller: profile.controller,
        apiKey: profile.apiKey,
        organizationId: ctx.env.LAUNCHPAD_ORG ?? profile.organizationId,
        fromEnvironment: false,
    };
}

function clientFor(ctx: Context, resolved: Resolved): LaunchpadClient {
    return createClient({
        baseUrl: resolved.controller,
        apiKey: resolved.apiKey,
        fetch: ctx.fetch,
    });
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

// Verifies the key against the controller, then saves it. A key belongs to one
// organization, so that organization is selected by login.
export async function login(
    ctx: Context,
    input: { controller: string; apiKey: string; profile?: string },
) {
    const profile = input.profile ?? "default";
    if (!PROFILE_NAME.test(profile)) {
        throw new ClientCoreError(
            "bad-input",
            "A profile name is letters, digits, _ . - (40 at most).",
        );
    }
    const controller = normalizeBaseUrl(input.controller);
    const client = createClient({ baseUrl: controller, apiKey: input.apiKey, fetch: ctx.fetch });
    const key = await client.key.get(); // throws for an invalid, revoked or expired key
    await ctx.store.update((config) => {
        config.profiles[profile] = {
            controller,
            apiKey: input.apiKey,
            organizationId: key.organizationId,
            savedAt: new Date().toISOString(),
        };
        config.currentProfile ??= profile;
    });
    return { profile, controller, key };
}

export async function logout(ctx: Context, profileName?: string) {
    const config = await ctx.store.load();
    const name = profileName ?? ctx.env.LAUNCHPAD_PROFILE ?? config.currentProfile;
    if (!name || !Object.hasOwn(config.profiles, name)) {
        throw new ClientCoreError("not-logged-in", "Nothing to log out of.");
    }
    await ctx.store.update((current) => {
        delete current.profiles[name];
        if (current.currentProfile === name) {
            current.currentProfile = Object.keys(current.profiles)[0] ?? null;
        }
    });
    return { profile: name };
}

export async function listProfiles(ctx: Context) {
    const config = await ctx.store.load();
    return {
        current: config.currentProfile,
        profiles: Object.entries(config.profiles).map(([name, p]) => ({
            name,
            controller: p.controller,
            organizationId: p.organizationId,
            savedAt: p.savedAt,
        })),
    };
}

export async function useProfile(ctx: Context, name: string) {
    await ctx.store.update((config) => {
        if (!Object.hasOwn(config.profiles, name)) {
            throw new ClientCoreError("not-logged-in", `No profile named "${name}".`);
        }
        config.currentProfile = name;
    });
    return { profile: name };
}

export async function whoami(ctx: Context, profileName?: string) {
    const resolved = await resolve(ctx, profileName);
    const key = await clientFor(ctx, resolved).key.get();
    return { profile: resolved.profile, controller: resolved.controller, key };
}

// Selects the organization by id or slug. A key sees only its own, so this validates
// the choice rather than widening it.
export async function useOrganization(ctx: Context, organization: string, profileName?: string) {
    const resolved = await resolve(ctx, profileName);
    const all = await clientFor(ctx, resolved).organizations.list();
    const match = all.find((o) => o.id === organization || o.slug === organization);
    if (!match) {
        throw new ClientCoreError(
            "no-organization",
            `This key cannot see an organization "${organization}".`,
        );
    }
    if (resolved.profile) {
        await ctx.store.update((config) => {
            const name = resolved.profile!;
            const profile = Object.hasOwn(config.profiles, name)
                ? config.profiles[name]
                : undefined;
            // The profile may have been replaced (another login) while the controller was
            // asked; a choice made for the old credentials must not land on the new ones.
            if (
                !profile ||
                profile.controller !== resolved.controller ||
                profile.apiKey !== resolved.apiKey
            ) {
                throw new ClientCoreError(
                    "bad-input",
                    "The profile changed while the organization was being selected. Try again.",
                );
            }
            profile.organizationId = match.id;
        });
    }
    return { organization: match };
}

export async function listOrganizations(ctx: Context, profileName?: string) {
    const resolved = await resolve(ctx, profileName);
    return clientFor(ctx, resolved).organizations.list();
}

export async function listProjects(ctx: Context, profileName?: string) {
    const resolved = await resolve(ctx, profileName);
    if (!resolved.organizationId) {
        throw new ClientCoreError(
            "no-organization",
            "No organization selected. Run: launchpad org use <slug>",
        );
    }
    return clientFor(ctx, resolved).projects.list(resolved.organizationId);
}
