import { defineConfig } from "vitest/config";

export default defineConfig({
    test: { include: ["src/**/*.spec.ts"], exclude: ["src/**/__tests__/**"] },
    resolve: { conditions: ["development"] },
});
