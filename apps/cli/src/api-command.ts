import type { Command } from "@commander-js/extra-typings";
import {
    ClientCoreError,
    clientFor,
    fieldsToQuery,
    parseFields,
    readWorkspace,
    requireConfirmation,
    resolve,
    type FieldInput,
} from "@launchpad-kit/client-core";
import {
    FORBIDDEN_RAW_HEADERS,
    LaunchpadTransportError,
    normalizeBaseUrl,
    RAW_METHODS,
    type RawOptions,
    type RawResponse,
} from "@launchpad-kit/sdk";
import { ExitWith } from "./errors";
import type { Io } from "./io";
import { applyJq, checkJq, chooseJq, findOnPath } from "./jq";
import { arrayItems, prettyJson } from "./json-text";
import { SessionFlow } from "./session-flow";
import { checkEmail, refuseWithKey, resolveSessionTarget } from "./session-target";

const MAX_PAGES = 1000;
const MAX_TOTAL_ITEMS = 100_000;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const PAGINATE_DEADLINE_MS = 5 * 60 * 1000;
const PLACEHOLDER = /\{(org|project)\}/g;

const bad = (message: string) => new ClientCoreError("bad-input", message);

// Never print a credential: the key is replaced by name, and cookies are not shown either.
const SENSITIVE_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2"]);
const headerLines = (headers: Headers) =>
    [...headers.entries()].map(
        ([name, value]) =>
            `${name}: ${SENSITIVE_RESPONSE_HEADERS.has(name) ? "[redacted]" : value}`,
    );

// JSON is re-indented with every number as the controller wrote it; anything else is shown as is.
const pretty = (text: string) => {
    try {
        return prettyJson(text);
    } catch {
        return text.replace(/\n$/, "");
    }
};

// What a request is sent with: a key, or the user's own session. Everything else in the command
// is the same for both.
interface Backend {
    controller: string;
    // The organization chosen outside the credential (profile, LAUNCHPAD_ORG), if any.
    organizationId: string | null;
    organizations(): Promise<Array<{ id: string; slug: string }>>;
    // The credential's own organization, for a key; a session has none.
    ownOrganization(): Promise<string>;
    raw(method: string, path: string, options: RawOptions): Promise<RawResponse>;
    // Request lines shown by --verbose in place of the credential itself.
    credentialLines: string[];
}

