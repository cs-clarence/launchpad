import { promises as fs } from "node:fs";
import path from "node:path";
import { validateArchive, type ArchiveLimits } from "@launchpad/services";
import { extract } from "tar";

// The archive was validated at upload, but what is on disk is not trusted again just
// because it was: it is validated a second time, then extracted with a filter that
// admits only plain files and directories, and the result is checked afterwards.
export async function extractSite(
    archivePath: string,
    destination: string,
    limits: ArchiveLimits,
): Promise<{ fileCount: number }> {
    await validateArchive(archivePath, limits);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    await extract({
        file: archivePath,
        cwd: destination,
        strict: true,
        preservePaths: false,
        noChmod: true,
        // Ownership and modes come from this process, never from the archive.
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        filter: (_path, entry) => {
            const type = (entry as { type?: string }).type;
            return type === "File" || type === "OldFile" || type === "Directory";
        },
    });
    return { fileCount: await checkTree(destination) };
}

// Everything under `root` must be a regular file or directory that really lives inside
// it, and the site must have an index.
async function checkTree(root: string): Promise<number> {
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) files++;
            else throw new Error("The extracted site contains something other than files.");
        }
    };
    await walk(root);
    const index = await fs.lstat(path.join(root, "index.html")).catch(() => undefined);
    if (!index?.isFile()) throw new Error("The site has no index.html at its root.");
    return files;
}
