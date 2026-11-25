import { ClientCoreError } from "./errors";

export interface FieldInput {
    // `-f` keeps the value a string; `-F` converts true, false, null and integers, and reads
    // `@path` and `@-`.
    typed: boolean;
    // `key=value`, or a bare `key[]` for an empty array.
    text: string;
}

export interface FieldSources {
    // Applied to a string value after `@` and typing are decided, never to file contents or
    // keys, so a substituted value cannot read a file or become a number or boolean.
    fill?(text: string): string;
    readFile(path: string): Promise<string>;
    readStdin(): Promise<string>;
}

const MAX_FIELDS = 200;
const MAX_DEPTH = 8;
const KEY = /^([^[\]=]+)((?:\[[^[\]=]*\])*)$/;

const bad = (message: string) => new ClientCoreError("bad-input", message);

type Node = { [key: string]: unknown };

async function value(input: FieldInput, text: string, sources: FieldSources): Promise<unknown> {
    const fill = sources.fill ?? ((t: string) => t);
    if (!input.typed) return fill(text);
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null") return null;
    if (/^-?\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
    if (text.startsWith("@")) {
        const source = text.slice(1);
        if (!source) throw bad("A field value of @ needs a file path, or @- for standard input.");
        return source === "-" ? sources.readStdin() : sources.readFile(source);
    }
    return fill(text);
}

// Builds the request parameters from `-f` and `-F` entries, as `gh api` does: `a[b]=c`
// nests, repeated `a[]=x` builds an array, a bare `a[]` is an empty array. Values are never
// interpreted as anything but data.
export async function parseFields(
    inputs: readonly FieldInput[],
    sources: FieldSources,
): Promise<Node> {
    if (inputs.length > MAX_FIELDS) throw bad(`At most ${MAX_FIELDS} fields are accepted.`);
    const root: Node = Object.create(null);
    for (const input of inputs) {
        const eq = input.text.indexOf("=");
        const keyText = eq === -1 ? input.text : input.text.slice(0, eq);
        const match = KEY.exec(keyText);
        if (!match) throw bad(`The field "${keyText.slice(0, 40)}" is not a valid parameter name.`);
        const segments = [
            match[1]!,
            ...[...match[2]!.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]!),
        ];
        if (segments.length > MAX_DEPTH) throw bad("A field is nested too deeply.");
        if (segments.some((s) => s === "__proto__" || s === "constructor" || s === "prototype")) {
            throw bad("That parameter name is not allowed.");
        }
        if (eq === -1 && segments[segments.length - 1] !== "") {
            throw bad(`The field "${keyText.slice(0, 40)}" needs a value (key=value).`);
        }
        if (segments.slice(0, -1).includes("")) {
            throw bad("An array marker [] is allowed only at the end of a field name.");
        }
        const leaf = eq === -1 ? undefined : await value(input, input.text.slice(eq + 1), sources);
        let node: Node = root;
        for (let i = 0; i < segments.length - 1; i++) {
            const name = segments[i]!;
            const last = i === segments.length - 2;
            if (last && segments[i + 1] === "") {
                const existing = node[name];
                if (existing === undefined) node[name] = [];
                else if (!Array.isArray(existing)) throw bad(`The field "${name}" is used twice.`);
                if (leaf !== undefined) (node[name] as unknown[]).push(leaf);
                node = root;
                break;
            }
            const next = node[name];
            if (next === undefined) node = node[name] = Object.create(null) as Node;
            else if (typeof next === "object" && next !== null && !Array.isArray(next)) {
                node = next as Node;
            } else throw bad(`The field "${name}" is used twice.`);
        }
        if (segments.length === 1) {
            if (Object.hasOwn(root, segments[0]!) && root[segments[0]!] !== undefined) {
                throw bad(`The field "${segments[0]}" is used twice.`);
            }
            root[segments[0]!] = leaf;
        } else if (segments[segments.length - 1] !== "") {
            const name = segments[segments.length - 1]!;
            if (Object.hasOwn(node, name)) throw bad(`The field "${name}" is used twice.`);
            node[name] = leaf;
        }
    }
    return root;
}

// The query string form of fields, for requests that have no body: nested keys read `a[b]`
// and array items `a[]`, as `gh api` sends them.
export function fieldsToQuery(fields: Node, prefix = ""): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (const [key, item] of Object.entries(fields)) {
        const name = prefix ? `${prefix}[${key}]` : key;
        if (Array.isArray(item)) {
            for (const element of item) pairs.push([`${name}[]`, String(element)]);
        } else if (typeof item === "object" && item !== null) {
            pairs.push(...fieldsToQuery(item as Node, name));
        } else pairs.push([name, String(item)]);
    }
    return pairs;
}
