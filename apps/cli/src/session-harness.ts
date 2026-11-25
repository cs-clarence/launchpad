import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext } from "@launchpad-kit/client-core";
import type { Io, SignalHooks } from "./io";
import { readSecretFrom } from "./io";
import { run } from "./program";

// A fake controller and terminal for the `--session` tests. Every fetch is recorded, so a test
// can state exactly what was (and was not) sent.
export const CONTROLLER = "https://control.example.com";
export const PASSWORD = "correct horse battery";
export const OPERATOR = "op@example.com";
export const OWNER = "ann@example.com";
export const USERS: Record<string, string> = {
    [OPERATOR]: "operator password 1",
    [OWNER]: PASSWORD,
    "bob@example.com": "bobs long password",
};

export interface Recorded {
    method: string;
    url: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}

export interface Api {
    method: string;
    path: string;
    search: string;
    body: string;
    email: string;
    cookie: string;
    headers: Record<string, string>;
}

export const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
    });

export type Responder = (api: Api, world: World) => Response | Promise<Response>;

export interface World {
    requests: Recorded[];
    out: string[];
    err: string[];
    sessions: Map<string, string>;
    signedIn: string[];
    signedOut: string[];
    listeners: Map<string, Set<() => void>>;
    exits: number[];
    prompts: string[];
    rawMode: boolean[];
    emit(signal: NodeJS.Signals): void;
    typed(text: string): void;
    code: number;
    text(): string;
    dir: string;
    cookieOf(email: string): string | undefined;
    // A response that stays pending until a second signal makes the CLI leave.
    hang(): Promise<Response>;
}

export interface Options {
    env?: Record<string, string | undefined>;
    respond?: Responder;
    // Answers for the sign-in and sign-out endpoints, to inject failures.
    signIn?: (n: number, world: World) => Response | Promise<Response> | undefined;
    signOut?: (world: World) => Response | Promise<Response> | undefined;
    interactive?: boolean;
    // "terminal" runs the real hidden prompt against a fake terminal; otherwise answers at once.
    prompt?: "terminal" | "instant";
    answer?: string;
    files?: Record<string, string>;
    workingDir?: string;
    noSignals?: boolean;
    // Called for each request before it is answered.
    onRequest?: (request: Recorded, world: World) => void;
    // Called just after the hidden prompt starts, to type, press Ctrl-C or send a signal.
    onPrompt?: (world: World) => void;
}

export async function makeDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "lp-sess-cli-"));
}

