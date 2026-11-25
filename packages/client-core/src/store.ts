import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SecureJsonFile } from "./secure-file";

const profileSchema = z.object({
    controller: z.string(),
    apiKey: z.string(),
    organizationId: z.string().nullable(),
    savedAt: z.string(),
});
const configSchema = z.object({
    version: z.literal(1),
    currentProfile: z.string().nullable(),
    profiles: z.record(z.string(), profileSchema),
});

export type Profile = z.infer<typeof profileSchema>;
export type Config = z.infer<typeof configSchema>;

export const emptyConfig = (): Config => ({ version: 1, currentProfile: null, profiles: {} });

export function configDirectory(env: Record<string, string | undefined>): string {
    if (env.LAUNCHPAD_CONFIG_DIR) return env.LAUNCHPAD_CONFIG_DIR;
    if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "launchpad");
    return path.join(os.homedir(), ".config", "launchpad");
}

const FILE = "credentials.json";

// The credential file; see SecureJsonFile for how it is kept safe.
export class CredentialStore extends SecureJsonFile<Config> {
    constructor(directory: string) {
        super(directory, {
            name: FILE,
            label: "credential store",
            schema: configSchema,
            empty: emptyConfig,
        });
    }
}
