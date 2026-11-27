// The npm packages run on Node as well as Bun, so their source may not use an API only Bun has.
// Code bundled into the Docker images (controller, worker, router, ...) is not covered.
// Which packages: the ones tooling/package-clients.ts packs, plus client-core, which is bundled
// into the CLI and the MCP server. See docs/releasing.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TARGETS } from "./package-clients";

export const PUBLISHED_DIRS = [...TARGETS.map((target) => target.dir), "packages/client-core"];

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function* sources(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "node_modules") yield* sources(file);
        } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) yield file;
    }
}

interface Token {
    kind: "id" | "num" | "str" | "punct";
    text: string;
    line: number;
    // `)` only: it closes the header of an `if`, `while`, `for` or `with`.
    controlClose?: boolean;
}

export interface Tokens {
    tokens: Token[];
    // Text the tokenizer could not finish; the scan treats it as a failure, never as a pass.
    errors: { line: number; what: string }[];
}

// Keywords after which a `/` starts a regular expression rather than dividing. (`of` is one only
// as the separator of a `for` header; a word after `.` or `?.` is a property, not a keyword.)
const BEFORE_REGEX = new Set([
    "return",
    "typeof",
    "case",
    "delete",
    "void",
    "throw",
    "new",
    "in",
    "instanceof",
    "yield",
    "await",
    "else",
    "do",
]);
const CONTROL = new Set(["if", "while", "for", "with"]);
const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const COMPOUND = new Set(["?.", "??", "++", "--"]);

// A small JavaScript/TypeScript tokenizer: comments are dropped, and the contents of string,
// template and regular-expression literals are never tokens (only a plain string's text is kept,
// so module specifiers can be checked). TypeScript 7 has no JavaScript API to use instead.
//
// A `/` is a regular expression after an operator, `(`, `,`, `;`, `=>` or a keyword, and a
// division after a name, number, string, `]`, `}` or a `)` that is not a control header. After
// `}` it is read as division on purpose: if that is wrong the regex body is scanned as code (a
// possible false alarm), whereas the other mistake would hide real code inside a "regex".
export function tokenize(text: string): Tokens {
    const tokens: Token[] = [];
    const errors: Tokens["errors"] = [];
    // One entry per open template literal: the number of unclosed `{` inside its `${ }`.
    const templates: number[] = [];
    // One entry per open `(`, `[` or `{`: what a `)` closing it means.
    const brackets: { control: boolean; isFor: boolean }[] = [];
    let line = 1;
    let i = 0;
    const push = (kind: Token["kind"], value: string, extra?: Partial<Token>) =>
        tokens.push({ kind, text: value, line, ...extra });
    const error = (at: number, what: string) => errors.push({ line: at, what });
    const isProperty = (index: number) =>
        tokens[index - 1]?.text === "." || tokens[index - 1]?.text === "?.";
    const regexAllowed = () => {
        const index = tokens.length - 1;
        const previous = tokens[index];
        if (!previous) return true;
        if (previous.kind === "num" || previous.kind === "str") return false;
        if (previous.kind === "id") {
            if (isProperty(index)) return false;
            if (previous.text === "of") {
                return brackets[brackets.length - 1]?.isFor === true;
            }
            return BEFORE_REGEX.has(previous.text);
        }
        if (previous.text === ")") return previous.controlClose === true;
        return !["]", "}"].includes(previous.text);
    };
    const template = () => {
        // `i` is just after the opening backtick or the closing brace of a `${ }`.
        const opened = line;
        while (i < text.length) {
            const c = text[i]!;
            if (c === "\n") line++;
            if (c === "\\") i += 2;
            else if (c === "`") return void i++;
            else if (c === "$" && text[i + 1] === "{") {
                templates.push(0);
                i += 2;
                return;
            } else i++;
        }
        error(opened, "an unterminated template literal");
    };
    while (i < text.length) {
        const c = text[i]!;
        if (c === "\n") {
            line++;
            i++;
        } else if (/\s/.test(c)) i++;
        else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
        } else if (c === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            if (end < 0) error(line, "an unterminated block comment");
            const stop = end < 0 ? text.length : end + 2;
            for (const ch of text.slice(i, stop)) if (ch === "\n") line++;
            i = stop;
        } else if (c === '"' || c === "'") {
            let value = "";
            i++;
            while (i < text.length && text[i] !== c && text[i] !== "\n") {
                if (text[i] === "\\") i++;
                value += text[i] ?? "";
                i++;
            }
            if (text[i] !== c) error(line, "an unterminated string literal");
            i++;
            push("str", value);
        } else if (c === "`") {
            const opened = line;
            i++;
            template();
            tokens.push({ kind: "str", text: "", line: opened });
        } else if (c === "}" && templates.length > 0 && templates[templates.length - 1] === 0) {
            templates.pop();
            i++;
            template();
        } else if (ID_START.test(c)) {
            const start = i;
            while (i < text.length && ID_PART.test(text[i]!)) i++;
            push("id", text.slice(start, i));
        } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
            const start = i;
            i++;
            while (i < text.length && /[\w.]/.test(text[i]!)) i++;
            push("num", text.slice(start, i));
        } else if (c === "/" && regexAllowed()) {
            const opened = line;
            let inClass = false;
            i++;
            while (i < text.length && text[i] !== "\n" && (inClass || text[i] !== "/")) {
                if (text[i] === "\\") i++;
                else if (text[i] === "[") inClass = true;
                else if (text[i] === "]") inClass = false;
                i++;
            }
            if (text[i] !== "/") error(opened, "an unterminated regular expression");
            i++;
            while (i < text.length && /[a-z]/i.test(text[i]!)) i++;
            tokens.push({ kind: "str", text: "", line: opened });
        } else {
            if (templates.length > 0) {
                if (c === "{") templates[templates.length - 1]!++;
                else if (c === "}") templates[templates.length - 1]!--;
            }
            const two = text.slice(i, i + 2);
            const op = COMPOUND.has(two) ? two : c;
            if (c === "(") {
                const previous = tokens[tokens.length - 1];
                const index = tokens.length - 1;
                const header =
                    previous?.kind === "id" && !isProperty(index) && CONTROL.has(previous.text);
                const forAwait =
                    previous?.text === "await" &&
                    tokens[index - 1]?.text === "for" &&
                    !isProperty(index - 1);
                brackets.push({
                    control: header || forAwait,
                    isFor: (header && previous?.text === "for") || forAwait,
                });
                push("punct", op);
            } else if (c === "[" || c === "{") {
                brackets.push({ control: false, isFor: false });
                push("punct", op);
            } else if (c === ")" || c === "]" || c === "}") {
                const closed = brackets.pop();
                push("punct", op, c === ")" ? { controlClose: closed?.control === true } : {});
            } else push("punct", op);
            i += op.length;
        }
    }
    return { tokens, errors };
}

