// Fails when a source imports the untyped `commander`: the repo uses `@commander-js/extra-typings`,
// which re-exports Command and CommanderError with typed options and arguments. `commander` stays
// declared in manifests as extra-typings' peer dependency but is never imported.
// Run by `omni run check:imports`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

export const ROOTS = ["apps", "packages", "tooling"];
const SKIPPED = new Set(["node_modules", "dist", ".data", "build", ".output", ".turbo"]);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;

export function scan(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const report = (node: ts.Node, specifier: ts.Node | undefined) => {
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text === "commander") {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            found.push(
                `${file}:${line + 1} imports "commander"; use "@commander-js/extra-typings"`,
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
        } else if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require"))
        ) {
            report(node, node.arguments[0]);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

function walk(dir: string, out: string[]) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIPPED.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (entry.isFile() && SOURCE.test(entry.name)) out.push(full);
    }
}

export function checkCommanderImports(root: string): string[] {
    const files: string[] = [];
    for (const dir of ROOTS)
        if (existsSync(path.join(root, dir))) walk(path.join(root, dir), files);
    return files
        .sort()
        .flatMap((file) => scan(path.relative(root, file), readFileSync(file, "utf8")));
}

if (import.meta.main) {
    const problems = checkCommanderImports(path.resolve(import.meta.dirname, ".."));
    if (problems.length > 0) {
        console.error(problems.join("\n"));
        process.exit(1);
    }
    console.log('No source imports "commander"; all use @commander-js/extra-typings.');
}
