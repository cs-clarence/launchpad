// Helpers shared by the scans that walk the TypeScript syntax tree of the repository's sources
// (runtime-agnostic.ts, commander-imports.ts): script kind by extension, fail-closed parse
// diagnostics, and a directory walk that follows links, guards cycles and distrusts broken links.
import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

export const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

export const scriptKind = (file: string) =>
    file.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : file.endsWith(".jsx")
          ? ts.ScriptKind.JSX
          : /\.[cm]?js$/.test(file)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;

// "file:line: message" for each syntax error; throws when the compiler no longer exposes them,
// so a TypeScript upgrade cannot silently turn the fail-closed rule off.
export function syntaxProblems(sourceFile: ts.SourceFile, file: string): string[] {
    const syntax = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] })
        .parseDiagnostics;
    if (!Array.isArray(syntax))
        throw new Error("the TypeScript parser exposes no parseDiagnostics");
    return syntax.map((diagnostic) => {
        const line = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
        return `${file}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}; the file cannot be scanned, so it is not trusted`;
    });
}

export function* walkSources(
    dir: string,
    problems: string[],
    skipDir: (name: string) => boolean,
    seen = new Set<string>(),
): Generator<string> {
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
            if (!skipDir(entry.name)) yield* walkSources(file, problems, skipDir, seen);
        } else if (SOURCE.test(entry.name)) yield file;
    }
}
