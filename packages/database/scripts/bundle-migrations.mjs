// Bundles every migration into a self-contained file in the folder named on the command line
// (`bun bundle-migrations.mjs <outDir>`), so a built artifact can run `migrate` without the
// repository: the migrations import `kysely` and the auth schema, which are inlined. File names
// keep their `<date>_<sequence>_<what>` stem, which is what the migration table records.
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const out = process.argv[2];
if (!out) throw new Error("Usage: bun bundle-migrations.mjs <outDir>");
const source = path.resolve(import.meta.dirname, "../src/migrations");
const target = path.resolve(process.cwd(), out);
rmSync(target, { recursive: true, force: true });
// The same naming rule `migrate` enforces: a file that does not match is an error here too, never
// quietly left out of the artifact.
const files = readdirSync(source).filter((name) => !name.endsWith(".d.ts"));
for (const name of files) {
    if (!/^\d{8}_\d{3}_.+\.ts$/.test(name)) {
        throw new Error(`Unexpected file in the migrations folder: ${name}`);
    }
}
if (files.length === 0) throw new Error(`No migrations found in ${source}.`);
for (const file of files.sort()) {
    const result = await Bun.build({
        entrypoints: [path.join(source, file)],
        outdir: target,
        naming: file.replace(/\.ts$/, ".mjs"),
        target: "bun",
        format: "esm",
    });
    if (!result.success) {
        throw new Error(`Bundling ${file} failed:\n${result.logs.join("\n")}`);
    }
}
