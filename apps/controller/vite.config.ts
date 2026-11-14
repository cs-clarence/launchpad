import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

// Scalar's single-file browser bundle, published from this origin so no
// third-party script ever runs next to the session cookie. The version is pinned
// by the lockfile; only the one file is copied.
const scalarPackage = createRequire(import.meta.url).resolve("@scalar/api-reference/package.json");
const scalarVersion = (JSON.parse(readFileSync(scalarPackage, "utf8")) as { version: string })
    .version;
// Versioned path: the file is cached for a year, so an upgrade must change its URL.
const scalarDir = path.resolve(import.meta.dirname, "node_modules/.cache/scalar");
mkdirSync(path.join(scalarDir, scalarVersion), { recursive: true });
copyFileSync(
    path.join(path.dirname(scalarPackage), "dist/browser/standalone.js"),
    path.join(scalarDir, scalarVersion, "standalone.js"),
);

export default defineConfig({
    define: { __SCALAR_VERSION__: JSON.stringify(scalarVersion) },
    plugins: [
        tailwindcss(),
        tanstackStart(),
        nitro({
            preset: "bun",
            publicAssets: [{ dir: scalarDir, baseURL: "/_scalar", maxAge: 60 * 60 * 24 * 365 }],
            // Pages carry invitation and reset tokens in their URL; never leak them
            // through the Referer header. The dashboard may not be framed
            // (clickjacking) or content-sniffed. No script-restricting CSP yet: the
            // API reference needs inline scripts.
            routeRules: {
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
