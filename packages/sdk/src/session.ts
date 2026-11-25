import {
    addedMemberSchema,
    type ApiKeyScopeName,
    apiKeySummarySchema,
    createdApiKeySchema,
    createdInvitationSchema,
    createdOrganizationSchema,
    invitationSchema,
    memberSchema,
    okSchema,
    type OrganizationRoleName,
} from "@launchpad-kit/contracts";
import { z } from "zod";
import { LaunchpadApiError, LaunchpadConfigError, LaunchpadTransportError } from "./errors";
import { loose } from "./loose";
import {
    createTransport,
    normalizeBaseUrl,
    type RawOptions,
    type RawResponse,
    rawRequest,
    scrub,
} from "./transport";

// The request bodies the controller validates (its schemas live in the services package, which
// this one does not depend on), typed by hand. The controller is the validator.
export interface CreateOrganizationInput {
    name: string;
    slug: string;
    ownerEmail: string;
}
export interface AddMemberInput {
    email: string;
    role: OrganizationRoleName;
}
export interface CreateInvitationInput {
    email: string;
    role: OrganizationRoleName;
}
export interface IssueApiKeyInput {
    name: string;
    scopes: ApiKeyScopeName[];
    projectIds?: string[];
    expiresInDays: number;
}

export interface SessionCallOptions {
    signal?: AbortSignal;
}
export interface IssueApiKeyOptions extends SessionCallOptions {
    // Receives the `secret` string of a successful answer before the answer is parsed, and is
    // awaited, so the caller can put it somewhere safe even if the rest of the body is unusable.
    onSecret?: (secret: string) => void | Promise<void>;
}

