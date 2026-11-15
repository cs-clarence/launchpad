import { createConfig } from "@launchpad/vite-config/app";

import packageJson from "./package.json" with { type: "json" };

export default createConfig({
    package: packageJson,

    overrides: {
        build: {
            lib: {
                entry: {
                    index: "src/index.ts",
                },
                formats: ["es"],
                fileName: (format, entryName) =>
                    `${entryName || "mcp"}.${format === "cjs" ? "cjs" : "mjs"}`,
                name: "Mcp",
            },
        },
    },
});
