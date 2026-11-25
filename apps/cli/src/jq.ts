import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { checkScript, executeScript } from "@elastic/micro-jq";
import { ClientCoreError } from "@launchpad-kit/client-core";

export interface JqLimits {
    timeoutMs: number;
    maxOutputBytes: number;
}
const DEFAULT_LIMITS: JqLimits = { timeoutMs: 10_000, maxOutputBytes: 8 * 1024 * 1024 };
const MAX_STDERR_BYTES = 4096;
const MAX_EXPRESSION_CHARS = 4096;

export type JqEngine = { kind: "system"; file: string } | { kind: "builtin" };

// The file names to try for `name`: on Windows the program is `name.exe`.
export const candidateNames = (name: string, platform: string = process.platform) =>
    platform === "win32" ? [name, `${name}.exe`] : [name];

// The first executable `name` on PATH, or null. Plain files only, so a directory named jq is skipped.
export function findOnPath(
    name: string,
    searchPath: string | undefined,
    platform: string = process.platform,
): string | null {
    for (const directory of (searchPath ?? "").split(path.delimiter)) {
        if (!directory || !path.isAbsolute(directory)) continue;
        for (const candidate of candidateNames(name, platform)) {
            const file = path.join(directory, candidate);
            try {
                if (!statSync(file).isFile()) continue;
                accessSync(file, constants.X_OK);
                return file;
            } catch {
                continue;
            }
        }
    }
    return null;
}

// The program is the first non-option argument. `--` is avoided because jq 1.6 may not accept it;
// a leading space keeps an expression such as `-1` from being read as an option.
export const jqProgram = (expression: string) =>
    expression.startsWith("-") ? ` ${expression}` : expression;

const bad = (message: string) => new ClientCoreError("bad-input", message);

// `accept` lists exit codes that are not failures (a compile check runs the filter on null,
// where a runtime error, exit 5, says nothing about the expression's syntax).
function runSystemJq(
    file: string,
    args: string[],
    input: string,
    accept: number[] = [0],
    limits: JqLimits = DEFAULT_LIMITS,
): Promise<string> {
    return new Promise((resolve, reject) => {
        // No shell, no inherited environment (so `$ENV` and `env` hold nothing), and the
        // expression is one argument (a leading `-` is guarded by `jqProgram`), never a shell string.
        const child = spawn(file, args, {
            env: {},
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outBytes = 0;
        let errBytes = 0;
        let failure: Error | undefined;
        const stop = (error: Error) => {
            failure ??= error;
            child.kill("SIGKILL");
            // Do not wait for a grandchild that still holds the pipes, and let go of them so
            // it cannot keep this process alive.
            child.stdout.destroy();
            child.stderr.destroy();
            clearTimeout(timer);
            reject(failure);
        };
        const timer = setTimeout(
            () => stop(bad("jq took too long and was stopped.")),
            limits.timeoutMs,
        );
        child.stdout.on("data", (chunk: Buffer) => {
            outBytes += chunk.length;
            if (outBytes > limits.maxOutputBytes) stop(bad("jq printed too much; stopped."));
            else out.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            if (errBytes < MAX_STDERR_BYTES) err.push(chunk);
            errBytes += chunk.length;
        });
        child.stdin.on("error", () => {});
        child.on("error", () => {
            clearTimeout(timer);
            reject(bad("jq could not be run."));
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            if (code === null || !accept.includes(code)) {
                const message = Buffer.concat(err)
                    .toString("utf8")
                    .slice(0, MAX_STDERR_BYTES)
                    .trim();
                return reject(bad(`jq: ${message || `exited with ${code}`}`));
            }
            resolve(Buffer.concat(out).toString("utf8").replace(/\n$/, ""));
        });
        child.stdin.end(input);
    });
}

const render = (value: unknown) =>
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "null");

// micro-jq returns one value, so a stream (`.[].slug`) arrives as an array. An expression that
// does not build an array itself and iterates is shown one result per line, as jq prints it.
function runBuiltinJq(expression: string, input: string): string {
    if (!checkScript(expression)) throw bad("The jq expression is not valid (or not supported).");
    let result: unknown;
    try {
        result = executeScript(JSON.parse(input), expression);
    } catch (error) {
        throw bad(`jq: ${error instanceof Error ? error.message.slice(0, 200) : "failed"}`);
    }
    const streams =
        Array.isArray(result) &&
        !expression.trimStart().startsWith("[") &&
        // An iterator follows a path (`.[]`, `.a[]`, `x[]`); a literal `[]` (`.x // []`) does not.
        /[\w\].)"]\[\]/.test(expression);
    return (streams ? (result as unknown[]) : [result]).map(render).join("\n");
}

export function chooseJq(searchPath: string | undefined, find = findOnPath): JqEngine {
    const file = find("jq", searchPath);
    return file ? { kind: "system", file } : { kind: "builtin" };
}

// Refuses an invalid expression before the request is sent. jq exits 3 for a compile error.
// The filter also runs on null, so one like `input` or `repeat` runs until the timeout.
export async function checkJq(engine: JqEngine, expression: string): Promise<void> {
    if (expression.length === 0 || expression.length > MAX_EXPRESSION_CHARS) {
        throw bad("The jq expression must be 1 to 4096 characters.");
    }
    if (engine.kind === "builtin") {
        if (!checkScript(expression)) {
            throw bad("The jq expression is not valid (or not supported).");
        }
        return;
    }
    await runSystemJq(engine.file, ["-n", "-r", jqProgram(expression)], "", [0, 1, 5]);
}

// Applies a jq expression to a JSON response body. Invalid expressions and non-JSON input are
// usage errors (exit 2).
export async function applyJq(
    engine: JqEngine,
    expression: string,
    input: string,
    limits: JqLimits = DEFAULT_LIMITS,
): Promise<string> {
    if (expression.length === 0 || expression.length > MAX_EXPRESSION_CHARS) {
        throw bad("The jq expression must be 1 to 4096 characters.");
    }
    try {
        JSON.parse(input);
    } catch {
        throw bad("The response is not JSON, so --jq cannot be applied.");
    }
    return engine.kind === "system"
        ? runSystemJq(engine.file, ["-r", jqProgram(expression)], input, [0], limits)
        : runBuiltinJq(expression, input);
}
