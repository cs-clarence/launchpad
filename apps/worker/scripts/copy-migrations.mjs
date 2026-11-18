import { cpSync, rmSync } from "node:fs";
import path from "node:path";

// The migrations are read from a folder at run time (packages/database/src/migrate.ts looks
// for a `migrations` folder next to the bundle), so a built worker ships its own copy.
const root = path.resolve(import.meta.dirname, "..");
const from = path.resolve(root, "../../packages/database/src/migrations");
const to = path.join(root, "dist/migrations");
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
