import { createConfig } from "@launchpad-kit/vite-config/script";

import packageJson from "./package.json" with { type: "json" };

export default createConfig({
    package: packageJson,
    generateTypes: false,

    overrides: {
        build: {
            lib: {
                entry: {
                    mcp: "src/index.ts",
                },
                formats: ["es"],
                fileName: (format, entryName) =>
                    `${entryName || "mcp"}.${format === "cjs" ? "cjs" : "mjs"}`,
                name: "Mcp",
            },
        },
    },
});
