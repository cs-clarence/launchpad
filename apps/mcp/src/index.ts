#!/usr/bin/env node
import {
    ClientCoreError,
    createContext,
    readWorkspace,
    safeOutput,
} from "@launchpad-kit/client-core";
import { CommanderError } from "@commander-js/extra-typings";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";
import { startupOptions } from "./program";

// Even help and startup failures go to stderr: stdout belongs solely to MCP.
const diagnostic = (text: string) => void process.stderr.write(safeOutput(text));
async function main() {
    const options = startupOptions(process.argv.slice(2), diagnostic);
    const workingDir = options.workingDir ?? (options.shared ? undefined : process.cwd());
    if (workingDir) await readWorkspace(workingDir);
    const server = createMcpServer(createContext(), { ...options, workingDir });
    server.server.onclose = () => {
        process.stdin.pause();
    };
    server.server.onerror = () => diagnostic("MCP transport error.\n");
    await server.connect(
        new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
    );
}

void main().catch((error: unknown) => {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return;
    // These two carry messages written for the operator, never file contents or keys.
    const known = error instanceof CommanderError || error instanceof ClientCoreError;
    diagnostic(
        known
            ? `${error.message}\n`
            : "Could not start launchpad-mcp. Check options, working directory and launchpad.json.\n",
    );
    process.exitCode = 2;
});
