import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Scalar's single-file browser bundle, published from this origin so no
// third-party script ever runs next to the session cookie. The version is pinned
// by the lockfile; only the one file is copied.
// Resolve by the package's exported entry, then walk up to its package.json: Node
// enforces the `exports` map, which does not expose `package.json` itself (Bun does
// not enforce it, so a direct `package.json` lookup only fails under Node, as in CI).
function packageManifest(name: string): { dir: string; version: string } {
    let dir = path.dirname(createRequire(import.meta.url).resolve(name));
    for (;;) {
        const file = path.join(dir, "package.json");
        if (existsSync(file)) {
            const manifest = JSON.parse(readFileSync(file, "utf8")) as {
                name?: string;
                version: string;
            };
            if (manifest.name === name) return { dir, version: manifest.version };
        }
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`Cannot find the package root of ${name}`);
        dir = parent;
    }
}
const scalar = packageManifest("@scalar/api-reference");
const scalarVersion = scalar.version;
// Versioned path: the file is cached for a year, so an upgrade must change its URL.
const scalarDir = path.resolve(import.meta.dirname, "node_modules/.cache/scalar");
mkdirSync(path.join(scalarDir, scalarVersion), { recursive: true });
copyFileSync(
    path.join(scalar.dir, "dist/browser/standalone.js"),
    path.join(scalarDir, scalarVersion, "standalone.js"),
);

export default defineConfig({
    define: { __SCALAR_VERSION__: JSON.stringify(scalarVersion) },
    // The server runs on Bun and imports `bun` (Bun SQL) from the workspace sources it
    // bundles. Node-based builds (CI) cannot resolve it, so it stays a run-time import.
    ssr: { external: ["bun"] },
    optimizeDeps: { rolldownOptions: { external: ["bun", /^bun:/] } },
    build: { rolldownOptions: { external: ["bun", /^bun:/] } },
    plugins: [
        tailwindcss(),
        tanstackStart(),
        nitro({
            preset: "bun",
            plugins: ["./src/server/startup-settings.ts"],
            publicAssets: [{ dir: scalarDir, baseURL: "/_scalar", maxAge: 60 * 60 * 24 * 365 }],
            // Pages carry invitation and reset tokens in their URL; never leak them
            // through the Referer header. The dashboard may not be framed
            // (clickjacking) or content-sniffed. No script-restricting CSP yet: the
            // API reference needs inline scripts.
            // Server functions take small JSON bodies; bound them like the API does.
            handlers: [
                {
                    route: "/_serverFn/**",
                    handler: "./src/server/limit-server-fn.ts",
                    middleware: true,
                },
            ],
            routeRules: {
                // Responses carry identity and organization data; a shared cache must never
                // serve one account's response to another.
                "/api/**": { headers: { "cache-control": "no-store" } },
                "/": { headers: { "cache-control": "no-store" } },
                "/orgs/**": { headers: { "cache-control": "no-store" } },
                "/_serverFn/**": { headers: { "cache-control": "no-store" } },
                "/**": {
                    headers: {
                        "referrer-policy": "no-referrer",
                        "x-content-type-options": "nosniff",
                        "x-frame-options": "DENY",
                        "content-security-policy": "frame-ancestors 'none'",
                        "permissions-policy": "camera=(), microphone=(), geolocation=()",
                    },
                },
            },
        }),
        react(),
    ],
});