// Problems as "file:line: message" for one file's text.
export function scan(file: string, text: string): string[] {
    const { tokens, errors } = tokenize(text);
    const problems: string[] = [];
    const report = (line: number, what: string) =>
        problems.push(`${file}:${line}: ${what}; the npm packages must run on Node`);
    for (const { line, what } of errors) {
        problems.push(`${file}:${line}: ${what}; the file cannot be scanned, so it is not trusted`);
    }
    const at = (index: number) => tokens[index]?.text;
    // Per open bracket, the `?` of a ternary still waiting for its `:`.
    const pending = [0];
    tokens.forEach((token, i) => {
        const { kind, text: value, line } = token;
        if (kind === "punct") {
            if ("([{".includes(value)) pending.push(0);
            else if (")]}".includes(value) && pending.length > 1) pending.pop();
            else if (value === "?") pending[pending.length - 1]!++;
            else if (value === ":" && pending[pending.length - 1]! > 0)
                pending[pending.length - 1]!--;
            return;
        }
        if (kind === "str") {
            // Module specifiers only: `from "x"`, `import "x"`, `import("x")`, `require("x")`.
            const before = at(i - 1);
            const specifier =
                before === "from" ||
                before === "import" ||
                (before === "(" && (at(i - 2) === "import" || at(i - 2) === "require"));
            if (specifier && /^bun(?::.*)?$/.test(value)) {
                report(line, 'a "bun" or "bun:*" module specifier');
            }
            return;
        }
        const before = at(i - 1);
        if (value === "Bun") {
            if (before === ".") {
                if (at(i - 2) === "globalThis") report(line, "globalThis.Bun");
            } else if (at(i + 1) !== ":" || pending[pending.length - 1]! > 0) {
                // `{ Bun: 1 }` is a key; `cond ? Bun : x` is a use.
                report(line, "the Bun global");
            }
        } else if (value === "bun" && before === "." && at(i - 2) === "versions") {
            if (at(i - 3) === "." && at(i - 4) === "process") report(line, "process.versions.bun");
        } else if (value === "meta" && before === "." && at(i - 2) === "import") {
            if (at(i + 1) === "." && ["dir", "file", "path"].includes(at(i + 2) ?? "")) {
                report(line, "a Bun-only import.meta property");
            }
        }
    });
    return problems;
}

export function checkRuntimeAgnostic(root: string, dirs = PUBLISHED_DIRS): string[] {
    const problems: string[] = [];
    for (const dir of dirs) {
        const src = path.join(root, dir, "src");
        if (!existsSync(src)) {
            problems.push(`${dir}/src does not exist`);
            continue;
        }
        for (const file of sources(src)) {
            problems.push(...scan(path.relative(root, file), readFileSync(file, "utf8")));
        }
    }
    return problems;
}

if (import.meta.main) {
    const problems = checkRuntimeAgnostic(path.resolve(import.meta.dirname, ".."));
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log(`The published packages use no Bun-only API (${PUBLISHED_DIRS.join(", ")}).`);
}
