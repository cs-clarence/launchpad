import { normalizeBaseUrl } from "@launchpad-kit/sdk";
import { z } from "zod";
import { SecureJsonFile } from "./secure-file";

// Same normalisation as the controller's login throttle, so one account is one key.
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const entrySchema = z.object({
    controller: z.string(),
    email: z.string(),
    cookie: z.string(),
    savedAt: z.string(),
});
const sessionsSchema = z
    .object({
        version: z.literal(1),
        sessions: z.record(z.string(), entrySchema),
    })
    .refine((file) =>
        Object.entries(file.sessions).every(([key, entry]) => {
            try {
                return (
                    key === entry.controller &&
                    normalizeBaseUrl(entry.controller) === key &&
                    normalizeEmail(entry.email) === entry.email
                );
            } catch {
                return false;
            }
        }),
    );

export type SessionEntry = z.infer<typeof entrySchema>;
export type SessionFile = z.infer<typeof sessionsSchema>;

const FILE = "session.json";

// A kept CLI session: an account-wide bearer credential, so it lives apart from
// credentials.json (older CLIs and the MCP server never open this file). One entry per
// controller, keyed by the normalized controller URL. Only the session commands of the
// CLI read it; nothing here reads the environment.
export class SessionStore extends SecureJsonFile<SessionFile> {
    constructor(directory: string) {
        super(directory, {
            name: FILE,
            label: "session store",
            schema: sessionsSchema,
            empty: () => ({ version: 1, sessions: {} }),
        });
    }

    async get(controller: string): Promise<SessionEntry | null> {
        const key = normalizeBaseUrl(controller);
        const file = await this.load();
        return Object.hasOwn(file.sessions, key) ? file.sessions[key]! : null;
    }

    // Replaces the entry for the controller; returns the one it replaced.
    put(input: {
        controller: string;
        email: string;
        cookie: string;
        savedAt?: string;
    }): Promise<SessionEntry | null> {
        const controller = normalizeBaseUrl(input.controller);
        return this.update((file) => {
            const previous = Object.hasOwn(file.sessions, controller)
                ? file.sessions[controller]!
                : null;
            file.sessions[controller] = {
                controller,
                email: normalizeEmail(input.email),
                cookie: input.cookie,
                savedAt: input.savedAt ?? new Date().toISOString(),
            };
            return previous;
        });
    }

    // Removes the entry; with `cookie`, only if it still holds that cookie, so a newer
    // sign-in is never deleted by a command that used the older one.
    remove(controller: string, cookie?: string): Promise<SessionEntry | null> {
        const key = normalizeBaseUrl(controller);
        return this.update((file) => {
            const found = Object.hasOwn(file.sessions, key) ? file.sessions[key]! : null;
            if (!found || (cookie !== undefined && found.cookie !== cookie)) return null;
            delete file.sessions[key];
            return found;
        });
    }
}
