import { defineConfig } from "oxfmt";

export default defineConfig({
    tabWidth: 4,
    ignorePatterns: [
        ".data/**",
        ".omni/**",
        ".agents/**",
        "docs/guidelines/**",
        "**/node_modules/**",
        "**/dist/**",
        "**/.output/**",
        "**/.tanstack/**",
        "**/routeTree.gen.ts",
        "bun.lock",
        "THIRD_PARTY_NOTICES.md",
        "omni/generators/**/templates/**",
    ],
    overrides: [{ files: ["*.yaml", "*.yml"], options: { tabWidth: 2 } }],
});
