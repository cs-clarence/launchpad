import { z } from "zod";

const booleanFlag = z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true");

const schema = z.object({
    LAUNCHPAD_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    LAUNCHPAD_BASE_URL: z.url(),
    LAUNCHPAD_ENROLLMENT: z.enum(["operator", "invitation"]).default("operator"),
    LAUNCHPAD_PUBLIC_SIGNUP: booleanFlag,
    LAUNCHPAD_SMTP_URL: z.string().min(1).optional(),
    LAUNCHPAD_EMAIL_FROM: z.string().min(1).optional(),
    LAUNCHPAD_TRUSTED_PROXY: booleanFlag,
});

export interface AuthConfig {
    secret: string;
    baseUrl: string;
    origin: string;
    secureCookies: boolean;
    enrollment: "operator" | "invitation";
    publicSignup: boolean;
    smtp: { url: string; from: string } | null;
    trustedProxy: boolean;
}

export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        throw new Error(`Invalid authentication configuration: ${issues.join("; ")}`);
    }
    const value = parsed.data;
    if (Boolean(value.LAUNCHPAD_SMTP_URL) !== Boolean(value.LAUNCHPAD_EMAIL_FROM)) {
        throw new Error("LAUNCHPAD_SMTP_URL and LAUNCHPAD_EMAIL_FROM must be set together");
    }
    if (value.LAUNCHPAD_ENROLLMENT === "invitation" && !value.LAUNCHPAD_SMTP_URL) {
        throw new Error("LAUNCHPAD_ENROLLMENT=invitation requires SMTP to be configured");
    }
    if (value.LAUNCHPAD_SMTP_URL) {
        let smtp: URL;
        try {
            smtp = new URL(value.LAUNCHPAD_SMTP_URL);
        } catch {
            throw new Error("LAUNCHPAD_SMTP_URL is not a valid URL");
        }
        if (smtp.protocol !== "smtp:" && smtp.protocol !== "smtps:") {
            throw new Error("LAUNCHPAD_SMTP_URL must use smtp:// or smtps://");
        }
        // Query options would override the TLS requirement or enable debug logging.
        if (smtp.search || smtp.hash) {
            throw new Error("LAUNCHPAD_SMTP_URL must not carry query or fragment options");
        }
    }
    const url = new URL(value.LAUNCHPAD_BASE_URL);
    return {
        secret: value.LAUNCHPAD_AUTH_SECRET,
        baseUrl: url.origin,
        origin: url.origin,
        secureCookies: url.protocol === "https:",
        enrollment: value.LAUNCHPAD_ENROLLMENT,
        publicSignup: value.LAUNCHPAD_PUBLIC_SIGNUP,
        smtp:
            value.LAUNCHPAD_SMTP_URL && value.LAUNCHPAD_EMAIL_FROM
                ? { url: value.LAUNCHPAD_SMTP_URL, from: value.LAUNCHPAD_EMAIL_FROM }
                : null,
        trustedProxy: value.LAUNCHPAD_TRUSTED_PROXY,
    };
}
