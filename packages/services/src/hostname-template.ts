import { PREVIEW_DOMAIN_PATTERN, opaqueId } from "./previews";
import { ServiceError } from "./errors";

// Generated hostnames for immutable deployments and their aliases (docs/design/deployment-modes.md,
// "Configurable hostname templates"). A template names one DNS label with the tokens {slug} and
// {id}, each exactly once; the configured apps domain is appended. Nothing here reads the
// environment or the database: callers supply the template, the domain and the collision check.

export const HOSTNAME_ID_LENGTH = 10;
export const MAX_HOSTNAME_SLUG_LENGTH = 40;
export const MAX_DNS_LABEL_LENGTH = 63;
export const MAX_HOSTNAME_LENGTH = 253;
export const MAX_ALLOCATION_ATTEMPTS = 5;

const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const ID = /^[a-z0-9]{10}$/;
const LITERAL = /^[a-z0-9-]*$/;
const TOKEN = /\{([^{}]*)\}/g;

export interface HostnameTemplate {
    readonly source: string;
    readonly parts: readonly ("slug" | "id" | { readonly literal: string })[];
}

export class HostnameTemplateError extends Error {
    override name = "HostnameTemplateError";
}

// A template that cannot produce a valid label for every slug and id, or whose worst case does
// not fit, is refused here (at startup) rather than truncated at allocation time.
export function parseHostnameTemplate(source: string, domain: string): HostnameTemplate {
    if (!PREVIEW_DOMAIN_PATTERN.test(domain)) {
        throw new HostnameTemplateError("The apps domain is not a valid lowercase domain name.");
    }
    if (source === "") throw new HostnameTemplateError("The hostname template is empty.");
    const parts: ("slug" | "id" | { literal: string })[] = [];
    const seen = new Set<string>();
    let literalLength = 0;
    let last = 0;
    for (const match of source.matchAll(TOKEN)) {
        const name = match[1]!;
        if (name !== "slug" && name !== "id") {
            throw new HostnameTemplateError(`Unknown token {${name}}: only {slug} and {id}.`);
        }
        if (seen.has(name)) throw new HostnameTemplateError(`{${name}} must appear exactly once.`);
        seen.add(name);
        const literal = source.slice(last, match.index);
        if (literal !== "") parts.push({ literal });
        literalLength += literal.length;
        parts.push(name);
        last = match.index + match[0].length;
    }
    const tail = source.slice(last);
    if (tail !== "") parts.push({ literal: tail });
    literalLength += tail.length;
    if (!seen.has("slug") || !seen.has("id")) {
        throw new HostnameTemplateError("The template needs both {slug} and {id}.");
    }
    for (const part of parts) {
        if (typeof part === "string") continue;
        if (!LITERAL.test(part.literal) || part.literal.includes("--")) {
            throw new HostnameTemplateError(
                "Literal text may hold only lowercase letters, digits and single hyphens.",
            );
        }
    }
    const first = parts[0]!;
    const final = parts[parts.length - 1]!;
    if (typeof first !== "string" && first.literal.startsWith("-")) {
        throw new HostnameTemplateError("The label cannot start with a hyphen.");
    }
    if (typeof final !== "string" && final.literal.endsWith("-")) {
        throw new HostnameTemplateError("The label cannot end with a hyphen.");
    }
    if (typeof first !== "string" && first.literal.startsWith("xn")) {
        throw new HostnameTemplateError("The label cannot start with xn (reserved).");
    }
    const worstLabel = literalLength + MAX_HOSTNAME_SLUG_LENGTH + HOSTNAME_ID_LENGTH;
    if (worstLabel > MAX_DNS_LABEL_LENGTH) {
        throw new HostnameTemplateError(
            `The label can reach ${worstLabel} characters; DNS allows ${MAX_DNS_LABEL_LENGTH}.`,
        );
    }
    if (worstLabel + 1 + domain.length > MAX_HOSTNAME_LENGTH) {
        throw new HostnameTemplateError("The hostname can exceed 253 characters with this domain.");
    }
    return { source, parts };
}

export function renderHostname(
    template: HostnameTemplate,
    input: { slug: string; id: string; domain: string },
): string {
    if (!SLUG.test(input.slug)) throw new HostnameTemplateError("The slug is not valid.");
    if (!ID.test(input.id)) throw new HostnameTemplateError("The id is not valid.");
    const label = template.parts
        .map((part) => (part === "slug" ? input.slug : part === "id" ? input.id : part.literal))
        .join("");
    return `${label}.${input.domain}`;
}

// The hostname's random token: ten lowercase base36 characters, not a UUID and not the
// six-character token of legacy preview hostnames.
export const newHostnameId = () => opaqueId(HOSTNAME_ID_LENGTH);

// Allocates a hostname that `isTaken` (the shared reservation registry) does not hold, with a
// fresh id each time and at most five tries. It never truncates or reuses a hostname.
export async function allocateHostname(options: {
    template: HostnameTemplate;
    domain: string;
    slug: string;
    isTaken: (hostname: string) => boolean | Promise<boolean>;
    makeId?: () => string;
}): Promise<{ hostname: string; id: string }> {
    const makeId = options.makeId ?? newHostnameId;
    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt++) {
        const id = makeId();
        const hostname = renderHostname(options.template, {
            slug: options.slug,
            id,
            domain: options.domain,
        });
        if (!(await options.isTaken(hostname))) return { hostname, id };
    }
    throw new ServiceError("conflict", "A free hostname could not be allocated; try again.");
}
