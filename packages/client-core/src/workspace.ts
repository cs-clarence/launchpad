import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ClientCoreError } from "./errors";
import { clientFor, type Context, resolve } from "./operations";

const text = z.string().trim().min(1).max(128);
const workspaceSchema = z.strictObject({
    profile: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/)
        .optional(),
    organization: text,
    project: text,
});
export type WorkspaceConfig = z.infer<typeof workspaceSchema>;
export const MAX_WORKSPACE_CONFIG_BYTES = 16 * 1024;

/** A file is trusted only if the current user owns it. Where there are no user ids, it is. */
export function ownedByCurrentUser(owner: number, current: number | undefined): boolean {
    return current === undefined || owner === current;
}

function badConfig(): never {
    // Do not include the file's contents, parsing error, or arbitrary path in output.
    throw new ClientCoreError(
        "bad-input",
        "launchpad.json must be a regular, non-symlink JSON file (16 KiB at most) with organization, project, and optional profile.",
    );
}

async function readConfig(file: string): Promise<WorkspaceConfig | null> {
    const entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        return badConfig();
    });
    if (!entry) return null;
    if (!entry.isFile()) badConfig();
    // Another user's file in a shared directory (a planted /tmp/launchpad.json) must not
    // choose this user's profile, organization or project: it is not looked at.
    if (!ownedByCurrentUser(entry.uid, process.getuid?.())) return null;
    const handle = await fs
        .open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            return badConfig();
        });
    if (!handle) return null;
    try {
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.size > MAX_WORKSPACE_CONFIG_BYTES ||
            stat.dev !== entry.dev ||
            stat.ino !== entry.ino
        )
            badConfig();
        // One bounded read, including a sentinel byte for a file that grows.
        const bytes = Buffer.alloc(MAX_WORKSPACE_CONFIG_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
            const read = await handle.read(bytes, size, bytes.length - size, null);
            if (!read.bytesRead) break;
            size += read.bytesRead;
        }
        if (size > MAX_WORKSPACE_CONFIG_BYTES) badConfig();
        const parsed = workspaceSchema.safeParse(
            JSON.parse(bytes.subarray(0, size).toString("utf8")),
        );
        if (!parsed.success) badConfig();
        return parsed.data;
    } catch {
        return badConfig();
    } finally {
        await handle.close();
    }
}

/** Resolve an absolute directory and find the nearest launchpad.json, up to the filesystem root.
 * Missing config is allowed; invalid config is refused rather than skipped.
 * No process working directory or credential-store state is changed.
 */
export async function readWorkspace(workingDir: string) {
    if (!path.isAbsolute(workingDir)) {
        throw new ClientCoreError(
            "bad-input",
            "working_dir must be an absolute existing directory.",
        );
    }
    const directory = await fs.realpath(workingDir).catch(() => null);
    if (!directory || !(await fs.stat(directory)).isDirectory()) {
        throw new ClientCoreError(
            "bad-input",
            "working_dir must be an absolute existing directory.",
        );
    }
    let candidate = directory;
    for (;;) {
        const config = await readConfig(path.join(candidate, "launchpad.json"));
        if (config) return { directory, config };
        const parent = path.dirname(candidate);
        if (parent === candidate) return { directory, config: null };
        candidate = parent;
    }
}

/** Build a per-call client context. Explicit arguments override project config;
 * an organization override is checked against the key's visible organizations.
 * Never persists profile/organization selections to the credential store.
 */
export async function workspaceContext(
    ctx: Context,
    input: {
        workingDir: string;
        profile?: string;
        organization?: string;
        project?: string;
        // Used only when neither the call nor launchpad.json names a profile.
        defaultProfile?: string;
    },
) {
    const workspace = await readWorkspace(input.workingDir);
    let profile = input.profile ?? workspace.config?.profile ?? input.defaultProfile;
    const organization = input.organization ?? workspace.config?.organization;
    let scoped = ctx;
    if (organization) {
        const resolved = await resolve(ctx, profile);
        // Do not select currentProfile again after checking this identity's organization.
        profile ??= resolved.profile ?? undefined;
        const organizations = await clientFor(ctx, resolved).organizations.list();
        const match = organizations.find((o) => o.id === organization || o.slug === organization);
        if (!match) {
            throw new ClientCoreError(
                "no-organization",
                "This key cannot see the selected organization.",
            );
        }
        scoped = { ...ctx, env: { ...ctx.env, LAUNCHPAD_ORG: match.id } };
    }
    return {
        context: scoped,
        profile,
        project: input.project ?? workspace.config?.project,
        directory: workspace.directory,
        // Only what an argument or launchpad.json selected, not the inherited environment.
        organization,
    };
}
