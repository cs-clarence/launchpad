// Fails when a source imports the untyped `commander`: the repo uses `@commander-js/extra-typings`,
// which re-exports Command and CommanderError with typed options and arguments. `commander` stays
// declared in manifests as extra-typings' peer dependency but is never imported.
// Run by `omni run check:imports`.
//
// The rule: a module specifier that is exactly `commander` or starts with `commander/` (a subpath
// such as `commander/esm.mjs`) is reported in an import or export declaration, an `import()` type,
// `import x = require()`, a dynamic `import()`, and a call to `require`, `module.require`,
// `require.resolve` or a `createRequire(...)` result bound to a variable. Other ways of building
// a specifier at run time are not detectable; the typed wrapper is what lets the compiler agree.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";
import { SOURCE, scriptKind, syntaxProblems, walkSources } from "./ts-scan";

export const ROOTS = ["apps", "packages", "tooling"];
const SKIPPED = new Set(["node_modules", "dist", ".data", "build", ".output", ".turbo"]);

const isCommander = (text: string) => text === "commander" || text.startsWith("commander/");

export function scan(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
    const found = syntaxProblems(source, file);
    const requirers = new Set(["require"]);
    const isCreateRequire = (node: ts.Expression) =>
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "createRequire") ||
            (ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "createRequire"));
    const collect = (node: ts.Node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            isCreateRequire(node.initializer)
        ) {
            requirers.add(node.name.text);
        }
        ts.forEachChild(node, collect);
    };
    collect(source);

    const isRequirer = (callee: ts.Expression) =>
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && requirers.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
            ((ts.isIdentifier(callee.expression) &&
                callee.expression.text === "module" &&
                callee.name.text === "require") ||
                (ts.isIdentifier(callee.expression) &&
                    requirers.has(callee.expression.text) &&
                    callee.name.text === "resolve")));
    const report = (node: ts.Node, specifier: ts.Node | undefined) => {
        if (specifier && ts.isStringLiteralLike(specifier) && isCommander(specifier.text)) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            found.push(
                `${file}:${line + 1} imports "${specifier.text}"; use "@commander-js/extra-typings"`,
            );
        }
    };
    const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            report(node, node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node)) {
            if (ts.isExternalModuleReference(node.moduleReference))
                report(node, node.moduleReference.expression);
        } else if (ts.isImportTypeNode(node)) {
            if (ts.isLiteralTypeNode(node.argument)) report(node, node.argument.literal);
        } else if (ts.isCallExpression(node) && isRequirer(node.expression)) {
            report(node, node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

// Tracked and untracked-but-not-ignored sources under the roots when `root` is a git checkout, so
// a source directory that happens to be named `build` is still scanned; null outside a checkout.
function gitSources(root: string): string[] | null {
    const run = Bun.spawnSync(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...ROOTS],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
    });
    if (run.exitCode !== 0 || top.exitCode !== 0) return null;
    if (path.resolve(top.stdout.toString().trim()) !== path.resolve(root)) return null;
    return run.stdout
        .toString()
        .split("\0")
        .filter((file) => SOURCE.test(file));
}

export interface Result {
    problems: string[];
    scanned: number;
}

export function checkCommanderImports(root: string): Result {
    const problems: string[] = [];
    let files = gitSources(root)?.map((file) => path.join(root, file));
    if (files) {
        files = files.filter((file) => {
            try {
                return statSync(file).isFile();
            } catch {
                problems.push(`${file}: cannot be read (a broken link?), so it is not trusted`);
                return false;
            }
        });
    } else {
        files = [];
        for (const dir of ROOTS) {
            try {
                statSync(path.join(root, dir));
            } catch {
                continue;
            }
            files.push(...walkSources(path.join(root, dir), problems, (n) => SKIPPED.has(n)));
        }
    }
    files.sort();
    for (const file of files) {
        problems.push(...scan(path.relative(root, file), readFileSync(file, "utf8")));
    }
    if (files.length === 0)
        problems.push("no source file was scanned, so the check is not trusted");
    return { problems, scanned: files.length };
}

if (import.meta.main) {
    const { problems, scanned } = checkCommanderImports(path.resolve(import.meta.dirname, ".."));
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log(
        `No source imports "commander" (${scanned} scanned); all use @commander-js/extra-typings.`,
    );
}
