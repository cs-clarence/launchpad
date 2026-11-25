// A small JSON reader that keeps the original text of every value, so a number such as
// 9007199254740993 or 1.0 is printed and merged exactly as the controller sent it.
// JSON.parse would round it. Strings keep their original escapes.

type Node =
    | { kind: "scalar"; start: number; end: number }
    | { kind: "array"; start: number; end: number; items: Node[] }
    | { kind: "object"; start: number; end: number; entries: Array<[Node, Node]> };

const MAX_DEPTH = 512;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function parseTree(text: string): Node {
    let i = 0;
    const fail = () => new SyntaxError("Invalid JSON");
    const ws = () => {
        while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
    };
    const string = (): Node => {
        const start = i++;
        for (;;) {
            const c = text[i];
            if (c === undefined || c < " ") throw fail();
            if (c === '"') return { kind: "scalar", start, end: ++i };
            if (c === "\\") {
                const e = text[i + 1];
                if (e === "u") {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw fail();
                    i += 6;
                } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
                else throw fail();
            } else i++;
        }
    };
    const value = (depth: number): Node => {
        if (depth >= MAX_DEPTH) throw fail();
        ws();
        const c = text[i];
        const start = i;
        if (c === '"') return string();
        if (c === "[") {
            i++;
            const items: Node[] = [];
            ws();
            if (text[i] === "]") return { kind: "array", start, end: ++i, items };
            for (;;) {
                items.push(value(depth + 1));
                ws();
                if (text[i] === ",") i++;
                else if (text[i] === "]") return { kind: "array", start, end: ++i, items };
                else throw fail();
            }
        }
        if (c === "{") {
            i++;
            const entries: Array<[Node, Node]> = [];
            ws();
            if (text[i] === "}") return { kind: "object", start, end: ++i, entries };
            for (;;) {
                ws();
                if (text[i] !== '"') throw fail();
                const key = string();
                ws();
                if (text[i++] !== ":") throw fail();
                entries.push([key, value(depth + 1)]);
                ws();
                if (text[i] === ",") i++;
                else if (text[i] === "}") return { kind: "object", start, end: ++i, entries };
                else throw fail();
            }
        }
        for (const literal of ["true", "false", "null"]) {
            if (text.startsWith(literal, i)) {
                i += literal.length;
                return { kind: "scalar", start, end: i };
            }
        }
        NUMBER.lastIndex = i;
        const match = NUMBER.exec(text);
        if (!match) throw fail();
        i += match[0].length;
        return { kind: "scalar", start, end: i };
    };
    const root = value(0);
    ws();
    if (i !== text.length) throw fail();
    return root;
}

// The text of each element of a top-level JSON array, or null if `text` is not one.
// Throws SyntaxError for text that is not JSON.
export function arrayItems(text: string): string[] | null {
    const root = parseTree(text);
    return root.kind === "array" ? root.items.map((n) => text.slice(n.start, n.end)) : null;
}

// Indented like JSON.stringify(value, null, 2), with every token as it was written.
// Throws SyntaxError for text that is not JSON.
export function prettyJson(text: string): string {
    const root = parseTree(text);
    const out: string[] = [];
    const emit = (node: Node, level: number) => {
        const pad = "  ".repeat(level + 1);
        const end = "  ".repeat(level);
        if (node.kind === "scalar") out.push(text.slice(node.start, node.end));
        else if (node.kind === "array") {
            if (node.items.length === 0) return void out.push("[]");
            out.push("[\n");
            node.items.forEach((item, n) => {
                out.push(pad);
                emit(item, level + 1);
                out.push(n < node.items.length - 1 ? ",\n" : "\n");
            });
            out.push(`${end}]`);
        } else {
            if (node.entries.length === 0) return void out.push("{}");
            out.push("{\n");
            node.entries.forEach(([key, item], n) => {
                out.push(pad, text.slice(key.start, key.end), ": ");
                emit(item, level + 1);
                out.push(n < node.entries.length - 1 ? ",\n" : "\n");
            });
            out.push(`${end}}`);
        }
    };
    emit(root, 0);
    return out.join("");
}
