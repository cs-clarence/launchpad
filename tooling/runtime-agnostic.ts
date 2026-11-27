// The npm packages run on Node as well as Bun, so their source may not use an API only Bun has.
// Code bundled into the Docker images (controller, worker, router, ...) is not covered.
// Which packages: the ones tooling/package-clients.ts packs, plus client-core, which is bundled
// into the CLI and the MCP server. See docs/releasing.md.
//
// The scan walks the syntax tree (TypeScript 6, the version of the compiler with a JavaScript API;
// the `typescript` 7 package has none), so comments, string contents and regular expressions
// are never mistaken for code. It leans towards false alarms: a missed Bun API is the failure.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { TARGETS } from "./package-clients";

export const PUBLISHED_DIRS = [...TARGETS.map((target) => target.dir), "packages/client-core"];

// What Node 22.12 has: `import.meta.main` (Node 24.2) and Bun's `dir`, `file`, `path`, `require`
// are not here.
const IMPORT_META = new Set(["url", "dirname", "filename", "resolve"]);
// A name on these is the global object, so `.Bun` on one of them is the Bun global.
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);
const BUN_STRING = /^(?:bun|Bun)$|^bun:/;

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function* sources(dir: string, problems: string[], seen = new Set<string>()): Generator<string> {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        let stat;
        try {
            // Follows a symbolic link, so a linked file or directory is scanned like any other.
            stat = statSync(file);
        } catch {
            problems.push(`${file}: cannot be read (a broken link?), so it is not trusted`);
            continue;
        }
        if (stat.isDirectory()) {
            if (entry.name !== "__tests__" && entry.name !== "node_modules") {
                yield* sources(file, problems, seen);
            }
        } else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) yield file;
    }
}

const kindOf = (file: string) =>
    file.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : file.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : /\.[cm]?js$/.test(file)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

// Problems as "file:line: message" for one file's text.
export function scan(file: string, text: string): string[] {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
    const problems: string[] = [];
    const lineOf = (position: number) =>
        sourceFile.getLineAndCharacterOfPosition(position).line + 1;
    const report = (node: ts.Node, what: string) =>
        problems.push(
            `${file}:${lineOf(node.getStart(sourceFile))}: ${what}; the npm packages must run on Node`,
        );

    // A file that does not parse cannot be trusted: fail closed.
    const syntax = (sourceFile as unknown as { parseDiagnostics: ts.Diagnostic[] })
        .parseDiagnostics;
    for (const diagnostic of syntax) {
        problems.push(
            `${file}:${lineOf(diagnostic.start ?? 0)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; the file cannot be scanned, so it is not trusted`,
        );
    }

    const isStatic = (node: ts.Node | undefined): node is ts.StringLiteralLike =>
        node !== undefined && ts.isStringLiteralLike(node);

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const name = node.text;
            const parent = node.parent;
            if (name === "Bun") {
                // A member or key named Bun is harmless; the global and its aliases are not.
                const member =
                    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
                    (ts.isQualifiedName(parent) && parent.right === node) ||
                    (ts.isPropertyAssignment(parent) && parent.name === node) ||
                    (ts.isPropertySignature(parent) && parent.name === node) ||
                    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
                    (ts.isMethodDeclaration(parent) && parent.name === node) ||
                    (ts.isMethodSignature(parent) && parent.name === node) ||
                    (ts.isEnumMember(parent) && parent.name === node) ||
                    (ts.isJsxAttribute(parent) && parent.name === node);
                const onGlobal =
                    ts.isPropertyAccessExpression(parent) &&
                    parent.name === node &&
                    ts.isIdentifier(parent.expression) &&
                    GLOBAL_OBJECTS.has(parent.expression.text);
                if (!member) report(node, "the Bun global");
                else if (onGlobal) report(node, `${parent.expression.getText(sourceFile)}.Bun`);
            } else if (
                (name === "eval" || name === "Function") &&
                !(ts.isPropertyAccessExpression(parent) && parent.name === node)
            ) {
                report(node, `${name} runs code that cannot be checked`);
            }
        } else if (ts.isPropertyAccessExpression(node)) {
            if (
                node.name.text === "bun" &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "versions"
            ) {
                report(node, "process.versions.bun");
            }
        } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
            const parent = node.parent;
            const used = ts.isPropertyAccessExpression(parent) ? parent.name.text : undefined;
            if (used === undefined || !IMPORT_META.has(used)) {
                report(node, `import.meta${used ? `.${used}` : ""}, which Node 22.12 lacks`);
            }
        } else if (ts.isStringLiteralLike(node)) {
            if (BUN_STRING.test(node.text)) report(node, 'a string naming "bun" or "bun:*"');
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const loads =
                callee.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(callee) && callee.text === "require");
            if (loads && !isStatic(node.arguments[0])) {
                report(node, "a dynamic import or require whose specifier cannot be checked");
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
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
        for (const file of sources(src, problems)) {
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