export interface SessionClientOptions {
    // The controller's origin, with the same rules as the key client (https, or loopback http).
    baseUrl: string;
    // A session cookie `name=value` saved earlier by a sign-in.
    cookie?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

const COOKIE_NAME = "better-auth.session_token";
// RFC 6265 cookie-octets: no controls, spaces, quotes, commas, semicolons or backslashes.
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{1,4096}$/;
const SET_COOKIE = new Set(["set-cookie", "set-cookie2"]);
const ORIGIN_HINT =
    "The controller accepts only the exact origin set as its LAUNCHPAD_BASE_URL; an http/https " +
    "or proxy-host mismatch looks like this.";

// The cookie's name on this controller: `__Secure-` prefixed over https.
const cookieName = (base: string) =>
    new URL(base).protocol === "https:" ? `__Secure-${COOKIE_NAME}` : COOKIE_NAME;

function checkCookie(base: string, cookie: string): string {
    const at = cookie.indexOf("=");
    const name = at === -1 ? "" : cookie.slice(0, at);
    if (name !== cookieName(base) || !COOKIE_VALUE.test(cookie.slice(at + 1))) {
        // Never echoed: it is a credential.
        throw new LaunchpadConfigError("The session cookie is not in the expected format.");
    }
    return cookie;
}

// An email and password sign-in to the controller (Better Auth), and `/api/v1` calls made with
// the resulting session cookie. Unlike the key client it sends `Cookie` and `Origin` and never
// `Authorization`. It shares the key client's timeout, bounded reads, redirect refusal and error
// mapping, and never lets the cookie or the password leave it in an error, a header or a body.
export function createSessionClient(options: SessionClientOptions) {
    const base = normalizeBaseUrl(options.baseUrl);
    const origin = new URL(base).origin;
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = options.timeoutMs ?? 30_000;
    let cookie: string | null =
        options.cookie === undefined ? null : checkCookie(base, options.cookie);
    let password: string | null = null;
    let signingIn = false;

    const secrets = () => {
        const list: string[] = [];
        if (cookie) list.push(cookie, cookie.slice(cookie.indexOf("=") + 1));
        if (password) list.push(password);
        return list;
    };
    const config = (prefix: string, withCookie: boolean) => ({
        base,
        doFetch,
        timeoutMs,
        prefix,
        credentialHeaders: () => ({ origin, ...(withCookie && cookie ? { cookie } : {}) }),
        secrets,
        session: {
            hint: (status: number, code: string) =>
                status === 403 && (code === "forbidden-origin" || code === "INVALID_ORIGIN")
                    ? ORIGIN_HINT
                    : undefined,
        },
    });
    // The sign-in carries no cookie; every later call carries it.
    const signInTransport = createTransport(config("/api/auth", false));
    const authTransport = createTransport(config("/api/auth", true));
    const apiTransport = createTransport(config("/api/v1", true));

    // One `/api/v1` call with the session: path segments are encoded, the answer is parsed with
    // the contracts' response schema, and anything else is the SDK's "unexpected answer".
    async function call<T>(
        method: string,
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
        extra: SessionCallOptions & { onText?: (text: string) => Promise<void> } = {},
    ): Promise<T> {
        if (!cookie) throw new LaunchpadConfigError("This client has no session.");
        const { text: raw } = await apiTransport.exchange(method, path, body, {
            signal: extra.signal,
        });
        const text = scrub(raw, secrets());
        await extra.onText?.(raw);
        let json: unknown;
        try {
            json = text.length > 0 ? JSON.parse(text) : undefined;
        } catch {
            json = undefined;
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
            throw new LaunchpadTransportError(
                "invalid-response",
                "The controller's answer is not what this version of the SDK expects.",
            );
        }
        return parsed.data;
    }
    const seg = (id: string) => {
        if (
            typeof id !== "string" ||
            id.length === 0 ||
            id.length > 256 ||
            id === "." ||
            id === ".." ||
            /[\u0000-\u001f\u007f]/.test(id)
        ) {
            throw new LaunchpadConfigError("A resource ID is required.");
        }
        return encodeURIComponent(id);
    };
    const org = (id: string) => `/organizations/${seg(id)}`;

    return {
        origin,
        // The cookie of the current session, for the caller to keep. Null before a sign-in.
        cookie: () => cookie,

        async signIn(email: string, secret: string, extra: { signal?: AbortSignal } = {}) {
            if (cookie) throw new LaunchpadConfigError("This client already has a session.");
            if (signingIn) throw new LaunchpadConfigError("A sign-in is already in progress.");
            if (!email || !secret) {
                throw new LaunchpadConfigError("An email and a password are required.");
            }
            signingIn = true;
            password = secret;
            const name = cookieName(base);
            // Taken as soon as the headers arrive: if the body then stalls or fails, the session
            // already exists on the controller and the caller must still be able to sign it out.
            const capture = (response: Response) => {
                if (response.status !== 200) return;
                for (const line of response.headers.getSetCookie()) {
                    const pair = line.split(";")[0]!.trim();
                    const at = pair.indexOf("=");
                    if (at === -1 || pair.slice(0, at) !== name) continue;
                    if (!COOKIE_VALUE.test(pair.slice(at + 1))) continue;
                    cookie = pair;
                    return;
                }
            };
            try {
                const { response } = await signInTransport.exchange(
                    "POST",
                    "/sign-in/email",
                    { email, password: secret },
                    { signal: extra.signal, onHeaders: capture },
                );
                if (cookie) return { cookie };
                throw new LaunchpadApiError({
                    status: response.status,
                    code: "no-session",
                    title: "The controller accepted the sign-in but sent no session cookie.",
                });
            } catch (error) {
                // The server's wording is not used for a rejected sign-in: say it plainly.
                if (error instanceof LaunchpadApiError && error.status === 401) {
                    throw new LaunchpadApiError({
                        status: 401,
                        code: "invalid-credentials",
                        title: "Wrong email or password.",
                    });
                }
                throw error;
            } finally {
                password = null;
                signingIn = false;
            }
        },

        // Revokes the session on the controller. The cookie is kept until the call returns so a
        // failure can be reported without it.
        async signOut(extra: { signal?: AbortSignal } = {}) {
            if (!cookie) throw new LaunchpadConfigError("This client has no session.");
            await authTransport.exchange("POST", "/sign-out", {}, { signal: extra.signal });
        },

        async raw(method: string, path: string, rawOptions: RawOptions = {}): Promise<RawResponse> {
            if (!cookie) throw new LaunchpadConfigError("This client has no session.");
            const result = await rawRequest(apiTransport, base, method, path, rawOptions);
            const headers = new Headers();
            for (const [name, value] of result.headers) {
                if (!SET_COOKIE.has(name.toLowerCase()))
                    headers.append(name, scrub(value, secrets()));
            }
            return { ...result, headers, body: scrub(result.body, secrets()) };
        },

        // Session-only actions. Each is one call; none looks anything up.
        organizations: {
            create: async (input: CreateOrganizationInput, extra?: SessionCallOptions) =>
                call("POST", "/organizations", loose(createdOrganizationSchema), input, extra),
        },
        members: {
            list: async (organizationId: string, extra?: SessionCallOptions) =>
                call(
                    "GET",
                    `${org(organizationId)}/members`,
                    z.array(loose(memberSchema)),
                    undefined,
                    extra,
                ),
            add: async (
                organizationId: string,
                input: AddMemberInput,
                extra?: SessionCallOptions,
            ) =>
                call(
                    "POST",
                    `${org(organizationId)}/members`,
                    loose(addedMemberSchema),
                    input,
                    extra,
                ),
            remove: async (organizationId: string, userId: string, extra?: SessionCallOptions) =>
                call(
                    "DELETE",
                    `${org(organizationId)}/members/${seg(userId)}`,
                    loose(okSchema),
                    undefined,
                    extra,
                ),
        },
        invitations: {
            create: async (
                organizationId: string,
                input: CreateInvitationInput,
                extra?: SessionCallOptions,
            ) =>
                call(
                    "POST",
                    `${org(organizationId)}/invitations`,
                    loose(createdInvitationSchema),
                    input,
                    extra,
                ),
            list: async (organizationId: string, extra?: SessionCallOptions) =>
                call(
                    "GET",
                    `${org(organizationId)}/invitations`,
                    z.array(loose(invitationSchema)),
                    undefined,
                    extra,
                ),
            revoke: async (
                organizationId: string,
                invitationId: string,
                extra?: SessionCallOptions,
            ) =>
                call(
                    "DELETE",
                    `${org(organizationId)}/invitations/${seg(invitationId)}`,
                    loose(okSchema),
                    undefined,
                    extra,
                ),
        },
        apiKeys: {
            list: async (organizationId: string, extra?: SessionCallOptions) =>
                call(
                    "GET",
                    `${org(organizationId)}/api-keys`,
                    z.array(loose(apiKeySummarySchema)),
                    undefined,
                    extra,
                ),
            issue: async (
                organizationId: string,
                input: IssueApiKeyInput,
                extra: IssueApiKeyOptions = {},
            ) =>
                call("POST", `${org(organizationId)}/api-keys`, loose(createdApiKeySchema), input, {
                    signal: extra.signal,
                    onText: async (text) => {
                        let secret: unknown;
                        try {
                            secret = (JSON.parse(text) as { secret?: unknown } | null)?.secret;
                        } catch {
                            return;
                        }
                        if (typeof secret === "string" && secret.length > 0) {
                            await extra.onSecret?.(secret);
                        }
                    },
                }),
            revoke: async (organizationId: string, keyId: string, extra?: SessionCallOptions) =>
                call(
                    "DELETE",
                    `${org(organizationId)}/api-keys/${seg(keyId)}`,
                    loose(okSchema),
                    undefined,
                    extra,
                ),
        },
    };
}

export type LaunchpadSessionClient = ReturnType<typeof createSessionClient>;
