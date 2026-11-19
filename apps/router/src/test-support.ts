import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempState {
    directory: string;
    stateFile: string;
    config: { stateFile: string; instanceId: string; appsDomain: string };
    cleanup: () => void;
}

export const newToken = () => randomBytes(32).toString("hex");

export function tempState(): TempState {
    const directory = mkdtempSync(path.join(tmpdir(), "launchpad-router-app-"));
    chmodSync(directory, 0o700);
    const stateFile = path.join(directory, "routes.sqlite");
    return {
        directory,
        stateFile,
        config: { stateFile, instanceId: randomUUID(), appsDomain: "sites.example.net" },
        cleanup: () => {
            try {
                chmodSync(directory, 0o700);
            } catch {
                // Already removed.
            }
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

export function secretFile(directory: string, content: string, mode = 0o600, name = "token") {
    const file = path.join(directory, name);
    writeFileSync(file, content, { mode });
    chmodSync(file, mode);
    return file;
}
