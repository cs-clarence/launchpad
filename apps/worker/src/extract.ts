import { promises as fs } from "node:fs";
import path from "node:path";
import { validateArchive, type ArchiveLimits } from "@launchpad-kit/services";
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
    // Readable by the web server's user inside the image: the build context is the only
    // place its permissions come from, and they come from here, not from the archive.
    await fs.mkdir(destination, { recursive: true, mode: 0o755 });
    await extract({
        file: archivePath,
        cwd: destination,
        strict: true,
        // tar's own 1000:1 decompression-ratio guard is redundant here and made upload and build
        // disagree: validateArchive above already bounds the expanded size (and entry count), so
        // nothing can expand past the configured limit. Without this, a valid, highly compressible
        // site (a few MiB of zeros compresses past 1000:1) was accepted at upload and then failed
        // at build with an opaque error.
        maxDecompressionRatio: Number.POSITIVE_INFINITY,
        preservePaths: false,
        noChmod: true,
        // Ownership comes from this process; modes are set by the filter and then
        // normalized below, so nothing but plain read permissions survives.
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        filter: (_path, entry) => {
            const type = (entry as { type?: string }).type;
            return type === "File" || type === "OldFile" || type === "Directory";
        },
    });
    await fs.chmod(destination, 0o755);
    return { fileCount: await checkTree(destination) };
}

// Everything under `root` must be a regular file or directory that really lives inside
// it (their modes are normalized as they are visited), and the site must have an index.
async function checkTree(root: string): Promise<number> {
    let files = 0;
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await fs.chmod(full, 0o755);
                await walk(full);
            } else if (entry.isFile()) {
                // Whatever the archive said (unreadable, setuid, setgid, executable): a
                // static file is world-readable and nothing else.
                await fs.chmod(full, 0o644);
                files++;
            } else throw new Error("The extracted site contains something other than files.");
        }
    };
    await walk(root);
    const index = await fs.lstat(path.join(root, "index.html")).catch(() => undefined);
    if (!index?.isFile()) throw new Error("The site has no index.html at its root.");
    return files;
}