export async function session(args: string[], dir: string, options: Options = {}): Promise<World> {
    const requests: Recorded[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const sessions = new Map<string, string>(); // cookie pair -> email
    const signedIn: string[] = [];
    const signedOut: string[] = [];
    const listeners = new Map<string, Set<() => void>>();
    const exits: number[] = [];
    const prompts: string[] = [];
    const rawMode: boolean[] = [];
    const dataListeners: Array<(chunk: string) => void> = [];
    let counter = 0;
    let releaseHang: () => void = () => {};

    const world: World = {
        requests,
        out,
        err,
        sessions,
        signedIn,
        signedOut,
        listeners,
        exits,
        prompts,
        rawMode,
        emit: (signal) => [...(listeners.get(signal) ?? [])].forEach((l) => l()),
        typed: (text) => dataListeners.forEach((l) => l(text)),
        code: -1,
        text: () => out.join("\n") + "\n" + err.join("\n"),
        dir,
        cookieOf: (email) => [...sessions].find(([, e]) => e === email)?.[0],
        hang: () =>
            new Promise<Response>((resolve) => {
                releaseHang = () => resolve(json({ success: true }));
            }),
    };

    const cookieName = "__Secure-better-auth.session_token";
    const fetchImpl = (async (url: string, init: RequestInit) => {
        const parsed = new URL(url);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
            headers[k.toLowerCase()] = v;
        }
        const recorded: Recorded = {
            method: String(init.method ?? "GET"),
            url,
            path: parsed.pathname,
            headers,
            body:
                init.body === undefined
                    ? ""
                    : typeof init.body === "string"
                      ? init.body
                      : new TextDecoder().decode(init.body as Uint8Array),
        };
        requests.push(recorded);
        options.onRequest?.(recorded, world);
        const answer = async (): Promise<Response> => {
            if (parsed.pathname === "/api/auth/sign-in/email") {
                const injected = options.signIn?.(signedIn.length + 1, world);
                if (injected) return injected;
                const body = JSON.parse(recorded.body) as { email: string; password: string };
                if (USERS[body.email.trim().toLowerCase()] !== body.password) {
                    return json(
                        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
                        { status: 401 },
                    );
                }
                const pair = `${cookieName}=tok${++counter}.sig%2Bsecretvalue`;
                sessions.set(pair, body.email.trim().toLowerCase());
                signedIn.push(body.email);
                return new Response(JSON.stringify({ token: "t" }), {
                    headers: new Headers([
                        ["content-type", "application/json"],
                        ["set-cookie", `${pair}; Max-Age=604800; Path=/; HttpOnly; Secure`],
                    ]),
                });
            }
            if (parsed.pathname === "/api/auth/sign-out") {
                const injected = options.signOut?.(world);
                if (injected) return injected;
                const cookie = headers.cookie;
                if (!cookie || !sessions.has(cookie)) return json({}, { status: 401 });
                signedOut.push(sessions.get(cookie)!);
                sessions.delete(cookie);
                return json({ success: true });
            }
            if (parsed.pathname.startsWith("/api/v1/")) {
                if (headers.authorization) {
                    return json(
                        { code: "unauthenticated", title: "Unauthorized" },
                        { status: 401 },
                    );
                }
                const email = sessions.get(headers.cookie ?? "");
                if (!email) {
                    return json(
                        { code: "unauthenticated", status: 401, title: "Unauthorized" },
                        { status: 401 },
                    );
                }
                if (recorded.method !== "GET" && headers.origin !== CONTROLLER) {
                    return json(
                        { code: "forbidden-origin", status: 403, title: "Forbidden" },
                        { status: 403 },
                    );
                }
                return (options.respond ?? (() => json({ ok: true })))(
                    {
                        method: recorded.method,
                        path: parsed.pathname.slice("/api/v1".length),
                        search: parsed.search,
                        body: recorded.body,
                        email,
                        cookie: headers.cookie!,
                        headers,
                    },
                    world,
                );
            }
            return json({}, { status: 404 });
        };
        const signal = init.signal as AbortSignal | undefined;
        const aborted = new Promise<never>((_, reject) => {
            const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            if (signal?.aborted) fail();
            signal?.addEventListener("abort", fail, { once: true });
        });
        return Promise.race([answer(), aborted]);
    }) as unknown as typeof fetch;

    const stdin = {
        setRawMode: (mode: boolean) => void rawMode.push(mode),
        resume: () => {},
        pause: () => {},
        setEncoding: () => {},
        on: (_e: "data", l: (chunk: string) => void) => void dataListeners.push(l),
        off: (_e: "data", l: (chunk: string) => void) => {
            dataListeners.splice(dataListeners.indexOf(l), 1);
        },
    };
    const hooks: SignalHooks = {
        on: (signal, listener) => {
            if (!listeners.has(signal)) listeners.set(signal, new Set());
            listeners.get(signal)!.add(listener);
        },
        off: (signal, listener) => void listeners.get(signal)?.delete(listener),
        exit: (code) => {
            exits.push(code);
            releaseHang();
        },
    };
    const io: Io = {
        context: createContext(
            { LAUNCHPAD_CONFIG_DIR: dir, LAUNCHPAD_CONTROLLER: CONTROLLER, ...options.env },
            { fetch: fetchImpl },
        ),
        workingDir: options.workingDir ?? dir,
        out: (t) => void out.push(t),
        err: (t) => void err.push(t),
        interactive: options.interactive ?? true,
        stdinIsTTY: options.interactive ?? true,
        readSecret: (prompt, secretOptions) => {
            prompts.push(prompt);
            if (options.prompt !== "terminal") return Promise.resolve(options.answer ?? PASSWORD);
            const result = readSecretFrom(
                { stdin, stderr: { write: () => {} } },
                prompt,
                secretOptions,
            );
            if (options.onPrompt) queueMicrotask(() => options.onPrompt!(world));
            return result;
        },
        readPasswordFile: async (file) => {
            const found = options.files?.[file];
            if (found === undefined) throw new Error("The password file was not found.");
            return found;
        },
        readStdin: async () => "",
        readFile: async () => ({ text: "", mode: 0o600 }),
        readData: async () => new Uint8Array(),
        signals: options.noSignals ? undefined : hooks,
    };
    world.code = await run(args, io);
    return world;
}
