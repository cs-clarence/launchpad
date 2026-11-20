import { defineConfig } from "vitest/config";

// Needs a disposable PostgreSQL server (TEST_DATABASE_URL) and a prior `bun run build`.
export default defineConfig({
    test: {
        include: ["src/**/__tests__/**/*.spec.ts"],
        testTimeout: 60000,
        hookTimeout: 120000,
    },
    resolve: { conditions: ["development"] },
});
