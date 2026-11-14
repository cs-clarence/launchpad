import { spawn } from "node:child_process";
import type { DokkuConnection } from "./connection";

export interface TransportRequest {
    // The remote command, already validated. It is not run through a local shell.
    args: readonly string[];
    // Streamed to the remote command's standard input (an image archive).
    stdin?: AsyncIterable<Uint8Array>;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
}

export interface TransportResult {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    // Output beyond the limit is discarded, not buffered.
    truncated: boolean;
    timedOut: boolean;
    aborted: boolean;
    // Bytes actually written to the remote command's input. Once any were, the remote
    // command was certainly running.
    stdinBytes: number;
}

export interface Transport {
    run(request: TransportRequest): Promise<TransportResult>;
}

const KILL_GRACE_MS = 2000;

// The ssh options that make the connection fail closed. Command-line options win over
// any configuration file, and `-F /dev/null` ignores the user's own.
export function sshArguments(
    connection: DokkuConnection,
    remote: readonly string[],
    connectTimeoutSeconds = 10,
): string[] {
    return [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        `UserKnownHostsFile=${connection.knownHostsPath}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "UpdateHostKeys=no",
        "-o",
        "CheckHostIP=no",
        "-o",
        "VerifyHostKeyDNS=no",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "RequestTTY=no",
        "-o",
        `ConnectTimeout=${connectTimeoutSeconds}`,
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "LogLevel=ERROR",
        "-i",
        connection.privateKeyPath,
        "-p",
        String(connection.port),
        // `--` ends ssh's own option parsing, which would otherwise continue after the
        // destination: nothing after it can be taken for an ssh option.
        "--",
        `${connection.username}@${connection.host}`,
        ...remote,
    ];
}

// Runs ssh as a child process with a minimal environment: no agent socket, no proxy
// settings, nothing inherited that could redirect the connection.
export class SshTransport implements Transport {
    constructor(
        private readonly connection: DokkuConnection,
        private readonly options: { sshBinary?: string; connectTimeoutSeconds?: number } = {},
    ) {}

    run(request: TransportRequest): Promise<TransportResult> {
        const argv = sshArguments(
            this.connection,
            request.args,
            this.options.connectTimeoutSeconds,
        );
        return new Promise((resolve) => {
            const child = spawn(this.options.sshBinary ?? "ssh", argv, {
                stdio: ["pipe", "pipe", "pipe"],
                env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
                shell: false,
                windowsHide: true,
            });
            const out = { text: "", bytes: 0 };
            const err = { text: "", bytes: 0 };
            let truncated = false;
            let timedOut = false;
            let aborted = false;
            const sent = { bytes: 0 };
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            const collect = (sink: typeof out, chunk: Buffer) => {
                const room = request.maxOutputBytes - sink.bytes;
                if (room > 0) sink.text += chunk.subarray(0, room).toString("utf8");
                if (chunk.length > room) truncated = true;
                sink.bytes += chunk.length;
            };
            child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
            child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));

            const stop = () => {
                if (child.exitCode !== null || child.signalCode !== null) return;
                child.kill("SIGTERM");
                killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
            };
            const timer = setTimeout(() => {
                timedOut = true;
                stop();
            }, request.timeoutMs);
            const onAbort = () => {
                aborted = true;
                stop();
            };
            if (request.signal?.aborted) onAbort();
            else request.signal?.addEventListener("abort", onAbort, { once: true });

            // A remote command that exits before reading everything closes the pipe:
            // that is not an error here, the exit status says what happened.
            child.stdin.on("error", () => {});
            // Resolves when the child is gone, so a read waiting on the source is released.
            const gone = new Promise<void>((done) => {
                child.once("close", () => done());
                child.once("error", () => done());
            });
            pump(request.stdin, child.stdin, gone, sent).catch(() => {});

            child.on("error", () => {
                // ssh could not be started at all.
                clearTimeout(timer);
                resolve({
                    exitCode: 255,
                    signal: null,
                    stdout: "",
                    stderr: "ssh could not be started",
                    truncated: false,
                    timedOut: false,
                    aborted,
                    stdinBytes: 0,
                });
            });
            child.on("close", (exitCode, signal) => {
                clearTimeout(timer);
                clearTimeout(killTimer);
                request.signal?.removeEventListener("abort", onAbort);
                resolve({
                    exitCode,
                    signal,
                    stdout: out.text,
                    stderr: err.text,
                    truncated,
                    timedOut,
                    aborted,
                    stdinBytes: sent.bytes,
                });
            });
        });
    }
}

// Writes the stream to the child with backpressure, then closes its input. The source
// is released as soon as the child is gone, even while a read is still waiting for
// its next chunk: the producer must not be kept alive by a process that has ended.
// `gone` is subscribed to once; each wait is a fresh promise that the single
// subscription can wake, so nothing accumulates on a long-lived promise.
async function pump(
    source: AsyncIterable<Uint8Array> | undefined,
    sink: NodeJS.WritableStream & { destroyed?: boolean },
    gone: Promise<void>,
    sent: { bytes: number },
): Promise<void> {
    if (!source) {
        sink.end();
        return;
    }
    let over = false;
    let wake: (() => void) | undefined;
    void gone.then(() => {
        over = true;
        wake?.();
    });
    const waitable = <T>(inner: Promise<T>): Promise<T | undefined> =>
        new Promise<T | undefined>((resolve, reject) => {
            if (over) return resolve(undefined);
            wake = () => resolve(undefined);
            inner.then(resolve, reject);
        }).finally(() => {
            wake = undefined;
        });
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
        iterator = source[Symbol.asyncIterator]();
        for (;;) {
            const next = await waitable(iterator.next());
            if (over || !next || next.done || sink.destroyed) break;
            sent.bytes += next.value.byteLength;
            if (!sink.write(next.value)) {
                let done: (() => void) | undefined;
                await waitable(
                    new Promise<void>((resolve) => {
                        done = () => resolve();
                        sink.once("drain", done);
                        sink.once("close", done);
                    }),
                );
                if (done) {
                    sink.off("drain", done);
                    sink.off("close", done);
                }
            }
        }
    } catch {
        // The source failed: close the input; the exit status reports the outcome.
    } finally {
        // A read still waiting is released by return(); do not wait on it forever.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            Promise.resolve()
                .then(() => iterator?.return?.())
                .catch(() => {}),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
                timer.unref?.();
            }),
        ]);
        clearTimeout(timer);
        sink.end();
    }
}
