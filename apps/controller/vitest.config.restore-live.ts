import { defineConfig } from "vitest/config";

// Explicit opt-in only. Never included by test, test:integration, or CI.
export default defineConfig({
    test: {
        include: ["src/admin/live/**/*.live.ts"],
        testTimeout: 12 * 60_000,
        hookTimeout: 60_000,
    },
    resolve: { conditions: ["development"] },
});
