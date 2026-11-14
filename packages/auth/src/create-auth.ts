import { betterAuth } from "better-auth";
import type { Kysely } from "kysely";
import type { AuthConfig } from "./config";
import type { Mailer } from "./mailer";

export const OPERATOR_ROLE = "operator";
export const CLIENT_IP_HEADER = "x-launchpad-client-ip";

// Nothing connects here; the caller owns the database and its lifecycle.
export function createAuth(options: {
    db: Kysely<any>;
    config: AuthConfig;
    mailer?: Mailer | null;
}) {
    const { db, config, mailer = null } = options;
    return betterAuth({
        appName: "Launchpad",
        baseURL: config.baseUrl,
        basePath: "/api/auth",
        secret: config.secret,
        database: { db, type: "postgres" },
        trustedOrigins: [config.origin],
        emailAndPassword: {
            enabled: true,
            disableSignUp: !config.publicSignup,
            minPasswordLength: 12,
            revokeSessionsOnPasswordReset: true,
            resetPasswordTokenExpiresIn: 60 * 60,
            // Better Auth commits its password change before this hook. Revoke
            // credentials first; a later audit failure must not roll that back.
            // Neither the reset token nor the password/key values are recorded.
            onPasswordReset: async ({ user }: { user: { id: string } }) => {
                const revokedKeys = await db.transaction().execute(async (trx) => {
                    // Same order as operator recovery: issuance holds FOR SHARE on
                    // the issuing session, so its insert cannot escape this cleanup.
                    await trx.deleteFrom("session").where("userId", "=", user.id).execute();
                    const result = await trx
                        .updateTable("api_key")
                        .set({ revoked_at: new Date() })
                        .where("created_by", "=", user.id)
                        .where("revoked_at", "is", null)
                        .executeTakeFirst();
                    return Number(result.numUpdatedRows);
                });
                await db
                    .insertInto("audit_event")
                    .values({
                        actor: `user:${user.id}`,
                        action: "user.password_reset_by_email",
                        target_type: "user",
                        target_id: user.id,
                        detail: JSON.stringify({ revokedKeys }),
                    })
                    .execute();
            },
            // Email recovery exists only when a mailer is configured. Without one,
            // Better Auth rejects the request and the operator command is the path.
            ...(mailer
                ? {
                      sendResetPassword: async ({
                          user,
                          token,
                      }: {
                          user: { email: string; emailVerified: boolean };
                          token: string;
                      }) => {
                          // A provisioned address is not proof of mailbox ownership, so
                          // mail only goes to addresses that were verified (by accepting
                          // an invitation). Delivery is not awaited: the response time
                          // is the same for verified, unverified and unknown addresses.
                          if (!user.emailVerified) {
                              return;
                          }
                          void mailer
                              .send({
                                  to: user.email,
                                  subject: "Reset your Launchpad password",
                                  text: `Use this link within one hour to choose a new password:\n\n${config.baseUrl}/reset-password?token=${encodeURIComponent(token)}\n\nIf you did not ask for this, ignore this email.`,
                              })
                              .catch((error) =>
                                  console.error("Password reset email failed", error),
                              );
                      },
                  }
                : {}),
        },
        user: {
            additionalFields: {
                // Instance-level role; never settable through request input.
                role: { type: "string", required: true, defaultValue: "user", input: false },
            },
        },
        session: {
            expiresIn: 60 * 60 * 24 * 7,
            updateAge: 60 * 60 * 24,
        },
        advanced: {
            useSecureCookies: config.secureCookies,
            // Pinned: Better Auth otherwise disables these when it detects a test
            // environment, and no environment may switch them off here.
            disableOriginCheck: false,
            disableCSRFCheck: false,
            // The controller sets this header itself from the socket (or the one
            // trusted proxy hop) after stripping any client-supplied value.
            ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
        },
        rateLimit: {
            enabled: true,
            storage: "database",
            window: 60,
            max: 100,
            customRules: {
                "/sign-in/email": { window: 60, max: 5 },
                "/request-password-reset": { window: 60, max: 3 },
            },
        },
    });
}

export type Auth = ReturnType<typeof createAuth>;