export function addApiCommand(
    program: Command<any, any, any>,
    io: Io,
    remember: (secret: string) => void = () => {},
) {
    const fields: FieldInput[] = [];
    const headers: string[] = [];
    program
        .command("api")
        .description(
            "Call any /api/v1 endpoint of the controller with the current key and print the response (modeled on `gh api`).",
        )
        .argument("<endpoint>", "path under /api/v1, e.g. organizations/{org}/apps")
        .option("-X, --method <method>", "HTTP method (GET, or POST when fields are given)")
        .option(
            "-f, --raw-field <key=value>",
            "add a string parameter (repeatable; a[b]=c nests, a[]=x builds an array)",
            (value: string) => void fields.push({ typed: false, text: value }),
        )
        .option(
            "-F, --field <key=value>",
            "add a typed parameter: true, false, null and integers convert; @file and @- read a file or stdin",
            (value: string) => void fields.push({ typed: true, text: value }),
        )
        .option(
            "--input <file>",
            "send this file (or - for stdin) as the body, byte for byte (JSON unless -H sets a content-type)",
        )
        .option(
            "-H, --header <name:value>",
            `add a request header (refused: ${[...FORBIDDEN_RAW_HEADERS].join(", ")})`,
            (value: string) => void headers.push(value),
        )
        .option("-i, --include", "print the status line and response headers first")
        .option("--silent", "do not print the response body")
        .option("--verbose", "print the request and response (the key and cookies are redacted)")
        .option("--paginate", 'follow same-origin rel="next" links of a list and merge the arrays')
        .option("--slurp", "with --paginate, print an array of the pages instead of merging them")
        .option(
            "-q, --jq <expression>",
            "filter the JSON response with jq (the system jq if found, else a built-in subset)",
        )
        .option(
            "--idempotency-key <key>",
            "send this Idempotency-Key header (1 to 128 printable ASCII)",
        )
        .option("--confirm", "confirm a request that is not GET or HEAD")
        .option(
            "--session",
            "use your own account (an email and password sign-in) instead of a key, for the " +
                "organization, member and key endpoints a key cannot reach. The session lives only " +
                "for this command and is signed out at the end (best effort). Each call is a new " +
                "sign-in, and sign-ins are throttled per account and address: more than 5 a minute " +
                "are refused and also block that account's dashboard sign-in. Use occasionally.",
        )
        .option("--email <address>", "with --session, the account's email address")
        .option(
            "--password-file <path>",
            "with --session, read the password from this private file instead of the prompt",
        )
        .option(
            "--controller <url>",
            "with --session, the controller (else the selected profile's, else LAUNCHPAD_CONTROLLER)",
        )
        .action(async (endpoint, options, command) => {
            const holder: { flow?: SessionFlow } = {};
            try {
                await execute(endpoint, options, command, holder);
            } catch (error) {
                await holder.flow?.close();
                if (holder.flow?.interruptedWith != null) {
                    io.err("Interrupted.");
                    throw new ExitWith(holder.flow.interruptedWith);
                }
                throw error;
            }
            await holder.flow?.close();
            if (holder.flow?.interruptedWith != null)
                throw new ExitWith(holder.flow.interruptedWith);
        });

    async function execute(
        endpoint: string,
        options: {
            method?: string;
            input?: string;
            include?: true;
            silent?: true;
            verbose?: true;
            paginate?: true;
            slurp?: true;
            jq?: string;
            idempotencyKey?: string;
            confirm?: true;
            session?: true;
            email?: string;
            passwordFile?: string;
            controller?: string;
        },
        command: Command<any, any, any>,
        holder: { flow?: SessionFlow },
    ) {
        {
            const { profile } = command.optsWithGlobals() as { profile?: string };
            if (!options.session) {
                for (const [flag, value] of [
                    ["--email", options.email],
                    ["--password-file", options.passwordFile],
                    ["--controller", options.controller],
                ] as const) {
                    if (value !== undefined) throw bad(`${flag} needs --session.`);
                }
            } else {
                refuseWithKey(io.context, "--session");
                if (options.email === undefined) {
                    throw bad("--session needs --email <address> to sign in.");
                }
            }
            const email = options.session ? checkEmail(options.email!) : null;
            const method = (
                options.method ?? (fields.length > 0 || options.input ? "POST" : "GET")
            ).toUpperCase();
            if (!RAW_METHODS.has(method)) {
                throw bad("The method must be GET, HEAD, POST, PUT, PATCH or DELETE.");
            }
            const reads = method === "GET" || method === "HEAD";
            if (!reads) requireConfirmation(options.confirm);
            if (options.paginate && method !== "GET") throw bad("--paginate needs the GET method.");
            if (options.slurp && !options.paginate) throw bad("--slurp needs --paginate.");
            if (options.paginate && options.include) {
                throw bad("--include cannot be combined with --paginate.");
            }
            if (endpoint.includes("#")) throw bad("The endpoint must not contain a fragment.");

            // An explicit --jq, even an empty one, is checked before anything else is sent or
            // looked up; an omitted one is not.
            const engine =
                options.jq !== undefined
                    ? chooseJq(
                          io.context.env.PATH,
                          (name, searchPath) =>
                              io.findExecutable?.(name) ?? findOnPath(name, searchPath),
                      )
                    : undefined;
            if (engine) await checkJq(engine, options.jq!);
            if (engine && options.verbose) {
                io.err(
                    `> jq: ${engine.kind === "system" ? engine.file : "built-in micro-jq subset"}`,
                );
            }

            // Placeholders are resolved only when used, so a plain call needs no extra request.
            const used = new Set<string>();
            for (const text of [
                endpoint,
                // A `-F k=@file` value is a path, never substituted, so it needs no lookup.
                ...fields
                    .map((f) => ({ typed: f.typed, value: f.text.slice(f.text.indexOf("=") + 1) }))
                    .filter((f) => !(f.typed && f.value.startsWith("@")))
                    .map((f) => f.value),
            ]) {
                for (const match of text.matchAll(PLACEHOLDER)) used.add(match[1]!);
            }
            const workingDir = io.workingDir ?? process.cwd();
            // One read of launchpad.json and one resolution of the saved profile serve both
            // placeholders and the request, so a concurrent edit or login cannot mix them.
            const workspace = await readWorkspace(workingDir);
            let identity: Promise<Backend> | undefined;
            const identify = () =>
                (identity ??= options.session
                    ? sessionBackend()
                    : (async (): Promise<Backend> => {
                          const resolved = await resolve(
                              io.context,
                              profile ?? workspace.config?.profile,
                          );
                          const client = clientFor(io.context, resolved);
                          return {
                              controller: resolved.controller,
                              organizationId: resolved.organizationId,
                              organizations: () => client.organizations.list(),
                              ownOrganization: async () => (await client.key.get()).organizationId,
                              raw: (method, path, rawOptions) =>
                                  client.raw(method, path, rawOptions),
                              credentialLines: ["> authorization: [redacted]"],
                          };
                      })());
            const sessionBackend = async (): Promise<Backend> => {
                const target = await resolveSessionTarget(io.context, {
                    controller: options.controller,
                    profile: profile ?? workspace.config?.profile,
                });
                const flow = new SessionFlow({
                    io,
                    controller: target.controller,
                    email: email!,
                    passwordFile: options.passwordFile,
                    verbose: options.verbose,
                    remember,
                });
                holder.flow = flow;
                const raw = async (method: string, path: string, rawOptions: RawOptions) => {
                    const client = await flow.signIn();
                    return client.raw(method, path, {
                        ...rawOptions,
                        signal: rawOptions.signal
                            ? AbortSignal.any([flow.signal, rawOptions.signal])
                            : flow.signal,
                    });
                };
                return {
                    controller: target.controller,
                    organizationId: target.organizationId,
                    organizations: async () => {
                        const response = await raw("GET", "/organizations", {});
                        const list: unknown = JSON.parse(response.body);
                        if (!Array.isArray(list))
                            throw bad("The organization list was not a list.");
                        return list.filter(
                            (o): o is { id: string; slug: string } =>
                                typeof o?.id === "string" && typeof o?.slug === "string",
                        );
                    },
                    ownOrganization: async () => {
                        throw bad(
                            "{org} has no value: with --session select an organization with `launchpad org use`, launchpad.json or LAUNCHPAD_ORG.",
                        );
                    },
                    raw,
                    credentialLines: [
                        "> cookie: [redacted]",
                        `> origin: ${new URL(target.controller).origin}`,
                    ],
                };
            };
            const values = new Map<string, string>();
            if (used.has("org")) {
                const backend = await identify();
                const named = workspace.config?.organization;
                if (named) {
                    const match = (await backend.organizations()).find(
                        (o) => o.id === named || o.slug === named,
                    );
                    if (!match) {
                        throw new ClientCoreError(
                            "no-organization",
                            "This key cannot see the selected organization.",
                        );
                    }
                    values.set("org", match.id);
                } else {
                    values.set("org", backend.organizationId ?? (await backend.ownOrganization()));
                }
            }
            if (used.has("project")) {
                const project = workspace.config?.project;
                if (!project) throw bad("{project} needs a launchpad.json with a project.");
                values.set("project", project);
            }
            const fill = (text: string, encode: boolean) =>
                text.replace(PLACEHOLDER, (_m, name: string) => {
                    const value = values.get(name);
                    if (!value) throw bad(`{${name}} has no value here.`);
                    if (!encode) return value;
                    if (value === "." || value === "..")
                        throw bad(`{${name}} is not a valid path segment.`);
                    return encodeURIComponent(value);
                });

            const stdinUsed = { value: false };
            const readData = async (source: string) => {
                if (source === "-") {
                    if (stdinUsed.value) throw bad("Standard input can be read only once.");
                    stdinUsed.value = true;
                }
                try {
                    return await io.readData(source);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "unreadable";
                    throw bad(
                        source === "-"
                            ? `Could not read standard input: ${reason}`
                            : `Could not read the data file: ${/ENOENT/.test(reason) ? "not found" : reason}`,
                    );
                }
            };
            const asText = async (source: string) => {
                try {
                    return new TextDecoder("utf-8", { fatal: true }).decode(await readData(source));
                } catch (error) {
                    if (error instanceof ClientCoreError) throw error;
                    throw bad("A field value read from a file or stdin must be UTF-8 text.");
                }
            };
            const parsed = await parseFields(fields, {
                readFile: asText,
                readStdin: () => asText("-"),
                fill: (text) => fill(text, false),
            });

            const [rawPath = "", rawQuery = ""] = (() => {
                const at = endpoint.indexOf("?");
                return at === -1 ? [endpoint] : [endpoint.slice(0, at), endpoint.slice(at + 1)];
            })();
            const filled = fill(rawPath, true);
            const path = filled.startsWith("/") ? filled : `/${filled}`;
            // Pairs are split first, so a value holding `&` or `=` stays one value.
            const query: Array<[string, string]> = [...new URLSearchParams(rawQuery).entries()].map(
                ([k, v]) => [k, fill(v, false)],
            );
            let body: string | Uint8Array | undefined;
            if (options.input !== undefined) {
                body = await readData(options.input);
                query.push(...fieldsToQuery(parsed));
            } else if (reads) {
                query.push(...fieldsToQuery(parsed));
            } else if (Object.keys(parsed).length > 0) {
                body = JSON.stringify(parsed);
            }
            const extraHeaders: Record<string, string> = {};
            for (const header of headers) {
                const colon = header.indexOf(":");
                if (colon < 1) throw bad("A header is written name:value.");
                extraHeaders[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
            }
            if (
                body !== undefined &&
                !Object.keys(extraHeaders).some((n) => n.toLowerCase() === "content-type")
            ) {
                try {
                    JSON.parse(
                        typeof body === "string"
                            ? body
                            : new TextDecoder("utf-8", { fatal: true }).decode(body),
                    );
                } catch {
                    throw bad(
                        "The request body is not valid JSON; set a content-type with -H to send it anyway.",
                    );
                }
            }

            // The request is already sent when this runs, so a failure is not a usage error.
            const filter = async (text: string) => {
                if (!engine) return pretty(text);
                try {
                    return await applyJq(engine, options.jq!, text);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : "failed";
                    throw new Error(`The request succeeded; the --jq filter failed: ${reason}`);
                }
            };
            const backend = await identify();
            // The request is shown before it is sent, so --verbose helps when it fails.
            const showRequest = (shownPath: string) => {
                if (!options.verbose) return;
                const url = new URL(`${normalizeBaseUrl(backend.controller)}/api/v1${shownPath}`);
                io.err(`> ${method} ${url.pathname}${url.search}`);
                io.err(`> host: ${url.host}`);
                for (const line of backend.credentialLines) io.err(line);
                for (const [name, value] of Object.entries(extraHeaders)) {
                    const lower = name.toLowerCase();
                    // A header the SDK refuses may carry a credential; never echo it.
                    io.err(
                        `> ${lower}: ${FORBIDDEN_RAW_HEADERS.has(lower) ? "[redacted]" : value}`,
                    );
                }
                if (options.idempotencyKey) io.err(`> idempotency-key: ${options.idempotencyKey}`);
            };
            const showResponse = (response: RawResponse) => {
                if (!options.verbose) return;
                io.err(`< HTTP ${response.status}`);
                for (const line of headerLines(response.headers)) io.err(`< ${line}`);
            };
            const request = (pageQuery: Array<[string, string]>) =>
                `${path}${pageQuery.length ? `?${new URLSearchParams(pageQuery)}` : ""}`;
            const call = (pageQuery: Array<[string, string]>, signal?: AbortSignal) => {
                showRequest(request(pageQuery));
                return backend.raw(method, path, {
                    query: pageQuery,
                    body,
                    headers: extraHeaders,
                    idempotencyKey: options.idempotencyKey,
                    signal,
                });
            };

            if (!options.paginate) {
                const response = await call(query);
                showResponse(response);
                if (options.include) {
                    io.out(
                        [`HTTP ${response.status}`, ...headerLines(response.headers), ""].join(
                            "\n",
                        ),
                    );
                }
                if (!options.silent && response.body.length > 0)
                    io.out(await filter(response.body));
                return;
            }

            // Pages are merged as text, so numbers keep the digits the controller sent.
            const pages: string[][] = [];
            const seen = new Set<string>();
            let pageQuery = query;
            seen.add(new URLSearchParams(query).toString());
            let total = 0;
            let totalBytes = 0;
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(), PAGINATE_DEADLINE_MS);
            try {
                for (;;) {
                    let response: RawResponse;
                    try {
                        response = await call(pageQuery, deadline.signal);
                    } catch (error) {
                        if (deadline.signal.aborted) {
                            throw new LaunchpadTransportError(
                                "timeout",
                                "--paginate took longer than 5 minutes; stopped.",
                            );
                        }
                        throw error;
                    }
                    showResponse(response);
                    let items: string[] | null;
                    try {
                        items = arrayItems(response.body);
                    } catch {
                        items = null;
                    }
                    if (!items) throw bad("--paginate needs an endpoint that returns a list.");
                    totalBytes += Buffer.byteLength(response.body);
                    if (totalBytes > MAX_TOTAL_BYTES) {
                        throw bad("The list is larger than --paginate will collect (16 MiB).");
                    }
                    pages.push(items);
                    total += items.length;
                    if (total > MAX_TOTAL_ITEMS)
                        throw bad("The list is longer than --paginate will collect.");
                    if (!response.next) break;
                    const key = new URLSearchParams(response.next).toString();
                    if (seen.has(key) || pages.length >= MAX_PAGES) {
                        throw bad("The controller's paging did not end; stopped.");
                    }
                    seen.add(key);
                    pageQuery = response.next;
                }
            } finally {
                clearTimeout(timer);
            }
            if (!options.silent) {
                const merged = options.slurp
                    ? `[${pages.map((page) => `[${page.join(",")}]`).join(",")}]`
                    : `[${pages.flat().join(",")}]`;
                io.out(await filter(merged));
            }
        }
    }
}
