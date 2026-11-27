import { createConfig } from "@launchpad-kit/vite-config/script";

import packageJson from "./package.json" with { type: "json" };

export default createConfig({
    package: packageJson,
    generateTypes: false,

    overrides: {
        build: {
            lib: {
                entry: {
                    cli: "src/index.ts",
                },
                formats: ["es"],
                fileName: (format, entryName) =>
                    `${entryName || "cli"}.${format === "cjs" ? "cjs" : "mjs"}`,
                name: "Cli",
            },
        },
    },
});
